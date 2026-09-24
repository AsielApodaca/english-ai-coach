/** Records microphone audio and exports it as a WAV blob (for local whisper). */
export class WaveRecorder {
  constructor({ deviceId } = {}) {
    this.deviceId = deviceId || "";
    this.ctx = null;
    this.stream = null;
    this.recording = false;
    this.samples = [];
    this.onLevel = null;
    /** In-flight prewarm() promise, so concurrent callers wait on the same one. */
    this._prewarming = null;
    this.lastDurationMs = 0;
    this.lastSampleCount = 0;
  }

  /**
   * Acquire the mic stream ahead of time.
   *
   * getUserMedia takes ~200-500ms; fetching it before the user presses the orb
   * means push-to-talk capture starts instantly. The WebAudio graph is NOT
   * built here on purpose: an AudioContext created outside a user gesture is
   * created "suspended" by Chrome's autoplay policy, and resuming it later is
   * finicky. Instead the graph is built in start(), inside the press gesture,
   * where a fresh context is guaranteed to start "running" — same pattern used
   * by the (working) config sound test.
   *
   * The device honours the saved `engcoach.mic` choice: a plain
   * `{ audio: true }` request falls back to the OS default input, which is
   * NOT necessarily the mic the user picked in Settings.
   *
   * Idempotent: safe to call multiple times. Fulfils with the same promise
   * when already running.
   */
  async prewarm() {
    if (this.stream) return true;
    if (this._prewarming) return this._prewarming;
    this._prewarming = (async () => {
      const constraints = this.deviceId
        ? { audio: { deviceId: { exact: this.deviceId } } }
        : { audio: true };
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      return true;
    })().finally(() => {
      this._prewarming = null;
    });
    return this._prewarming;
  }

  /**
   * Build the capture graph NOW and start recording. Must run inside a user
   * gesture (the orb press): a context created here starts "running", which
   * guarantees onaudioprocess fires and real samples reach the mic.
   */
  async start() {
    if (this.recording) return true;
    await this.prewarm();
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.buildGraph();
    this.recording = true;
    return true;
  }

  /** Create a fresh AudioContext + capture graph from the prewarmed stream. */
  buildGraph() {
    const ctx = new AudioContext();
    this.sampleRate = ctx.sampleRate;
    const source = ctx.createMediaStreamSource(this.stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    // Zero-gain tail into the destination: keeps the processor active (so
    // onaudioprocess fires) without routing the mic back through the speakers.
    const silentOut = ctx.createGain();
    silentOut.gain.value = 0;
    processor.onaudioprocess = (e) => {
      const ch = e.inputBuffer.getChannelData(0);
      if (this.recording) {
        this.samples.push(new Float32Array(ch));
        if (this.onLevel) this.onLevel(rmsDb(ch));
      }
    };
    source.connect(processor);
    processor.connect(silentOut);
    silentOut.connect(ctx.destination);
    this.ctx = ctx;
    return ctx;
  }

  /** Stop and produce a WAV Blob of everything recorded. */
  stop() {
    this.recording = false;
    const combined = new Float32Array(this.samples.reduce((n, a) => n + a.length, 0));
    let off = 0;
    for (const a of this.samples) {
      combined.set(a, off);
      off += a.length;
    }
    this.lastSampleCount = combined.length;
    this.samples = [];
    /** Recorded clip length in milliseconds (0 when nothing was captured). */
    this.lastDurationMs = this.sampleRate ? Math.round((combined.length / this.sampleRate) * 1000) : 0;
    this.teardown();
    return encodeWAV(combined, this.sampleRate);
  }

  cancel() {
    this.samples = [];
    this.recording = false;
    this.teardown();
  }

  teardown() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}

/** RMS level of an audio channel in dB (0 dBFS peak, -Infinity on silence). */
function rmsDb(ch) {
  let sum = 0;
  for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
  const rms = Math.sqrt(sum / ch.length);
  return rms === 0 ? -Infinity : 20 * Math.log10(rms);
}

export function encodeWAV(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([view], { type: "audio/wav" });
}