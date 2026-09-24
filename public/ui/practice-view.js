/**
 * Karaoke practice view (feature 105 / CU2) — the live practice stage.
 *
 * Imperative async flow mirroring the pure state machine in `src/lib/cu2.ts`
 * (the reducer there is the canonical, unit-tested spec; this view is the
 * effectful layer that speaks, records and calls the API):
 *
 *   intro → question → model → explaining → repeatingFragment → feedback
 *        → fullAnswer → done
 *
 * The coach speaks each line via the server TTS (BrowserTTS), the user repeats
 * fragments push-to-talk (orb), attempts go to POST /api/attempt (whisper with
 * word timestamps; text fallback via BrowserSTT when whisper is unavailable),
 * and the karaoke book colors each word green/amber/red. A failed attempt
 * (score < passThreshold) retries the same fragment; after the last fragment
 * passes, the user reads the whole answer and the session is done.
 *
 * The view is a browser module: it cannot import `src/lib/*.ts` (no build
 * step), so the phase transitions are ported inline and kept in sync with the
 * reducer by hand.
 */

import { h, escapeHtml } from "./dom.js";
import { createAudioDock } from "./audio-dock.js";
import { WaveRecorder } from "../speech/recorder-wave.js";
import { BrowserTTS } from "../speech/browser-tts.js";
import { BrowserSTT } from "../speech/browser-stt.js";
import { pickStt } from "../speech/stt-pick.js";
import { ipaFor } from "./ipa.js";
import { getLocal } from "./settings/local.js";

/** Guard timeout: no speech detected while waiting → failed attempt + retry. */
const GUARD_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Module state (mirrors PracticeState in cu2.ts)
// ---------------------------------------------------------------------------

/** @type {"intro"|"question"|"model"|"explaining"|"repeatingFragment"|"feedback"|"fullAnswer"|"done"} */
let phase = "intro";
let fragmentCount = 0;
let fragmentIndex = 0;
let attemptCount = 0;
let passedFragments = [];
/** Scores of passed fragments (for the done summary). */
let fragmentScores = [];
let lastAttempt = null;
let fullAttemptCount = 0;
let fullPassed = false;

/** Session data loaded from GET /api/session/:id. */
let session = null;
let question = null; // { q, answer, fragments }
let passThreshold = 70;
let introText = "";
let explainLine = "";
let fullLine = "";

/** Continuous-session settings from the session snapshot (feature 107/108). */
let prepTime = 0;
let autoAdvance = false;

/** Live device prefs (feature 108) — applied without reloading. */
let showIpa = true;
let liveHighlight = true;

/** Whisper availability from /api/health (for STT engine selection). */
let health = null;

/** Flow cancellation token: incremented on leave; every await checks it. */
let flowToken = 0;

/** Auto-advance timer (feature 107): fires when autoAdvance is on. */
let autoAdvanceTimer = null;

/** Adaptive-difficulty pill auto-hide timer (feature 107). */
let adjustmentTimer = null;

/** Shell store + router (module-level so render helpers can reach them). */
let store = null;
let navigate = null;

/** DOM references. */
let els = null;
let dock = null;
let tts = null;

/** Swappable capture handlers wired into the dock (one capture at a time). */
let captureHandlers = null;

/** Last recorded WAV blob (replayed on retry with word highlighting). */
let lastWavBlob = null;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Initialize the practice view inside the `#view-practice` stage slot.
 *
 * Subscribes to the shell store: entering `#/practice/<id>` starts the flow
 * for that session; leaving the route cancels it (the session stays `active`,
 * resumable — feature 109).
 *
 * @param {HTMLElement} root - the `#view-practice` element
 * @param {{ store: import("./store.js").ShellState, navigate: (path: string) => void }} ctx
 */
export function initPracticeView(root, { store: shellStore, navigate: nav }) {
  store = shellStore;
  navigate = nav;
  let currentSessionId = null;

  store.subscribe((state) => {
    if (state.route?.view !== "practice") {
      if (currentSessionId) {
        currentSessionId = null;
        cancelFlow();
      }
      return;
    }
    if (state.sessionId && state.sessionId !== currentSessionId) {
      currentSessionId = state.sessionId;
      startFlow(state.sessionId);
    }
  });

  // Live device prefs (feature 108): IPA + live highlight apply immediately.
  window.addEventListener("engcoach:settings-changed", () => {
    if (store.state.route?.view !== "practice") return;
    applyLiveSettings();
    if (els?.book && question) {
      // Re-render the book preserving the current line + last colors.
      const isFull = phase === "fullAnswer";
      els.book.innerHTML = "";
      if (isFull) {
        const line = buildLine(0, question.answer);
        line.classList.add("current", "full");
        els.book.appendChild(line);
      } else {
        for (let i = 0; i < fragmentCount; i++) {
          els.book.appendChild(buildLine(i, question.fragments[i].text));
        }
        setCurrentLine(fragmentIndex);
      }
      if (lastAttempt) colorWords(lastAttempt);
    }
  });
}

// ---------------------------------------------------------------------------
// Flow lifecycle
// ---------------------------------------------------------------------------

/** Cancel the running flow: stop audio, recording, timers and the dock. */
function cancelFlow() {
  flowToken++;
  clearTimeout(autoAdvanceTimer);
  tts?.stop();
  if (dock) {
    dock.stopVisualizer();
    dock.destroy();
    dock = null;
  }
  captureHandlers = null;
  lastWavBlob = null;
  store?.set({ activeQuestion: null });
}

/** Load the session payload and run the CU2 flow (or render the review). */
async function startFlow(sessionId) {
  const token = ++flowToken;
  root.innerHTML = "";
  phase = "intro";
  fragmentCount = 0;
  fragmentIndex = 0;
  attemptCount = 0;
  passedFragments = [];
  fragmentScores = [];
  lastAttempt = null;
  fullAttemptCount = 0;
  fullPassed = false;
  session = null;
  question = null;
  lastWavBlob = null;

  tts = new BrowserTTS();

  try {
    const healthRes = await fetch("/api/health").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (token !== flowToken) return;
    health = healthRes;
    tts.setHealth(healthRes);
    await loadSessionPayload(sessionId, token);
    if (token !== flowToken) return;
    applyLiveSettings();

    // Completed sessions open in read-only review mode (feature 109): no
    // audio dock, no TTS, no recording — just the transcript with colors.
    if (session.status === "completed") {
      renderReview();
      return;
    }

    store.set({ activeQuestion: session.questions.length });

    dock = createAudioDock(
      root,
      {
        onRecordStart: () => captureHandlers?.onRecordStart(),
        onRecordEnd: () => captureHandlers?.onRecordEnd(),
        onRetry: () => tts.stop(),
        onFinish: () => finishSession(),
      },
      { rate: Number(getLocal("tempo", 1)) },
    );
    dock.startVisualizer();

    renderHeader();
    await runFlow(token);
  } catch (err) {
    if (token !== flowToken) return;
    renderError(err.message);
  }
}

/**
 * Fetch GET /api/session/:id and refresh the module state from the snapshot
 * (question = last one, plus the continuous-session settings — feature 107).
 */
async function loadSessionPayload(sessionId, token) {
  const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}`);
  if (token !== flowToken) return;
  if (!res.ok) throw new Error(res.status === 404 ? "Sesión no encontrada." : `HTTP ${res.status}`);
  const data = await res.json();
  session = data.session;
  question = data.question;
  introText = data.intro;
  explainLine = data.explainLine;
  fullLine = data.fullLine;
  passThreshold = data.passThreshold ?? 70;
  prepTime = data.prepTime ?? 0;
  autoAdvance = data.autoAdvance ?? false;
  fragmentCount = question?.fragments?.length ?? 0;
}

// ---------------------------------------------------------------------------
// The CU2 flow (imperative port of the cu2.ts reducer)
// ---------------------------------------------------------------------------

async function runFlow(token) {
  // INTRO — coach explains the dynamics (first question only). Resumed
  // sessions (feature 109) skip it: they continue at the exact checkpoint.
  const resuming = isResume();
  if (!resuming) {
    setPhase("intro");
    await speak(introText, token);
    if (token !== flowToken) return;
  }

  await runQuestionLoop(token, { resume: resuming });
}

/**
 * True when the session has progress to resume (feature 109): more than one
 * question, or the last question already has attempts / a full answer / an
 * evaluation. A fresh session starts from the intro.
 */
function isResume() {
  const q = session?.questions?.at(-1);
  return (
    (session?.questions?.length ?? 0) > 1 ||
    Boolean(q && (q.fragments.some((f) => f.attempts.length > 0) || q.fullAttempt || q.eval))
  );
}

/**
 * One question pass: question → prep → model → explaining → fragments →
 * full → done. Reused by `nextQuestion()` for the continuous session
 * (feature 107), skipping the intro. When `resume` is true (feature 109) the
 * fragment loop starts at the first unpassed fragment instead of fragment 0.
 */
async function runQuestionLoop(token, { resume = false } = {}) {
  // A question whose eval is already checkpointed is done: resumed sessions
  // land directly on the done panel (offer the next question).
  if (question.eval) {
    setPhase("done");
    renderDone({ finished: false });
    await checkpoint({ status: "active" });
    return;
  }

  // QUESTION — shown and read aloud.
  setPhase("question");
  renderQuestion();
  await speak(question.q, token);
  if (token !== flowToken) return;

  // PREP TIME — beeps before the coach reads the model (spec 107).
  if (prepTime > 0) {
    await prepTimePause(prepTime, token);
    if (token !== flowToken) return;
  }

  // MODEL — the strong answer as karaoke lyrics, read with word progress.
  setPhase("model");
  renderKaraokeBook();
  await speakModelWithProgress(question.answer, token);
  if (token !== flowToken) return;

  // EXPLAIN — coach explains the fragment dynamics.
  setPhase("explaining");
  await speak(explainLine, token);
  if (token !== flowToken) return;

  // LOOP — one pass per fragment; failed attempts retry the same fragment.
  // Resumed sessions continue from the first fragment that did not pass.
  let fi = 0;
  if (resume) {
    const firstUnpassed = question.fragments.findIndex((f) => !f.passed);
    fi = firstUnpassed === -1 ? fragmentCount : firstUnpassed;
  }
  while (fi < fragmentCount) {
    fragmentIndex = fi;
    attemptCount = 0;
    setPhase("repeatingFragment");
    setCurrentLine(fi);
    await speak(question.fragments[fi].text, token);
    if (token !== flowToken) return;

    const outcome = await captureAttempt(question.fragments[fi].text, "fragment", token);
    if (token !== flowToken) return;

    setPhase("feedback");
    lastAttempt = outcome;
    attemptCount++;
    renderFeedback(outcome, fi);
    if (!outcome.passed && lastWavBlob) {
      await replayUserWav(lastWavBlob, outcome.words, token);
      if (token !== flowToken) return;
    }
    await speak(outcome.coachLine, token);
    if (token !== flowToken) return;

    if (outcome.passed) {
      passedFragments.push(fi);
      fragmentScores.push(outcome.score);
      fi++;
    }
    // else: retry the same fragment (CU2 alt flow).
  }

  // FULL — read the whole answer.
  fullAttemptCount = 0;
  setPhase("fullAnswer");
  renderFull();
  await speak(fullLine, token);
  if (token !== flowToken) return;

  const fullOutcome = await captureAttempt(question.answer, "full", token);
  if (token !== flowToken) return;

  setPhase("feedback");
  lastAttempt = fullOutcome;
  fullAttemptCount++;
  fullPassed = fullOutcome.passed;
  renderFeedback(fullOutcome, -1);
  if (!fullOutcome.passed && lastWavBlob) {
    await replayUserWav(lastWavBlob, fullOutcome.words, token);
    if (token !== flowToken) return;
  }
  await speak(fullOutcome.coachLine, token);
  if (token !== flowToken) return;

  // DONE — continuous session: keep it active and offer the next question.
  setPhase("done");
  renderDone({ finished: false });
  await checkpoint({ status: "active" });
  if (autoAdvance) {
    autoAdvanceTimer = setTimeout(() => {
      if (token === flowToken && phase === "done") nextQuestion();
    }, 1200);
  }
}

/**
 * Next question (feature 107): POST /api/session/next-question, then reload
 * the session snapshot (fresh explainLine/fullLine/prepTime/autoAdvance + the
 * new last question) and restart the question loop from the QUESTION phase.
 */
async function nextQuestion() {
  if (phase !== "done") return;
  const token = flowToken;
  setPhase("question");
  try {
    const res = await fetch("/api/session/next-question", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.id }),
    });
    if (token !== flowToken) return;
    if (res.status === 409) {
      // Session no longer active → finish and return to config.
      finishSession();
      return;
    }
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);

    await loadSessionPayload(session.id, token);
    if (token !== flowToken) return;
    if (json.adjustment) showAdjustment(json.adjustment);
    store.set({ activeQuestion: session.questions.length });
    await runQuestionLoop(token);
  } catch (err) {
    if (token !== flowToken) return;
    showAdjustment(`No se pudo generar la siguiente pregunta: ${err.message}`);
    setPhase("done");
    renderDone({ finished: false });
  }
}

/** Set the current phase and reflect it on the dock (retry pill only). */
function setPhase(p) {
  phase = p;
  dock?.setRetryEnabled(p === "feedback" || p === "repeatingFragment" || p === "fullAnswer");
}

// ---------------------------------------------------------------------------
// Prep-time beeps (feature 107)
// ---------------------------------------------------------------------------

/** Play a short 880 Hz beep (WebAudio oscillator). */
function playBeep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
    osc.onended = () => ctx.close().catch(() => {});
  } catch {
    // audio unavailable — the pause still happens
  }
}

/**
 * Prep-time pause: 3 beeps evenly spaced across `seconds` before the coach
 * reads the model (spec 107). The model text stays visible on screen.
 */
async function prepTimePause(seconds, token) {
  if (seconds <= 0) {
    playBeep();
    await sleep(300);
    return;
  }
  const step = seconds / 3;
  for (let i = 0; i < 3; i++) {
    if (token !== flowToken) return;
    playBeep();
    await sleep(step * 1000);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Show the adaptive-difficulty pill (spec 107) and auto-hide it. */
function showAdjustment(message) {
  if (!els?.adjustment) return;
  els.adjustment.textContent = message;
  els.adjustment.hidden = false;
  clearTimeout(adjustmentTimer);
  adjustmentTimer = setTimeout(() => {
    els.adjustment.hidden = true;
  }, 6000);
}

// ---------------------------------------------------------------------------
// Speech
// ---------------------------------------------------------------------------

/** Speak a line through the best TTS engine; returns false when stopped. */
async function speak(text, token) {
  dock?.setMode("ai");
  const ok = await tts.speak(text, { rate: dock?.getRate() ?? 1, volume: volumeSetting() });
  if (token !== flowToken) return false;
  dock?.setMode("idle");
  return ok;
}

/**
 * Speak the model answer with karaoke word progress.
 *
 * Fetches the server TTS audio directly so we can decode its duration and
 * highlight the lyrics linearly (Piper emits no word timestamps). Falls back
 * to plain `speak()` when the server engine is unavailable.
 */
async function speakModelWithProgress(text, token) {
  dock?.setMode("ai");
  const params = new URLSearchParams({ text });
  const rate = dock?.getRate() ?? 1;
  if (rate !== 1) params.set("rate", String(rate));

  let audio = null;
  let durationMs = 0;
  try {
    const res = await fetch(`/api/tts?${params.toString()}`);
    if (!res.ok) throw new Error("tts-unavailable");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    audio = new Audio(url);
    try {
      const buf = await blob.arrayBuffer();
      const ac = new AudioContext();
      const decoded = await ac.decodeAudioData(buf);
      durationMs = decoded.duration * 1000;
      ac.close();
    } catch {
      durationMs = 0; // no progress highlight
    }
    await new Promise((resolve) => {
      audio.onended = resolve;
      audio.onerror = resolve;
      audio.play().catch(resolve);
      if (durationMs > 0) animateWordProgress(durationMs, token);
    });
  } catch {
    // Server TTS unavailable → plain browser speech, no progress.
    await tts.speak(text, { rate, volume: volumeSetting() });
  } finally {
    if (audio) URL.revokeObjectURL(audio.src);
  }
  if (token !== flowToken) return;
  dock?.setMode("idle");
}

/** Highlight the karaoke words linearly over `durationMs` (rAF loop). */
function animateWordProgress(durationMs, token) {
  const spans = allWordSpans();
  if (!spans.length) return;
  const start = performance.now();
  const tick = () => {
    if (token !== flowToken) return;
    const t = Math.min(1, (performance.now() - start) / durationMs);
    const count = Math.floor(t * spans.length);
    spans.forEach((s, i) => s.classList.toggle("kw-spoken", i < count));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Attempt capture (push-to-talk → whisper / browser STT → /api/attempt)
// ---------------------------------------------------------------------------

/**
 * Capture one attempt (fragment or full answer) and return its outcome.
 *
 * Engine selection: whisper (record WAV → audio attempt) when ready, else
 * BrowserSTT (live speech → text attempt). If the whisper attempt fails
 * mid-flight, fall back to BrowserSTT + text mode.
 */
async function captureAttempt(target, kind, token) {
  const sttChoice = getLocal("stt", null) ?? localStorage.getItem("stt-choice");
  const stt = pickStt(health, sttChoice);
  if (stt === "whisper") {
    const { blob, timedOut, error } = await waitForUserRecording(token);
    if (token !== flowToken) return null;
    if (error) throw new Error(error);
    if (timedOut) return timedOutOutcome(target, kind);
    lastWavBlob = blob;
    try {
      return await submitAudio(blob, target, kind);
    } catch (err) {
      // whisper failed → browser STT fallback (text mode).
      const text = await captureBrowserSpeech(token);
      if (token !== flowToken) return null;
      if (!text) return timedOutOutcome(target, kind);
      return await submitText(text, target, kind);
    }
  }
  const text = await captureBrowserSpeech(token);
  if (token !== flowToken) return null;
  if (!text) return timedOutOutcome(target, kind);
  return await submitText(text, target, kind);
}

/** Arm the orb and wait for a push-to-talk WAV recording (or the guard timeout). */
function waitForUserRecording(token) {
  return new Promise((resolve) => {
    let recorder = null;
    let recorderReady = null;
    let pressed = false;
    let settled = false;

    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      dock?.setOrbEnabled(false);
      dock?.setRetryEnabled(false);
      resolve(value);
    };

    // Guard fires only when the user never pressed the orb.
    const guard = setTimeout(() => {
      if (!pressed) settle({ blob: null, timedOut: true });
    }, GUARD_TIMEOUT_MS);

    dock?.setOrbEnabled(true);
    dock?.setRetryEnabled(true);

    captureHandlers = {
      onRecordStart: () => {
        if (settled) return;
        pressed = true;
        recorder = new WaveRecorder();
        recorderReady = recorder.start().catch(() => {
          settle({ blob: null, timedOut: false, error: "Micrófono no disponible. Revisa los permisos del navegador." });
        });
      },
      onRecordEnd: async () => {
        if (settled) return;
        try {
          await recorderReady;
        } catch {
          return;
        }
        if (!recorder || settled) return;
        const blob = recorder.stop();
        settle({ blob, timedOut: false });
      },
    };
  });
}

/** Capture speech via the browser Web Speech API (push-to-talk). */
function captureBrowserSpeech(token) {
  return new Promise((resolve) => {
    const stt = new BrowserSTT({
      onFinal: () => {},
      onEnd: () => {
        clearTimeout(guard);
        dock?.setOrbEnabled(false);
        dock?.setRetryEnabled(false);
        resolve(stt.result() || null);
      },
      onError: () => {
        clearTimeout(guard);
        dock?.setOrbEnabled(false);
        dock?.setRetryEnabled(false);
        resolve(null);
      },
    });
    if (!stt.isSupported()) {
      resolve(null);
      return;
    }
    const guard = setTimeout(() => {
      stt.abort();
      resolve(null);
    }, GUARD_TIMEOUT_MS);

    dock?.setOrbEnabled(true);
    dock?.setRetryEnabled(true);
    let started = false;
    captureHandlers = {
      onRecordStart: () => {
        if (!started) {
          started = true;
          stt.start();
        }
      },
      onRecordEnd: () => stt.stop(),
    };
  });
}

/** POST a WAV recording to /api/attempt (whisper word timestamps). */
async function submitAudio(blob, target, kind) {
  const params = attemptParams(target, kind);
  const res = await fetch(`/api/attempt?${params.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: blob,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return outcomeFromJson(json, target, kind);
}

/** POST a plain transcription to /api/attempt?mode=text (no whisper). */
async function submitText(text, target, kind) {
  const params = attemptParams(target, kind);
  params.set("mode", "text");
  const res = await fetch(`/api/attempt?${params.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userText: text }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return outcomeFromJson(json, target, kind);
}

/** Shared query params for /api/attempt (persistence + threshold). */
function attemptParams(target, kind) {
  const params = new URLSearchParams({
    target,
    question: question.q,
    level: session.config.level,
    sessionId: session.id,
    passThreshold: String(passThreshold),
  });
  if (kind === "full") {
    params.set("full", "1");
  } else {
    params.set("fragmentId", question.fragments[fragmentIndex].id);
  }
  return params;
}

/** Map the /api/attempt response into an AttemptOutcome (cu2.ts shape). */
function outcomeFromJson(json, target, kind) {
  return {
    kind,
    score: json.score ?? 0,
    verdict: json.verdict ?? "retry",
    passed: json.score >= passThreshold,
    words: Array.isArray(json.words) ? json.words : [],
    target,
    coachLine: json.coachLine ?? "",
  };
}

/** Outcome for a guard timeout (no speech captured). */
function timedOutOutcome(target, kind) {
  return {
    kind,
    score: 0,
    verdict: "retry",
    passed: false,
    words: [],
    target,
    timedOut: true,
    coachLine: "I didn't hear you. Let's try that again.",
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Header: session title + live speech-engine pill. */
function renderHeader() {
  const pill = h("div", { class: "status-pill practice-speech-pill" }, [
    h("span", { class: "status-dot", "aria-hidden": "true" }),
    h("span", { class: "status-label" }, "Speech Engine"),
    h("span", { class: "status-state" }, "…"),
  ]);
  els = {
    head: h("div", { class: "practice-head" }, [
      h("div", { class: "practice-title" }, escapeHtml(session.title || "Practice")),
      pill,
    ]),
    adjustment: h("div", { class: "adjustment-chip", hidden: true }),
    feedbackChip: h("div", { class: "feedback-chip", hidden: true }),
    book: h("div", { class: "karaoke-book" }),
    sub: h("div", { class: "practice-sub" }),
    done: h("div", { class: "practice-done", hidden: true }),
  };
  root.append(els.head, els.adjustment, els.feedbackChip, els.book, els.sub, els.done);

  // Reflect the live speech engine state (store keeps it in sync via /api/health).
  const stateEl = pill.querySelector(".status-state");
  const updatePill = (ready) => {
    stateEl.textContent = ready ? "READY" : "BROWSER";
    pill.classList.toggle("ok", ready);
    pill.classList.toggle("bad", !ready);
  };
  updatePill(store.state.speechReady);
  store.subscribe((state) => {
    if (state.route?.view === "practice") updatePill(state.speechReady);
  });
}

/** QUESTION phase: show the question as the coach transcript. */
function renderQuestion() {
  els.done.hidden = true;
  els.sub.hidden = false;
  els.sub.innerHTML = "";
  els.sub.appendChild(
    h("div", { class: "coach-transcript" }, [
      h("span", { class: "coach-label" }, "Coach:"),
      h("span", { class: "coach-text" }, escapeHtml(question.q)),
    ]),
  );
}

/** MODEL phase: build the karaoke book (one line per fragment). */
function renderKaraokeBook() {
  els.book.hidden = false;
  els.book.innerHTML = "";
  for (let i = 0; i < fragmentCount; i++) {
    els.book.appendChild(buildLine(i, question.fragments[i].text));
  }
  setCurrentLine(0);
}

/** Build one karaoke line of word spans (+ optional IPA annotation). */
function buildLine(index, text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const line = h("div", { class: "karaoke-line", dataset: { index: String(index) } });
  for (const w of words) {
    const ipa = ipaFor(w);
    const wrap = h("span", { class: "kw-wrap" }, [
      h("span", { class: "kw", dataset: { word: w } }, escapeHtml(w)),
      ...(ipa ? [h("span", { class: "kw-ipa" }, ipa)] : []),
    ]);
    line.appendChild(wrap);
  }
  return line;
}

/** Mark line `index` as current; others past/future. */
function setCurrentLine(index) {
  const lines = els.book.querySelectorAll(".karaoke-line");
  lines.forEach((line, i) => {
    line.classList.toggle("past", i < index);
    line.classList.toggle("current", i === index);
    line.classList.toggle("future", i > index);
  });
}

/** All word spans in the book, in order (for coloring/progress). */
function allWordSpans() {
  return [...els.book.querySelectorAll(".kw")];
}

/** Apply green/amber/red to the word spans of the active line (or all for full). */
function colorWords(outcome) {
  const spans = allWordSpans();
  const words = outcome.words ?? [];
  spans.forEach((s, i) => {
    s.classList.remove("kw-green", "kw-amber", "kw-red", "kw-spoken");
    if (!liveHighlight) return;
    const w = words[i];
    if (w?.status === "green") s.classList.add("kw-green");
    else if (w?.status === "amber") s.classList.add("kw-amber");
    else if (w?.status === "red") s.classList.add("kw-red");
  });
}

/** FEEDBACK phase: color the words + show the feedback chip. */
function renderFeedback(outcome, lineIndex) {
  colorWords(outcome);
  const passed = outcome.passed;
  const focus = (outcome.missing ?? []).slice(0, 2).join(", ");
  const chipText = passed
    ? `Buen flujo · ${outcome.score}%`
    : `Foco en ${focus || "pronunciación"} · ${outcome.score}%`;
  els.feedbackChip.textContent = chipText;
  els.feedbackChip.hidden = false;
  els.feedbackChip.classList.toggle("ok", passed);
  els.feedbackChip.classList.toggle("bad", !passed);
}

/** FULL phase: whole answer as one active block (colors cleared). */
function renderFull() {
  els.book.innerHTML = "";
  const line = buildLine(0, question.answer);
  line.classList.add("current", "full");
  els.book.appendChild(line);
  els.feedbackChip.hidden = true;
}

/**
 * DONE phase: summary panel + actions.
 *
 * `finished: true` → classic end (Hacer otra práctica). `finished: false` →
 * continuous session (feature 107): Siguiente Pregunta (IA) / Finalizar
 * Sesión / Hacer otra práctica.
 */
function renderDone({ finished }) {
  els.book.hidden = true;
  els.sub.hidden = true;
  els.feedbackChip.hidden = true;
  els.done.hidden = false;
  const summary = sessionSummary();
  const actions = finished
    ? [
        h("button", { type: "button", class: "btn start-btn", onclick: () => navigate("#/") }, [
          h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "graphic_eq"),
          "Hacer otra práctica",
        ]),
      ]
    : [
        h("button", { type: "button", class: "btn start-btn", onclick: () => nextQuestion() }, [
          h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "arrow_forward"),
          "Siguiente Pregunta (IA)",
        ]),
        h("button", { type: "button", class: "btn ghost", onclick: () => finishSession() }, [
          h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "flag"),
          "Finalizar Sesión",
        ]),
        h("button", { type: "button", class: "btn ghost", onclick: () => navigate("#/") }, [
          h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "graphic_eq"),
          "Hacer otra práctica",
        ]),
      ];
  els.done.appendChild(
    h("div", { class: "practice-done-card" }, [
      h("div", { class: "practice-done-icon" }, [
        h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, finished ? "verified" : "check_circle"),
      ]),
      h("h2", { class: "practice-done-title" }, finished ? "¡Práctica completada!" : "¡Pregunta completada!"),
      h("p", { class: "practice-done-sub" }, [
        `Preguntas practicadas: ${summary.count} · Promedio ${summary.avg}%`,
      ]),
      h("div", { class: "practice-done-actions" }, actions),
    ]),
  );
}

/** Aggregate summary of the session (question count + avg score). */
function sessionSummary() {
  const count = session?.questions?.length ?? 0;
  const scores = (session?.questions ?? []).flatMap((q) =>
    q.fragments.flatMap((f) => f.attempts.map((a) => a.score)),
  );
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  return { count, avg };
}

/** Error state (session load / fatal flow failure). */
function renderError(message) {
  root.innerHTML = "";
  root.appendChild(
    h("div", { class: "practice-error" }, [
      h("div", { class: "practice-error-icon" }, [
        h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "error"),
      ]),
      h("p", { class: "practice-error-text" }, escapeHtml(message)),
      h("button", { type: "button", class: "btn ghost", onclick: () => navigate("#/") }, "Volver a Config"),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Review mode (feature 109): read-only view of a completed session
// ---------------------------------------------------------------------------

/**
 * Render a completed session in read-only review mode: every question with
 * its model answer, the colored attempts (words[] from 106), the full-answer
 * attempt and the consolidated evaluation. No recording, no TTS. Offers
 * "Practicar de nuevo" (prefills the config from this session) and
 * "Volver a Config".
 */
function renderReview() {
  root.innerHTML = "";
  const head = h("div", { class: "practice-head" }, [
    h("div", { class: "practice-title" }, escapeHtml(session.title || "Practice")),
    h("div", { class: "status-pill review-pill" }, [
      h("span", { class: "status-dot", "aria-hidden": "true" }),
      h("span", { class: "status-label" }, "COMPLETED"),
    ]),
  ]);
  const list = h("div", { class: "review-list" });
  for (const q of session.questions ?? []) {
    list.appendChild(renderReviewQuestion(q));
  }
  const actions = h("div", { class: "review-actions" }, [
    h("button", { type: "button", class: "btn start-btn", onclick: () => practiceAgain() }, [
      h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "refresh"),
      "Practicar de nuevo",
    ]),
    h("button", { type: "button", class: "btn ghost", onclick: () => navigate("#/") }, [
      h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "arrow_back"),
      "Volver a Config",
    ]),
  ]);
  root.append(head, list, actions);
}

/** One review card: question, model answer, fragment attempts, eval. */
function renderReviewQuestion(q) {
  const card = h("div", { class: "review-question" }, [
    h("div", { class: "coach-transcript" }, [
      h("span", { class: "coach-label" }, "Coach:"),
      h("span", { class: "coach-text" }, escapeHtml(q.q)),
    ]),
    h("div", { class: "review-answer" }, [
      h("span", { class: "review-label" }, "Model answer"),
      h("div", { class: "review-text" }, escapeHtml(q.answer)),
    ]),
  ]);

  for (const f of q.fragments ?? []) {
    const frag = h("div", { class: "review-fragment" }, [
      h("div", { class: "review-frag-text" }, coloredWords(f.text, f.attempts.at(-1)?.words ?? [])),
    ]);
    for (const a of f.attempts ?? []) {
      frag.appendChild(
        h("div", { class: "review-attempt", dataset: { passed: String(f.passed) } }, [
          h("span", { class: "review-attempt-score" }, `${a.score}%`),
          coloredWords(a.text, a.words),
        ]),
      );
    }
    card.appendChild(frag);
  }

  if (q.fullAttempt) {
    card.appendChild(
      h("div", { class: "review-full" }, [
        h("div", { class: "review-label" }, "Full answer attempt"),
        h("div", { class: "review-attempt" }, [
          h("span", { class: "review-attempt-score" }, `${q.fullAttempt.score}%`),
          coloredWords(q.fullAttempt.text, q.fullAttempt.words),
        ]),
      ]),
    );
  }

  if (q.eval) {
    const rows = [];
    if (q.eval.missing?.length) {
      rows.push(h("div", { class: "review-eval-row" }, ["Missing: ", h("span", { class: "review-eval-missing" }, escapeHtml(q.eval.missing.join(", ")))]));
    }
    if (q.eval.tips?.length) {
      rows.push(h("div", { class: "review-eval-row" }, ["Tips: ", h("span", { class: "review-eval-tips" }, escapeHtml(q.eval.tips.join(" · ")))]));
    }
    card.appendChild(
      h("div", { class: "review-eval" }, [
        h("div", { class: "review-label" }, `Evaluation · ${q.eval.score}% · ${q.eval.verdict}`),
        ...rows,
      ]),
    );
  }
  return card;
}

/** Word spans colored green/amber/red from a stored words[] alignment (106). */
function coloredWords(text, words) {
  const tokens = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  const wrap = h("span", { class: "review-words" });
  tokens.forEach((w, i) => {
    const status = words?.[i]?.status;
    const span = h("span", { class: "kw" }, escapeHtml(w));
    if (status === "green" || status === "amber" || status === "red") span.classList.add(`kw-${status}`);
    wrap.appendChild(span);
    if (i < tokens.length - 1) wrap.appendChild(document.createTextNode(" "));
  });
  return wrap;
}

/**
 * "Practicar de nuevo": dispatch the prefill event with this session's config
 * so the config view restores it (feature 109), then go home.
 */
function practiceAgain() {
  window.dispatchEvent(
    new CustomEvent("engcoach:prefill-session", {
      detail: { config: session.config, sessionId: session.id },
    }),
  );
  navigate("#/");
}

// ---------------------------------------------------------------------------
// User WAV replay (retry: hear yourself with the lyrics lit)
// ---------------------------------------------------------------------------

/** Replay the user's last recording with word-sync highlighting. */
function replayUserWav(blob, words, token) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const spans = allWordSpans();
    const timed = words?.length === spans.length && words.every((w) => typeof w.startMs === "number");
    audio.onended = () => {
      URL.revokeObjectURL(url);
      spans.forEach((s) => s.classList.remove("kw-spoken"));
      resolve();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    audio.play().catch(() => {
      URL.revokeObjectURL(url);
      resolve();
    });
    if (timed && spans.length) {
      const tick = () => {
        if (token !== flowToken) return;
        const t = audio.currentTime * 1000;
        let count = 0;
        for (const w of words) {
          if (t >= (w.startMs ?? 0)) count++;
          else break;
        }
        spans.forEach((s, i) => s.classList.toggle("kw-spoken", i < count));
        if (!audio.paused && !audio.ended) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Idempotent saveSession via POST /api/session/checkpoint (feature 105). */
async function checkpoint(payload) {
  try {
    await fetch("/api/session/checkpoint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: session.id, ...payload }),
    });
  } catch {
    // non-fatal: the session is already persisted per-attempt.
  }
}

/** Finish the session: mark completed, clear the badge and return to config. */
async function finishSession() {
  await checkpoint({ status: "completed" });
  store.set({ activeQuestion: null });
  navigate("#/");
}

// ---------------------------------------------------------------------------
// Live device prefs (feature 108)
// ---------------------------------------------------------------------------

/** Read the live device prefs (IPA + live highlight) and apply them. */
function applyLiveSettings() {
  showIpa = Boolean(getLocal("showIpa", true));
  liveHighlight = Boolean(getLocal("liveHighlight", true));
  if (els?.book) els.book.classList.toggle("no-ipa", !showIpa);
}

/** Coach volume (0–1) from the device prefs (spec 108). */
function volumeSetting() {
  const v = Number(getLocal("volume", 100));
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) / 100 : 1;
}