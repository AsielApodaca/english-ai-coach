/**
 * Multi-layer text-to-speech engine.
 *
 * Engine priority (decided on the frontend, server picks piper vs edge-tts):
 *   1. Server TTS — `/api/tts` serves Piper (local neural) or edge-tts
 *                   (online fallback) as chosen by the server.
 *   2. speechSynthesis — browser Web Speech API (last resort, always available).
 *
 * Feature 114 (prosody): a STRING line is split into clauses client-side
 * (`splitForTts`) and sent as `segments[]` + `pausesMs[]`, so the server can
 * glue them into ONE audio file with human pauses. An ARRAY of tokens (word
 * click / selection, feature 113) goes through as-is with the legacy pause
 * contract (no measured pauses). When the engine is `edge-tts` (MP3) the
 * blob is level-normalized on the client via `speech/level.js`.
 *
 * The public API (`speak`, `stop`, `setVolume`, `supported`, `refresh`,
 * `allVoices`, `setHealth`) — the previous surface plus `setVolume` — keeps
 * existing callers (`autoplayFragment`, `speakCoachFeedback`, chat read-aloud)
 * working without modification.
 */
import { splitForTts } from "./prosody.js";
import { tryNormalizeElement, setElementVolume, releaseElement } from "./level.js";

export class BrowserTTS {
  /** @type {SpeechSynthesisVoice[]} */
  voices = [];

  /** @type {HTMLAudioElement|null} Server audio element currently playing. */
  _audio = null;

  /** @type {{resolve: Function, url: string}|null} pending play promise for `stop()`. */
  _pending = null;

  /** @type {"piper"|"edge-tts"|null} cached TTS engine from /api/health. */
  _serverEngine = null;

  /**
   * Generation counter, bumped by `stop()`. Every `speak()` captures it and
   * re-checks it after each `await`: a mismatch means the caller cancelled the
   * read, so the call must abort quietly instead of falling through to the
   * next engine (which is what used to restart the line after leaving a
   * practice session).
   * @type {number}
   */
  _gen = 0;

  /** Id of the newest `speak()` call; superseded calls must not keep playing. */
  _callId = 0;

  /** @type {SpeechSynthesisUtterance|null} utterance currently being spoken. */
  _utt = null;

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
   *
   * `text` may be:
   *   - a STRING line → split into clauses client-side (feature 114) and sent
   *     as `segments[]` + `pausesMs[]`, so `/api/tts` returns ONE file with
   *     measured human pauses (comma 220 ms, sentence 400 ms, handover 650 ms);
   *   - an ARRAY of tokens (word click / selection) → explicit segments with
   *     the legacy pause contract (no measured pauses), one single request.
   *
   * Cancellation: `stop()` (or a newer `speak()`) invalidates this call. When
   * that happens the promise resolves `false` and the browser fallback is
   * skipped — otherwise a cancelled server read would be re-spoken by
   * `speechSynthesis` outside the session that asked for it.
   *
   * @param {string|string[]} text
   * @param {{rate?: number, pitch?: number, voiceURI?: string, piperVoice?: string, pauseAfterMs?: number, volume?: number}} [opts]
   *   `piperVoice` is the chosen `engcoach.voice` id (null/undefined = keep
   *   the default chain). `pauseAfterMs` only applies to explicit arrays
   *   (strings get their pauses from the clause splitter).
   * @returns {Promise<boolean>} true on success, false on error/cancel/fallback failure.
   */
  async speak(text, { rate = 0.95, pitch = 1, voiceURI = null, piperVoice = null, pauseAfterMs = 0, volume = 1 } = {}) {
    const texts = Array.isArray(text) ? text : [text];
    const id = ++this._callId;
    const gen = this._gen;
    /** True when `stop()` ran or a newer `speak()` took over mid-flight. */
    const cancelled = () => id !== this._callId || gen !== this._gen;

    // Feature 114: strings are split into clauses with measured pauses;
    // token arrays keep the legacy contract (no internal pauses).
    const { segments, pausesMs } = Array.isArray(text)
      ? { segments: texts, pausesMs: /** @type {number[]|null} */ (null) }
      : splitForTts(text);

    // --- Layer 1: server TTS (Piper local → edge-tts online) ---
    if (this._serverEngine) {
      const ok = await this._speakServer(segments, { pausesMs, rate, piperVoice, pauseAfterMs, volume, cancelled });
      // Cancelled reads must NOT fall through: layer 2 would replay the line.
      if (cancelled()) return false;
      if (ok) return true;
      // Server TTS failed — fall through to browser.
    }

    // --- Layer 2: speechSynthesis (browser fallback) ---
    if (cancelled()) return false;
    return this._speakBrowser(texts.join(" "), { rate, pitch, voiceURI, volume, cancelled });
  }

  // -----------------------------------------------------------------------
  // Server TTS layer (Piper / edge-tts)
  // -----------------------------------------------------------------------

  /**
   * Fetch a WAV/MP3 from the server and play it through an `<audio>` element.
   * The server resolves Piper vs edge-tts; 503 means "no server engine".
   *
   * Params: `segments[]` always; `pausesMs[]` (one per segment, feature 114)
   * when the caller passed a split line; otherwise the legacy `pauseAfterMs`
   * between tokens. `voice` goes only to Piper.
   *
   * Edge MP3 level: the blob is normalized client-side (`speech/level.js`)
   * before playback; the Piper WAV is already normalized server-side.
   *
   * @param {string[]} segments
   * @param {{pausesMs?: number[]|null, rate?: number, piperVoice?: string|null, pauseAfterMs?: number, volume?: number, cancelled?: () => boolean}} [opts]
   * @returns {Promise<boolean>}
   */
  async _speakServer(segments, { pausesMs = null, rate = 0.95, piperVoice = null, pauseAfterMs = 0, volume = 1, cancelled = () => false } = {}) {
    try {
      const params = new URLSearchParams();
      for (const t of segments) params.append("segments", t);
      if (pausesMs && pausesMs.length === segments.length) {
        for (const p of pausesMs) params.append("pausesMs", String(p));
      } else if (pauseAfterMs > 0) {
        params.set("pauseAfterMs", String(pauseAfterMs));
      }
      if (rate !== 1) params.set("rate", String(rate));
      // The `voice` param is a Piper voice; only send it when Piper is active.
      if (this._serverEngine === "piper" && piperVoice) params.set("voice", piperVoice);

      const res = await fetch(`/api/tts?${params.toString()}`);
      if (!res.ok) return false;

      const blob = await res.blob();
      // `stop()` during the fetch is a no-op for `_audio`/`_pending`, so the
      // cancellation has to be re-checked here or the audio would start
      // playing after the caller already left.
      if (cancelled()) return false;
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);

      // Edge MP3: normalize the level on the client (feature 114). Piper WAV
      // needs nothing — the server already normalized it. Any failure leaves
      // `ctl` null and playback falls back to `audio.volume`.
      let ctl = null;
      if (this._serverEngine === "edge-tts") {
        ctl = await tryNormalizeElement(audio, blob);
        if (cancelled()) {
          releaseElement(audio);
          URL.revokeObjectURL(url);
          return false;
        }
      }
      if (ctl) ctl.setVolume(volume);
      else audio.volume = Math.max(0, Math.min(1, volume));

      return await new Promise((resolve) => {
        this._stopCurrentAudio(); // cancel any previous audio (same generation)

        this._audio = audio;
        // Speed is applied server-side (Piper length_scale / edge --rate),
        // so playback stays natural at 1.0 (no pitch distortion).
        audio.playbackRate = 1;
        this._pending = { resolve, url };

        const finish = (ok) => {
          if (this._pending?.resolve === resolve) {
            this._audio = null;
            this._pending = null;
          }
          releaseElement(audio); // tear down the edge gain graph, if any
          resolve(ok);
        };

        audio.onended = () => {
          URL.revokeObjectURL(url);
          finish(true);
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          finish(false);
        };

        audio.play().catch(() => {
          URL.revokeObjectURL(url);
          finish(false);
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
   * @param {{cancelled?: () => boolean}} [opts]
   * @returns {Promise<boolean>}
   */
  async _speakBrowser(text, { rate = 0.95, pitch = 1, voiceURI = null, volume = 1, cancelled = () => false } = {}) {
    if (!this.supported()) return false;
    // A cancelled read must not queue a new utterance: `speechSynthesis` is a
    // global queue, so it would keep talking after the session is gone.
    if (cancelled()) return false;
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
      // Keep the reference so `setVolume()` can adjust a read already running.
      this._utt = utt;
      const done = (ok) => {
        if (this._utt === utt) this._utt = null;
        resolve(ok);
      };
      utt.onend = () => done(true);
      utt.onerror = () => done(false);
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utt);
    });
  }

  /**
   * Apply a volume (0–1) to whatever the engine is playing right now, so the
   * settings slider can move a read that has already started.
   *
   * Live adjustment is native to `HTMLAudioElement` (server TTS: Piper /
   * edge-tts — the default path). For `speechSynthesis` the value is written
   * onto the live utterance too: engines that sample the property during
   * playback honour it, Chrome samples it when `speak()` starts and only
   * applies the new volume on the next utterance. Restarting the utterance
   * would be the only way to change it mid-line, and that would replay from
   * the beginning.
   *
   * @param {number} volume - 0–1
   */
  setVolume(volume) {
    const v = Number(volume);
    if (!Number.isFinite(v)) return;
    const vol = Math.max(0, Math.min(1, v));
    if (this._audio) setElementVolume(this._audio, vol);
    if (this._utt) this._utt.volume = vol;
  }

  // -----------------------------------------------------------------------
  // stop()
  // -----------------------------------------------------------------------

  /**
   * Cancel whichever engine is currently speaking and invalidate every read
   * in flight: any `speak()` still awaiting a fetch or a playback promise
   * resolves `false` without starting the next engine.
   */
  stop() {
    this._gen++;
    this._stopCurrentAudio();
    // Stop browser speechSynthesis.
    if (this.supported()) window.speechSynthesis.cancel();
    this._utt = null;
  }

  /**
   * Pause the current server audio element and settle its pending promise,
   * WITHOUT bumping `_gen` (used between two reads of the same generation).
   */
  _stopCurrentAudio() {
    if (this._audio) {
      this._audio.pause();
      this._audio.currentTime = 0;
      releaseElement(this._audio); // edge gain graph, if any
      this._audio = null;
    }
    if (this._pending) {
      const { resolve, url } = this._pending;
      this._pending = null;
      URL.revokeObjectURL(url);
      resolve(false);
    }
  }
}
