/** Speech-to-text via the Chrome Web Speech API (webkitSpeechRecognition). */
export class BrowserSTT {
  /** @type {{onInterim?: (t: string)=>void, onFinal: (t: string)=>void, onEnd?: ()=>void, onError?: (e:any)=>void}} */
  handlers;

  constructor(handlers) {
    this.handlers = handlers;
    this.rec = null;
    this.finalText = "";
  }

  isSupported() {
    return "webkitSpeechRecognition" in window || "SpeechRecognition" in window;
  }

  start({ lang = "en-US", continuous = true } = {}) {
    if (!this.isSupported()) return false;
    if (this.rec) return true;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = lang;
    rec.continuous = continuous;
    rec.interimResults = true;
    this.finalText = "";

    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) this.finalText += res[0].transcript + " ";
        else interim += res[0].transcript;
      }
      this.handlers.onInterim?.(this.finalText + " " + interim);
    };
    rec.onerror = (e) => {
      this.handlers.onError?.(e);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.handlers.onEnd?.();
      }
    };
    rec.onend = () => {
      this.rec = null;
      this.handlers.onEnd?.();
    };
    this.rec = rec;
    rec.start();
    return true;
  }

  stop() {
    if (this.rec) {
      try {
        this.rec.stop();
      } catch {
        this.rec = null;
      }
    }
  }

  result() {
    return this.finalText.trim();
  }

  abort() {
    if (this.rec) {
      try {
        this.rec.abort();
      } catch {
        /* noop */
      }
      this.rec = null;
      this.handlers.onEnd?.();
    }
  }
}