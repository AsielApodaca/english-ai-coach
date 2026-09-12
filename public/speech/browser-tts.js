/** Text-to-speech via the browser SpeechSynthesis API (English voices). */
export class BrowserTTS {
  /** @type {SpeechSynthesisVoice[]} */
  voices = [];

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

  /** Speak text, resolving once finished (true) or on error (false). */
  async speak(text, { rate = 0.95, pitch = 1, voiceURI = null } = {}) {
    if (!this.supported()) return false;
    if (!this.voices.length) this.refresh();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = rate;
    utt.pitch = pitch;
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

  stop() {
    if (this.supported()) window.speechSynthesis.cancel();
  }
}