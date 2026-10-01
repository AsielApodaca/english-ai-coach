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
 * The coach speaks each line via the server TTS (BrowserTTS) and the user
 * repeats fragments under their own control: capture is PUSH-TO-TALK (feature
 * 111) — the mic never starts by itself, it starts while the dock mic button
 * or the SPACE key is held down and is cut the moment the last of them is
 * released (or at the 3 s/word ceiling). Silence detection plays no part in
 * ending the turn anymore. Attempts go to POST /api/attempt (whisper with word
 * timestamps; text fallback via BrowserSTT when whisper is unavailable), and
 * the karaoke book colors each word green/amber/red. A failed attempt (score <
 * passThreshold) retries the same fragment; after the last fragment passes,
 * the user reads the whole answer and the session is done.
 *
 * A PASSING attempt (fragment or full answer — feature 110) plays the
 * synthesized chime of `speech/chime.js` instead of the congratulation line
 * and advances straight to the next read, whose text is exactly the fragment
 * (the verbatim invariant: no congratulation or instruction prefix, ever).
 *
 * The view is a browser module: it cannot import `src/lib/*.ts` (no build
 * step), so the phase transitions are ported inline and kept in sync with the
 * reducer by hand.
 */

import { h, escapeHtml } from "./dom.js";
import { createAudioDock } from "./audio-dock.js";
import { WaveRecorder } from "../speech/recorder-wave.js";
import { PushToTalk, maxCaptureMs, wordInteractionAllowed } from "../speech/ptt.js";
import { BrowserTTS } from "../speech/browser-tts.js";
import { BrowserSTT } from "../speech/browser-stt.js";
import { pickStt } from "../speech/stt-pick.js";
import { playChime, stopChime } from "../speech/chime.js";
import { respellFor } from "./ipa.js";
import { tokenizeWords, lineColorStatuses } from "./karaoke-color.js";
import { getLocal } from "./settings/local.js";
import { volumeFactor } from "./settings/volume.js";

/**
 * Push-to-talk labels (feature 111): the three visual states of the turn are
 * signalled with the mic label + orb/dock styling only — there is no beep.
 */
const PTT_WAIT_LABEL = "Tu turno · mantén presionado espacio o el micrófono";
const PTT_RECORD_LABEL = "Grabando… suelta para terminar";
const MIC_IDLE_LABEL = "Micrófono";

/** Shown when the mic stream cannot be acquired (permissions / no device). */
const MIC_UNAVAILABLE = "Micrófono no disponible. Revisa los permisos del navegador.";

/** Defensive cap on the success chime so phase `feedback` can never hang. */
const CHIME_MAX_MS = 500;

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

/** The `#view-practice` stage slot (set in initPracticeView). */
  let root = null;

  /** DOM references. */
  let els = null;
  let dock = null;
  let tts = null;

/** Last recorded WAV blob (replayed on retry with word highlighting). */
let lastWavBlob = null;

/**
 * Line the last attempt was scored against: `>= 0` fragment index, `-1` the
 * full answer, `-2` no attempt yet (colors must not be restored from it).
 */
let lastAttemptLineIndex = -2;

/** Pending karaoke read; the dock's retry pill can cut it short. */
let stopKaraokeRead = null;

/**
 * The `<audio>` element of the read in flight (karaoke reads build their own
 * element instead of going through `BrowserTTS`), so a settings change can
 * re-apply the volume while it plays.
 * @type {HTMLAudioElement|null}
 */
let readAudio = null;

/** Pending user-WAV replay; the retry pill and `cancelFlow()` can cut it. */
let stopReplay = null;

/**
 * Canceller of the STT turn in flight (whisper prewarm / browser
 * recognition). `cancelFlow()` invokes it so no mic, timer or recognition
 * survives the session that armed it.
 */
let cancelPendingTurn = null;

/**
 * Push-to-talk controller of the capture turn in flight (feature 111), or
 * null outside a capture. The dock button and the SPACE key route their
 * presses through it; it is what makes the mic never start by itself.
 * @type {import("../speech/ptt.js").PushToTalk|null}
 */
let activePtt = null;

/** True while the coach is reading a line (blocks karaoke interaction). */
let coachSpeaking = false;

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
export function initPracticeView(rootElement, { store: shellStore, navigate: nav }) {
  store = shellStore;
  navigate = nav;
  root = rootElement;
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
      // Switching sessions in place: tear the old flow down first, otherwise
      // its TTS/STT keeps running over the new one.
      currentSessionId = state.sessionId;
      cancelFlow();
      startFlow(state.sessionId);
    }
  });

  // Live device prefs (feature 108): IPA + live highlight apply immediately.
  window.addEventListener("engcoach:settings-changed", () => {
    if (store.state.route?.view !== "practice") return;
    const prev = { showIpa, liveHighlight };
    applyLiveSettings();
    // Only re-render for prefs that change the book itself: a volume drag
    // fires on every step and a rebuild would wipe the highlights of the read
    // in progress.
    if (prev.showIpa !== showIpa || prev.liveHighlight !== liveHighlight) rebuildBook();
  });

  // Push-to-talk keyboard trigger (feature 111): SPACE starts/cuts the capture
  // of the turn in flight. Registered once; both handlers no-op when no
  // capture is armed, so SPACE keeps its normal meaning everywhere else.
  window.addEventListener("keydown", onPttKeyDown);
  window.addEventListener("keyup", onPttKeyUp);
}

// ---------------------------------------------------------------------------
// Push-to-talk triggers (feature 111): dock button + SPACE key
// ---------------------------------------------------------------------------

/** True when a key event targets a text-entry surface (input/textarea/CE). */
function isTextEntryTarget(target) {
  if (!target || typeof target !== "object") return false;
  const el = /** @type {Element|null} */ (target);
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA";
}

/** True for the space key in any of its browser spellings. */
function isSpaceKey(event) {
  return event.code === "Space" || event.key === " " || event.key === "Spacebar";
}

/**
 * SPACE pressed → start the capture of the turn in flight.
 *
 * Guards: auto-repeat never starts a second capture (`event.repeat`), text
 * entry keeps typing spaces, and outside a capture SPACE keeps its default
 * meaning (scrolling / button activation). Inside one it is fully consumed:
 * `preventDefault()` stops the page from scrolling and stops a focused
 * button from being activated by the very key that drives the turn.
 *
 * @param {KeyboardEvent} event
 */
function onPttKeyDown(event) {
  if (!isSpaceKey(event) || event.repeat) return;
  if (isTextEntryTarget(event.target)) return;
  if (!activePtt) return;
  event.preventDefault();
  activePtt.press("space");
}

/**
 * SPACE released → cut the capture (unless the pointer is still holding it).
 *
 * @param {KeyboardEvent} event
 */
function onPttKeyUp(event) {
  if (!isSpaceKey(event) || !activePtt) return;
  // Released from a text field mid-press: still let go, otherwise the capture
  // would stay armed forever. Returns null when SPACE was not held.
  if (activePtt.release("space") !== null) event.preventDefault();
}

/**
 * Whether the karaoke words may react to hover/click right now (features
 * 112/113): allowed while the turn waits for the user's press and in review
 * mode, blocked while the coach reads and while a capture is held down.
 *
 * @returns {boolean}
 */
export function canInteractWithWords() {
  return wordInteractionAllowed({
    coachSpeaking,
    recording: activePtt?.isRecording ?? false,
  });
}

// ---------------------------------------------------------------------------
// Flow lifecycle
// ---------------------------------------------------------------------------

/** Cancel the running flow: stop audio, recording, timers and the dock. */
function cancelFlow() {
  flowToken++;
  clearTimeout(autoAdvanceTimer);
  clearTimeout(adjustmentTimer);
  // Settle an in-flight STT turn first (while `dock` is still alive): its
  // prewarm/ceiling timers would otherwise fire after the session is gone.
  cancelPendingTurn?.();
  cancelPendingTurn = null;
  // A held capture is cut here: its audio is discarded and never evaluated.
  if (activePtt) {
    activePtt.cancel();
    activePtt = null;
  }
  tts?.stop();
  stopChime();
  stopKaraokeRead?.();
  stopReplay?.();
  if (dock) {
    dock.stopVisualizer();
    dock.destroy();
    dock = null;
  }
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
  lastAttemptLineIndex = -2;
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
        onRetry: () => {
          stopKaraokeRead?.();
          stopReplay?.();
          tts.stop();
        },
        onFinish: () => finishSession(),
        // Push-to-talk (feature 111): the mic button routes its press/release
        // to the capture turn in flight (no-op outside one).
        onPttPress: () => activePtt?.press("pointer") ?? false,
        onPttRelease: () => activePtt?.release("pointer") ?? null,
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
 * One question pass: question → model → explaining → fragments →
 * full → done. Reused by `nextQuestion()` for the continuous session
 * (feature 107), skipping the intro. When `resume` is true (feature 109) the
 * fragment loop starts at the first unpassed fragment instead of fragment 0.
 */
async function runQuestionLoop(token, { resume = false } = {}) {
  // A new question starts without a scorable attempt to re-color.
  lastAttempt = null;
  lastAttemptLineIndex = -2;

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

  // MODEL — the strong answer as karaoke lyrics, read with word progress.
  setPhase("model");
  renderKaraokeBook();
  await speakWithKaraoke(question.answer, token);
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
    // Entering (or retrying) a fragment: legible book, active line, white line.
    els.book.classList.remove("reading");
    setCurrentLine(fi);
    clearLineColors(fi);
    await speakWithKaraoke(question.fragments[fi].text, token, { spans: lineWordSpans(fi) });
    if (token !== flowToken) return;

    const outcome = await captureAttempt(question.fragments[fi].text, "fragment", token);
    if (token !== flowToken) return;

    setPhase("feedback");
    lastAttempt = outcome;
    attemptCount++;
    renderFeedback(outcome, fi);

    if (outcome.passed) {
      // Feature 110: pass → synthesized chime (no spoken congratulation),
      // then advance straight to the next fragment — its read is verbatim
      // `fragment.text`, no intro phrase (the loop reads it below).
      passedFragments.push(fi);
      fragmentScores.push(outcome.score);
      await playSuccessChime();
      if (token !== flowToken) return;
      fi++;
      continue;
    }

    // Fail (CU2 alt flow): replay the user's take, speak the coach tips and
    // re-read the SAME fragment.
    if (lastWavBlob) {
      await replayUserWav(lastWavBlob);
      if (token !== flowToken) return;
    }
    await speak(outcome.coachLine, token);
    if (token !== flowToken) return;
  }

  // FULL — the user reads the whole answer until it passes (same loop as the
  // cu2.ts reducer: fullAnswer → feedback → fullAnswer on failure). Every
  // round repaints the book from scratch, so the answer starts white.
  fullAttemptCount = 0;
  fullPassed = false;
  let fullOutcome;
  do {
    setPhase("fullAnswer");
    renderFull();
    await speak(fullLine, token);
    if (token !== flowToken) return;

    fullOutcome = await captureAttempt(question.answer, "full", token);
    if (token !== flowToken) return;

    setPhase("feedback");
    lastAttempt = fullOutcome;
    fullAttemptCount++;
    fullPassed = fullOutcome.passed || fullPassed;
    renderFeedback(fullOutcome, -1);

    if (fullOutcome.passed) {
      // Feature 110: pass → chime, then close the session without the spoken
      // congratulation (the DONE panel is the reward).
      await playSuccessChime();
      if (token !== flowToken) return;
      break;
    }

    if (lastWavBlob) {
      await replayUserWav(lastWavBlob);
      if (token !== flowToken) return;
    }
    await speak(fullOutcome.coachLine, token);
    if (token !== flowToken) return;
  } while (!fullOutcome.passed);

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
 * the session snapshot (fresh explainLine/fullLine/autoAdvance + the
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
// Adaptive-difficulty pill (feature 107)
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Play the success chime of a passed attempt at the coach volume (feature
 * 110), time-boxed: the race settles even if the chime never resolves, so
 * phase `feedback` cannot hang on a sound that will not play. If the cap wins,
 * the chime is silenced so it can never start under the next read (chime and
 * TTS must not overlap). Callers must re-check `flowToken` after awaiting.
 */
async function playSuccessChime() {
  const ended = playChime({ kind: "pass", volume: volumeSetting() }).then(() => "ended");
  const winner = await Promise.race([ended, sleep(CHIME_MAX_MS).then(() => "capped")]);
  if (winner === "capped") stopChime();
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
  coachSpeaking = true;
  try {
    const ok = await tts.speak(text, { rate: dock?.getRate() ?? 1, volume: volumeSetting() });
    if (token !== flowToken) return false;
    dock?.setMode("idle");
    return ok;
  } finally {
    // Karaoke interaction (112/113) re-opens the moment the coach stops.
    coachSpeaking = false;
  }
}

/**
 * Speak a line through the server TTS and light the karaoke words live.
 *
 * Fetches the TTS audio directly so we can decode its duration and highlight
 * the spans linearly (Piper emits no word timestamps). `spans` defaults to
 * every word of the book (the full model answer); pass a single line's spans
 * to light only that fragment. Whatever path the read takes — finished, error
 * or fallback to plain `tts.speak()` — the spans return to white at the end.
 *
 * @param {string} text - what the coach reads
 * @param {number} token - flow cancellation token
 * @param {{ spans?: Element[] | null }} [opts] - spans to light while reading
 */
async function speakWithKaraoke(text, token, { spans = null } = {}) {
  dock?.setMode("ai");
  coachSpeaking = true;
  const activeSpans = spans ?? allWordSpans();
  const params = new URLSearchParams({ text });
  const rate = dock?.getRate() ?? 1;
  if (rate !== 1) params.set("rate", String(rate));

  let audio = null;
  let stopProgress = () => {};
  try {
    const res = await fetch(`/api/tts?${params.toString()}`);
    // The flow may have been cancelled while the audio was being fetched.
    if (token !== flowToken) return;
    if (!res.ok) throw new Error("tts-unavailable");
    const blob = await res.blob();
    if (token !== flowToken) return;
    const url = URL.createObjectURL(blob);
    audio = new Audio(url);
    // The engine defaults to 1.0: without this the model answer and every
    // fragment re-read played at 100% regardless of the user's setting.
    audio.volume = volumeSetting();
    readAudio = audio;
    let durationMs = 0;
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
      const done = () => {
        stopKaraokeRead = null;
        resolve();
      };
      // Exposed so the dock's retry pill and `cancelFlow()` can end the read.
      stopKaraokeRead = () => {
        audio.pause();
        done();
      };
      audio.onended = done;
      audio.onerror = done;
      if (token !== flowToken) {
        done();
        return;
      }
      audio.play().catch(done);
      if (durationMs > 0) stopProgress = animateWordProgress(durationMs, token, activeSpans);
    });
  } catch {
    // Server TTS unavailable → plain browser speech, no progress.
    if (token !== flowToken) return;
    await tts.speak(text, { rate, volume: volumeSetting() });
  } finally {
    stopKaraokeRead = null;
    coachSpeaking = false; // karaoke interaction (112/113) re-opens here
    if (readAudio === audio) readAudio = null;
    stopProgress();
    activeSpans.forEach((s) => s.classList.remove("kw-spoken"));
    if (audio) URL.revokeObjectURL(audio.src);
  }
  if (token !== flowToken) return;
  dock?.setMode("idle");
}

/**
 * Highlight the given karaoke spans linearly over `durationMs` (rAF loop).
 *
 * @param {number} durationMs - duration of the read
 * @param {number} token - flow cancellation token
 * @param {Element[]} spans - spans to light, in reading order
 * @returns {() => void} `stop()` — cancels the loop (safe to call twice)
 */
function animateWordProgress(durationMs, token, spans) {
  if (!spans.length) return () => {};
  const start = performance.now();
  let cancelled = false;
  const tick = () => {
    if (cancelled || token !== flowToken) return;
    const t = Math.min(1, (performance.now() - start) / durationMs);
    const count = Math.floor(t * spans.length);
    spans.forEach((s, i) => s.classList.toggle("kw-spoken", i < count));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return () => {
    cancelled = true;
  };
}

// ---------------------------------------------------------------------------
// Attempt capture (push-to-talk → whisper / browser STT → /api/attempt)
// ---------------------------------------------------------------------------

/**
 * Capture one attempt (fragment or full answer) and return its outcome.
 *
 * Both engines are push-to-talk (feature 111): the mic never starts by
 * itself — the capture starts while the user holds the dock button or the
 * SPACE key and is cut the moment the last of them is released (or at the
 * 3 s/word ceiling). Engine selection: whisper (record WAV → audio attempt)
 * when ready, else BrowserSTT (live speech → text attempt). If the whisper
 * attempt fails mid-flight, fall back to BrowserSTT + text mode.
 *
 * @param {string} target - text being captured (ceiling = 3000 ms × words)
 * @param {"fragment"|"full"} kind - which line the attempt is scored against
 * @param {number} token - flow cancellation token
 * @returns {Promise<object|null>} the attempt outcome, or null when cancelled
 */
async function captureAttempt(target, kind, token) {
  // The replay must always belong to THIS attempt: a browser-STT turn records
  // no WAV, so it must not fall back to the previous fragment's recording.
  lastWavBlob = null;
  const sttChoice = getLocal("stt", null) ?? localStorage.getItem("stt-choice");
  const stt = pickStt(health, sttChoice);
  if (stt === "whisper") {
    const { blob, timedOut, error } = await waitForUserRecording(target, token);
    if (token !== flowToken) return null;
    if (error) throw new Error(error);
    if (timedOut) return timedOutOutcome(target, kind);
    lastWavBlob = blob;
    try {
      return await submitAudio(blob, target, kind);
    } catch (err) {
      // whisper failed → browser STT fallback (text mode).
      const text = await captureBrowserSpeech(target, token);
      if (token !== flowToken) return null;
      if (!text) return timedOutOutcome(target, kind);
      return await submitText(text, target, kind);
    }
  }
  const text = await captureBrowserSpeech(target, token);
  if (token !== flowToken) return null;
  if (!text) return timedOutOutcome(target, kind);
  return await submitText(text, target, kind);
}

/**
 * Arm one push-to-talk whisper turn (feature 111): the mic waits for the user
 * to hold the dock button or the SPACE key and never listens by itself.
 *
 * The turn ends when:
 *   - the last held trigger is released → capture + evaluate,
 *   - `maxCaptureMs(target)` (3000 ms per word of the target) elapses →
 *     capture + evaluate, exactly like a release,
 *   - `cancelFlow()` cuts it → the audio is discarded and never evaluated.
 *
 * A press shorter than `MIN_PRESS_MS` that captured no usable audio is an
 * accidental tap: it is discarded and the turn keeps waiting — no penalty,
 * no evaluation, no "I didn't hear you". Every other press is evaluated on
 * release. There is no silence/no-speech guard anymore: the turn waits as
 * long as the user needs before pressing.
 *
 * The orb is a status indicator driven through `dock.setMode`/
 * `setOrbEnabled`: armed (green pulse) while the turn waits, amber with rings
 * and the live VU meter while the capture is held.
 *
 * @param {string} target - text being captured (ceiling = 3000 ms × words)
 * @param {number} token - flow cancellation token
 * @returns {Promise<{blob: Blob|null, timedOut: boolean, error?: string}>}
 */
function waitForUserRecording(target, token) {
  return new Promise((resolve) => {
    /** @type {WaveRecorder|null} */
    let recorder = null;
    let settled = false;
    /** Promise of the in-flight `recorder.start()` (null until first press). */
    let startPromise = null;
    /** Timer that auto-cuts the capture at the per-word ceiling. */
    let ceilingTimer = null;
    /** @type {PushToTalk|null} */
    let ptt = null;

    const clearCeiling = () => {
      clearTimeout(ceilingTimer);
      ceilingTimer = null;
    };

    /** End the turn: release mic/timers/counters and hand `value` back. */
    const settle = (value, { cancel = true } = {}) => {
      if (settled) return;
      settled = true;
      clearCeiling();
      if (activePtt) {
        activePtt.cancel();
        activePtt = null;
      }
      cancelPendingTurn = null;
      if (cancel) recorder?.cancel();
      dock?.setMode("idle");
      dock?.setOrbEnabled(false);
      dock?.setRetryEnabled(false);
      dock?.setMicLabel(MIC_IDLE_LABEL);
      resolve(value);
    };

    /** Cut the capture and resolve with its WAV (release or ceiling). */
    const settleWithBlob = async () => {
      try {
        if (startPromise) await startPromise;
      } catch {
        // start() failed: settle() already reported the mic error.
      }
      if (settled) return;
      const blob = recorder ? recorder.stop() : null;
      settle({ blob, timedOut: false }, { cancel: false });
    };

    const ceilingMs = maxCaptureMs(target);
    recorder = new WaveRecorder({ deviceId: getLocal("mic", "") || undefined });
    // Live VU meter while the capture is held (informative, fan included).
    recorder.onLevel = (db) => dock?.setVU(db);

    ptt = new PushToTalk({
      maxCaptureMs: ceilingMs,
      now: () => performance.now(),
      // "Usable audio" for the accidental-tap guard: at least one frame was
      // buffered (`WaveRecorder.stop()` will report the same count).
      hasAudio: () => (recorder?.samples.length ?? 0) > 0,
      onStart: () => {
        dock?.setMode("recording");
        dock?.setMicLabel(PTT_RECORD_LABEL);
        // The capture cuts itself at the ceiling, like a release would.
        ceilingTimer = setTimeout(() => ptt.tick(), ceilingMs);
        startPromise = recorder.start().catch(() =>
          settle({ blob: null, timedOut: false, error: MIC_UNAVAILABLE }),
        );
      },
      onCut: () => {
        void settleWithBlob();
      },
      onDiscard: () => {
        // Accidental tap: drop the frames and go back to waiting. An
        // in-flight start() is awaited first so the graph is never torn down
        // from under it, and a press that took over meanwhile keeps its audio.
        clearCeiling();
        dock?.setMode("idle");
        dock?.setMicLabel(PTT_WAIT_LABEL);
        void (async () => {
          try {
            if (startPromise) await startPromise;
          } catch {
            return; // start() failed → settle() already reported it
          }
          if (settled || ptt.state !== "idle") return;
          recorder?.discard();
        })();
      },
    });

    // `cancelFlow()` cuts the turn short: mic, timers and the press counter
    // all hang off `settled`.
    cancelPendingTurn = () => settle({ blob: null, timedOut: true });
    activePtt = ptt;

    dock?.setOrbEnabled(true);
    dock?.setRetryEnabled(true);
    dock?.setMicLabel(PTT_WAIT_LABEL);

    // Prewarm the mic NOW (feature 111 non-functional req): getUserMedia
    // costs ~200-500 ms and would otherwise eat the beginning of the press.
    recorder.prewarm().then(
      () => {
        // The turn was cancelled while getUserMedia was in flight: the stream
        // appeared after settle(), so release it here.
        if (settled) recorder?.cancel();
      },
      () => settle({ blob: null, timedOut: false, error: MIC_UNAVAILABLE }),
    );
  });
}

/**
 * Capture speech via the browser Web Speech API (push-to-talk fallback).
 *
 * Same contract as the whisper turn (feature 111): recognition starts on the
 * press and stops on the release (`recognition.stop()`), with the same
 * per-word ceiling and the same accidental-tap guard. There is no auto-start,
 * no beep and no no-speech guard: the turn waits for the press. The existing
 * `onend`/error handling is kept — if the browser ends the recognition on its
 * own, the turn resolves with whatever was heard.
 *
 * @param {string} target - text being captured (ceiling = 3000 ms × words)
 * @param {number} token - flow cancellation token
 * @returns {Promise<string|null>} transcription, or null when nothing was heard
 */
function captureBrowserSpeech(target, token) {
  return new Promise((resolve) => {
    let done = false;
    /** True while the `onend` of a discarded accidental tap must be ignored. */
    let discarding = false;
    /** True once `stt.start()` ran for this turn. */
    let started = false;
    let ceilingTimer = null;

    const clearCeiling = () => {
      clearTimeout(ceilingTimer);
      ceilingTimer = null;
    };

    const finish = (value) => {
      if (done) return;
      done = true;
      clearCeiling();
      if (activePtt) {
        activePtt.cancel();
        activePtt = null;
      }
      cancelPendingTurn = null;
      dock?.setMode("idle");
      dock?.setOrbEnabled(false);
      dock?.setRetryEnabled(false);
      dock?.setMicLabel(MIC_IDLE_LABEL);
      resolve(value);
    };

    const stt = new BrowserSTT({
      onFinal: () => {},
      onEnd: () => {
        if (discarding) return;
        finish(stt.result() || null);
      },
      onError: () => {
        if (discarding) return;
        finish(null);
      },
    });
    if (!stt.isSupported() || token !== flowToken) {
      finish(null);
      return;
    }

    // `cancelFlow()` aborts recognition and settles the turn so the pending
    // promise cannot outlive the session.
    cancelPendingTurn = () => {
      stt.abort();
      finish(null);
    };

    const ceilingMs = maxCaptureMs(target);
    const ptt = new PushToTalk({
      maxCaptureMs: ceilingMs,
      now: () => performance.now(),
      // "Usable audio" for the accidental-tap guard: the recognizer already
      // returned something (it only settles once the recognition stops).
      hasAudio: () => started && Boolean(stt.result()),
      onStart: () => {
        started = true;
        ceilingTimer = setTimeout(() => ptt.tick(), ceilingMs);
        dock?.setMode("recording");
        dock?.setMicLabel(PTT_RECORD_LABEL);
        stt.start();
      },
      onCut: () => {
        // Release/ceiling: stop now; `onend` resolves the turn with the text.
        stt.stop();
      },
      onDiscard: () => {
        // Accidental tap: abort the recognition and keep waiting. `abort()`
        // fires `onend` synchronously while `discarding` is set, so the tap
        // can never settle the turn; when nothing was listening the flag is
        // simply cleared here.
        clearCeiling();
        dock?.setMode("idle");
        dock?.setMicLabel(PTT_WAIT_LABEL);
        discarding = true;
        stt.abort();
        discarding = false;
        started = false;
      },
    });

    activePtt = ptt;
    dock?.setOrbEnabled(true);
    dock?.setRetryEnabled(true);
    dock?.setMicLabel(PTT_WAIT_LABEL);
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
    heard: typeof json.text === "string" ? json.text : "",
    missing: Array.isArray(json.missing) ? json.missing : [],
    added: Array.isArray(json.addedWords) ? json.addedWords : [],
    coachLine: json.coachLine ?? "",
  };
}

/**
 * Outcome for a turn that ended without usable input (cancelled turn, or the
 * browser recognizer returned nothing after a real — non-accidental — press).
 */
function timedOutOutcome(target, kind) {
  return {
    kind,
    score: 0,
    verdict: "retry",
    passed: false,
    words: [],
    target,
    timedOut: true,
    missing: [],
    added: [],
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

/**
 * MODEL phase: build the karaoke book (one line per fragment).
 *
 * The book enters `reading` mode: no line is active yet and every line stays
 * white and legible while the coach reads the whole model answer.
 */
function renderKaraokeBook() {
  els.book.hidden = false;
  els.book.innerHTML = "";
  for (let i = 0; i < fragmentCount; i++) {
    els.book.appendChild(buildLine(i, question.fragments[i].text));
  }
  els.book.classList.add("reading");
}

/**
 * Rebuild the book from the current phase + last attempt (settings listener,
 * `renderFull()`):
 *   - full answer in flight → a single `current full` line, white;
 *   - model/explaining → one line per fragment with the book in `reading`
 *     mode (every line legible while the coach reads the whole answer);
 *   - any other phase → one line per fragment, active line highlighted.
 *
 * Traffic-light colors are restored only during FEEDBACK, for the exact line
 * the last attempt was scored against (the line stays white while the coach
 * reads and while the user speaks).
 */
function rebuildBook() {
  if (!els?.book || !question) return;
  const scored = phase === "feedback" && Boolean(lastAttempt);
  const isFull = phase === "fullAnswer" || (scored && lastAttemptLineIndex === -1);
  const reading = phase === "model" || phase === "explaining";
  els.book.innerHTML = "";
  if (isFull) {
    const line = buildLine(0, question.answer);
    line.classList.add("current", "full");
    els.book.appendChild(line);
    els.book.classList.remove("reading");
    if (scored) colorWords(lastAttempt, -1);
    return;
  }
  for (let i = 0; i < fragmentCount; i++) {
    els.book.appendChild(buildLine(i, question.fragments[i].text));
  }
  if (reading) {
    els.book.classList.add("reading");
    return;
  }
  els.book.classList.remove("reading");
  setCurrentLine(fragmentIndex);
  if (scored && lastAttemptLineIndex >= 0) colorWords(lastAttempt, lastAttemptLineIndex);
}

/** Build one karaoke line of word spans (+ optional pronunciation annotation). */
function buildLine(index, text) {
  const words = tokenizeWords(text);
  const line = h("div", { class: "karaoke-line", dataset: { index: String(index) } });
  for (const w of words) {
    const pron = respellFor(w);
    const wrap = h("span", { class: "kw-wrap" }, [
      h("span", { class: "kw", dataset: { word: w } }, escapeHtml(w)),
      ...(pron
        ? [h("span", { class: "kw-ipa" + (pron.approximate ? " approx" : "") }, escapeHtml((pron.approximate ? "~" : "") + pron.text))]
        : []),
    ]);
    line.appendChild(wrap);
  }
  return line;
}

/** Mark line `index` as current; others past/future, and keep it in view. */
function setCurrentLine(index) {
  const lines = els.book.querySelectorAll(".karaoke-line");
  lines.forEach((line, i) => {
    line.classList.toggle("past", i < index);
    line.classList.toggle("current", i === index);
    line.classList.toggle("future", i > index);
  });
  try {
    lines[index]?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  } catch {
    // scrollIntoView unavailable → the line stays where it is
  }
}

/** All word spans in the book, in order (full-answer coloring/progress). */
function allWordSpans() {
  return [...els.book.querySelectorAll(".kw")];
}

/** Word spans of one karaoke line (empty when that line is not rendered). */
function lineWordSpans(index) {
  return [...els.book.querySelectorAll(`.karaoke-line[data-index="${index}"] .kw`)];
}

/** Spans an attempt colors: one line, or the whole book for the full answer. */
function spansForLine(index) {
  return index === -1 ? allWordSpans() : lineWordSpans(index);
}

/** Clear every color class from one line's spans (back to white). */
function clearLineColors(index) {
  for (const span of lineWordSpans(index)) {
    span.classList.remove("kw-green", "kw-amber", "kw-red", "kw-spoken");
  }
}

/**
 * Paint the traffic-light colors of `outcome` on ONE line's spans.
 *
 * `outcome.words` is local to the evaluated target (fragment or full answer),
 * so it is paired against the spans of `lineIndex` only: spans of other lines
 * keep the colors they already have.
 *
 * @param {{ words?: Array<{ status?: string }> }} outcome - scored attempt
 * @param {number} lineIndex - fragment index, or `-1` for the full answer
 */
function colorWords(outcome, lineIndex) {
  const spans = spansForLine(lineIndex);
  const statuses = lineColorStatuses(outcome.words ?? [], spans.length);
  spans.forEach((s, i) => {
    s.classList.remove("kw-green", "kw-amber", "kw-red", "kw-spoken");
    const status = statuses[i];
    if (!liveHighlight || !status) return;
    s.classList.add(`kw-${status}`);
  });
}

/** FEEDBACK phase: color the evaluated line + show the feedback chip. */
function renderFeedback(outcome, lineIndex) {
  lastAttemptLineIndex = lineIndex;
  colorWords(outcome, lineIndex);
  const passed = outcome.passed;
  const missingFocus = (outcome.missing ?? []).slice(0, 2).join(", ");
  const addedFocus = (outcome.added ?? []).slice(0, 2).join(", ");
  const focus = missingFocus || (addedFocus ? `palabras de más: ${addedFocus}` : "") || "pronunciación";
  const chipText = passed
    ? `Buen flujo · ${outcome.score}%`
    : `Foco en ${focus || "pronunciación"} · ${outcome.score}%`;
  const parts = [h("span", { class: "feedback-chip-main" }, chipText)];
  if (!passed && outcome.heard) {
    parts.push(h("span", { class: "feedback-chip-heard" }, ` Escuché: “${escapeHtml(outcome.heard)}”`));
  }
  els.feedbackChip.textContent = "";
  els.feedbackChip.append(...parts);
  els.feedbackChip.hidden = false;
  els.feedbackChip.classList.toggle("ok", passed);
  els.feedbackChip.classList.toggle("bad", !passed);
}

/** FULL phase: whole answer as one active block (colors cleared → white). */
function renderFull() {
  els.book.classList.remove("reading");
  rebuildBook();
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
// User WAV replay (retry: hear yourself while the colors stay on screen)
// ---------------------------------------------------------------------------

/**
 * Replay the user's last recording while the traffic-light colors of the
 * attempt stay visible.
 *
 * There is no lyric animation here on purpose: the line was already scored
 * with green/amber/red, and lighting it blue would hide the feedback the
 * colors exist to give.
 */
function replayUserWav(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      stopReplay = null;
      audio.pause();
      URL.revokeObjectURL(url);
      resolve();
    };
    // Exposed so the dock's retry pill and `cancelFlow()` can cut it short.
    stopReplay = finish;
    audio.onended = finish;
    audio.onerror = finish;
    audio.play().catch(finish);
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
  applyLiveVolume();
}

/**
 * Re-apply the coach volume to whatever is speaking right now, so moving the
 * settings slider mid-sentence takes effect immediately instead of only on
 * the next read.
 */
function applyLiveVolume() {
  const v = volumeSetting();
  tts?.setVolume(v);
  if (readAudio) readAudio.volume = v;
}

/**
 * Coach volume (0.1–1) from the device prefs (spec 108).
 *
 * `volumeFactor` enforces the 10% floor, so a legacy `0` in localStorage can
 * never mute the coach.
 * @returns {number}
 */
function volumeSetting() {
  return volumeFactor(getLocal("volume", 100));
}
