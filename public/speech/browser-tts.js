/**
 * Multi-layer text-to-speech engine.
 *
 * Engine priority (decided on the frontend, server picks piper vs edge-tts):
 *   1. Server TTS — `/api/tts` serves Piper (local neural) or edge-tts
 *                   (online fallback) as chosen by the server.
 *   2. speechSynthesis — browser Web Speech API (last resort, always available).
 *
 * The public API (`speak`, `stop`, `supported`, `refresh`, `allVoices`,
 * `setHealth`) is unchanged so existing callers (`autoplayFragment`,
 * `speakCoachFeedback`, chat read-aloud) keep working without modification.
 */
export class BrowserTTS {
  /** @type {SpeechSynthesisVoice[]} */
  voices = [];

  /** @type {HTMLAudioElement|null} Server audio element currently playing. */
  _audio = null;

  /** @type {{resolve: Function, url: string}|null} pending play promise for `stop()`. */
  _pending = null;

  /** @type {"piper"|"edge-tts"|null} cached TTS engine from /api/health. */
  _serverEngine = null;

  constructor() {
    if ("speechSynthesis" in window) {
      speechSynthesis.onvoiceschanged = () => this.refresh();
    }
  }

  supported() {
    return "speechSynthesis" in window;
  }

  refresh() {
    this.voices = window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("en"));
  }

  allVoices() {
    this.refresh();
    return this.voices;
  }

  /**
   * Cache the server TTS engine so `speak()` can decide without an extra
   * network round-trip on every call.
   * @param {{tts?: {engine: "piper"|"edge-tts"|null}}} health
   */
  setHealth(health) {
    const engine = health?.tts?.engine;
    this._serverEngine = engine === "piper" || engine === "edge-tts" ? engine : null;
  }

  // -----------------------------------------------------------------------
  // speak()
  // -----------------------------------------------------------------------

  /**
   * Speak text using the best available engine.
   *
   * Priority: server TTS (Piper or edge-tts) → speechSynthesis (browser).
   * `text` may be a single string or an array of segments synthesized in one
   * request with measured silence between them.
   *
   * @param {string|string[]} text
   * @param {{rate?: number, pitch?: number, voiceURI?: string, piperVoice?: string, pauseAfterMs?: number, volume?: number}} [opts]
   * @returns {Promise<boolean>} true on success, false on error/fallback failure.
   */
  async speak(text, { rate = 0.95, pitch = 1, voiceURI = null, piperVoice = null, pauseAfterMs = 0, volume = 1 } = {}) {
    const texts = Array.isArray(text) ? text : [text];

    // --- Layer 1: server TTS (Piper local → edge-tts online) ---
    if (this._serverEngine) {
      const ok = await this._speakServer(texts, { rate, piperVoice, pauseAfterMs, volume });
      if (ok) return true;
      // Server TTS failed — fall through to browser.
    }

    // --- Layer 2: speechSynthesis (browser fallback) ---
    return this._speakBrowser(texts.join(" "), { rate, pitch, voiceURI, volume });
  }

  // -----------------------------------------------------------------------
  // Server TTS layer (Piper / edge-tts)
  // -----------------------------------------------------------------------

  /**
   * Fetch a WAV/MP3 from the server and play it through an `<audio>` element.
   * The server resolves Piper vs edge-tts; 503 means "no server engine".
   * @param {string[]} texts
   * @returns {Promise<boolean>}
   */
  async _speakServer(texts, { rate = 0.95, piperVoice = null, pauseAfterMs = 0, volume = 1 } = {}) {
    try {
      const params = new URLSearchParams();
      for (const t of texts) params.append("segments", t);
      if (pauseAfterMs > 0) params.set("pauseAfterMs", String(pauseAfterMs));
      if (rate !== 1) params.set("rate", String(rate));
      // The `voice` param is a Piper voice; only send it when Piper is active.
      if (this._serverEngine === "piper" && piperVoice) params.set("voice", piperVoice);

      const res = await fetch(`/api/tts?${params.toString()}`);
      if (!res.ok) return false;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      return await new Promise((resolve) => {
        this.stop(); // cancel any previous audio

        const audio = new Audio(url);
        this._audio = audio;
        // Speed is applied server-side (Piper length_scale / edge --rate),
        // so playback stays natural at 1.0 (no pitch distortion).
        audio.playbackRate = 1;
        audio.volume = Math.max(0, Math.min(1, volume));
        this._pending = { resolve, url };

        audio.onended = () => {
          URL.revokeObjectURL(url);
          this._audio = null;
          this._pending = null;
          resolve(true);
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          this._audio = null;
          this._pending = null;
          resolve(false);
        };

        audio.play().catch(() => {
          URL.revokeObjectURL(url);
          this._audio = null;
          this._pending = null;
          resolve(false);
        });
      });
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Browser speechSynthesis layer
  // -----------------------------------------------------------------------

  /**
   * Use the browser's Web Speech API.
   * @returns {Promise<boolean>}
   */
  async _speakBrowser(text, { rate = 0.95, pitch = 1, voiceURI = null, volume = 1 } = {}) {
    if (!this.supported()) return false;
    if (!this.voices.length) this.refresh();

    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = rate;
    utt.pitch = pitch;
    utt.volume = Math.max(0, Math.min(1, volume));
    utt.lang = "en-US";
    if (voiceURI) {
      const v = this.voices.find((x) => x.voiceURI === voiceURI);
      if (v) utt.voice = v;
    }
    return new Promise((resolve) => {
      utt.onend = () => resolve(true);
      utt.onerror = () => resolve(false);
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utt);
    });
  }

  // -----------------------------------------------------------------------
  // stop()
  // -----------------------------------------------------------------------

  /** Cancel whichever engine is currently speaking. */
  stop() {
    // Stop server audio element and resolve its pending promise.
    if (this._audio) {
      this._audio.pause();
      this._audio.currentTime = 0;
      this._audio = null;
    }
    if (this._pending) {
      this._pending.resolve(false);
      URL.revokeObjectURL(this._pending.url);
      this._pending = null;
    }
    // Stop browser speechSynthesis.
    if (this.supported()) window.speechSynthesis.cancel();
  }
}
