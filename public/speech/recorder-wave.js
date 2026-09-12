/** Records microphone audio and exports it as a WAV blob (for local whisper). */
export class WaveRecorder {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.recording = false;
    this.samples = [];
  }

  async start() {
    if (this.recording) return true;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.ctx = new AudioContext();
    this.sampleRate = this.ctx.sampleRate;
    const source = this.ctx.createMediaStreamSource(this.stream);
    const processor = this.ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      if (this.recording) {
        const ch = e.inputBuffer.getChannelData(0);
        this.samples.push(new Float32Array(ch));
      }
    };
    source.connect(processor);
    processor.connect(this.ctx.destination);
    this.recording = true;
    return true;
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
    this.samples = [];
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