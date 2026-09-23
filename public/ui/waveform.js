/**
 * Canvas waveform visualizer (32 bars) driven by Web Audio API.
 *
 * - Idle: a quiet sine oscillator feeds the analyser; bars breathe with a
 *   slow pulse in slate `#334155`.
 * - Mic active: `getUserMedia` audio is routed through the analyser and bars
 *   are colored cyan → lime → amber by level.
 *
 * In feature 101 the orb is a stub, so `store.micActive` stays false and only
 * the idle path runs; the mic path is wired for feature 105.
 */

const BAR_COUNT = 32;
const BAR_RADIUS = 2;
const IDLE_COLOR = "#334155";
const ACTIVE_COLORS = ["#06b6d4", "#10b981", "#f59e0b"];

/**
 * Start the waveform visualizer on a canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {import("./store.js").ShellState} store - shell store singleton
 * @param {(level: number) => void} [onLevel] - called each frame with a 0..1 level
 * @returns {{ destroy: () => void }}
 */
export function createWaveform(canvas, store, onLevel) {
  const ctx = canvas.getContext("2d");
  const audioCtx = new AudioContext();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 64; // 32 usable bins
  const freqData = new Uint8Array(analyser.frequencyBinCount);

  // Fake idle signal: a quiet sine oscillator feeding the analyser only
  // (never routed to the speakers).
  const idleOsc = audioCtx.createOscillator();
  const idleGain = audioCtx.createGain();
  idleOsc.type = "sine";
  idleOsc.frequency.value = 110;
  idleGain.gain.value = 0.12;
  idleOsc.connect(idleGain);
  idleGain.connect(analyser);
  idleOsc.start();

  let micStream = null;
  let micSource = null;
  let raf = 0;

  // Browsers start AudioContext suspended; resume on the first user gesture.
  const resumeOnce = () => {
    if (audioCtx.state === "suspended") audioCtx.resume();
    window.removeEventListener("pointerdown", resumeOnce);
  };
  window.addEventListener("pointerdown", resumeOnce);

  /** Route the analyser input between the idle oscillator and the mic. */
  function setMicActive(active) {
    if (active && !micStream) {
      navigator.mediaDevices
        ?.getUserMedia({ audio: true })
        .then((stream) => {
          micStream = stream;
          micSource = audioCtx.createMediaStreamSource(stream);
          micSource.connect(analyser);
          idleGain.disconnect(analyser);
        })
        .catch(() => {
          /* mic denied — stay on the idle signal */
        });
    } else if (!active && micStream) {
      idleGain.connect(analyser);
      micSource?.disconnect(analyser);
      micSource = null;
      for (const track of micStream.getTracks()) track.stop();
      micStream = null;
    }
  }

  /** Match the canvas backing store to its CSS size (devicePixelRatio-aware). */
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Pick the active color for a normalized level. */
  function colorForLevel(v) {
    if (v < 0.35) return ACTIVE_COLORS[0]; // cyan
    if (v < 0.7) return ACTIVE_COLORS[1]; // lime
    return ACTIVE_COLORS[2]; // amber
  }

  function draw() {
    const w = canvas.width / (window.devicePixelRatio || 1);
    const h = canvas.height / (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, w, h);

    const t = performance.now() / 1000;
    const pulse = 0.55 + 0.45 * Math.sin(t * 1.4); // slow breathing in idle
    const micActive = store.state.micActive;

    if (audioCtx.state === "running") {
      analyser.getByteFrequencyData(freqData);
    } else {
      // Context suspended (no gesture yet): procedural idle pulse.
      for (let i = 0; i < freqData.length; i++) {
        freqData[i] = 40 + 30 * Math.sin(t * 2 + i * 0.6);
      }
    }

    const barW = w / BAR_COUNT;
    const gap = 2;
    let level = 0;
    for (let i = 0; i < BAR_COUNT; i++) {
      const v = freqData[i] / 255;
      const barH = Math.max(3, v * h * 0.92 * (micActive ? 1 : pulse));
      level += barH / h;
      const x = i * barW + gap / 2;
      const y = (h - barH) / 2;
      ctx.fillStyle = micActive ? colorForLevel(v) : IDLE_COLOR;
      ctx.beginPath();
      ctx.roundRect(x, y, barW - gap, barH, BAR_RADIUS);
      ctx.fill();
    }
    onLevel?.(level / BAR_COUNT);

    raf = requestAnimationFrame(draw);
  }

  const unsubscribe = store.subscribe((s) => setMicActive(s.micActive));
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();
  draw();

  return {
    /** Stop the animation loop and release audio resources. */
    destroy() {
      cancelAnimationFrame(raf);
      unsubscribe();
      resizeObserver.disconnect();
      idleOsc.stop();
      audioCtx.close();
    },
  };
}