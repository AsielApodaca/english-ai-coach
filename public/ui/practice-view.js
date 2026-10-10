/**
 * Karaoke practice view (feature 105 / CU2) — the live practice stage.
 *
 * Imperative async flow mirroring the pure state machine in `src/lib/practice/karaoke.ts`
 * (the reducer there is the canonical, unit-tested spec; this view is the
 * effectful layer that speaks, records and calls the API):
 *
 *   question → model → repeatingFragment ⇄ feedback
 *        → fullAnswer → done
 *
 * The session opens straight at the question (feature 115): the first sound
 * the coach makes is the question itself, and the model answer hands over
 * directly to the first fragment (highlighted visually, never announced).
 *
 * The coach speaks each line via the server TTS (BrowserTTS) and the user
 * repeats fragments under their own control: capture is PUSH-TO-TALK (feature
 * 111) — the mic never starts by itself, it starts while the dock mic button
 * or the SPACE key is held down and is cut the moment the last of them is
 * released (or at the 3 s/word ceiling). Silence detection plays no part in
 * ending the turn anymore. Attempts go to POST /api/attempt (whisper with word
 * timestamps; text fallback via BrowserSTT when whisper is unavailable), and
 * the karaoke book colors each word green/amber/red. Feature 116: that paint no
 * longer waits for the LLM — the response carries the deterministic evaluation
 * plus an `attemptId`, and the refinement (forced-amber recolor + LLM coach
 * line) is fetched in background from GET /api/attempt/:id/feedback. A failed
 * attempt (score < passThreshold) retries the same fragment; after the last
 * fragment passes, the user reads the whole answer and the session is done.
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
import { splitForTts } from "../speech/prosody.js";
import { tryNormalizeElement, setElementVolume, releaseElement } from "../speech/level.js";
import { respellFor } from "./ipa.js";
import { tokenizeWords, lineColorStatuses } from "./karaoke-color.js";
import { closeLookupPopover, initLookupPopover } from "./lookup-popover.js";
import { createWordClickHandler, tokensFromRange } from "./word-click.js";
import { buildWordStarts } from "./karaoke-schedule.js";
import { createLivePositionSource, matchLiveWords } from "./live-position.js";
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

/** Defensive cap on the chime so phase `feedback` can never hang. */
const CHIME_MAX_MS = 500;

/**
 * Cap on waiting for the LLM refinement before speaking the coach line
 * (feature 116). The wait starts when the feedback is PAINTED, so it is
 * overlapped with the fail chime and only the remainder is paid right
 * before `speak()`. (The user-WAV replay that used to fill that window was
 * removed: the take is on-demand via the feedback chip's speaker button.)
 */
const REFINE_WAIT_MS = 10000;

// ---------------------------------------------------------------------------
// Live window pump (feature 121 v2) — cumulative windows to /api/transcribe-partial
// ---------------------------------------------------------------------------

/** Minimum NEW audio per window request (ms captured since the last send). */
const MIN_NEW_AUDIO_MS = 750;

/** Minimum wall-clock gap between two window requests. */
const MIN_WINDOW_INTERVAL_MS = 1250;

/** How often the window pump re-evaluates its gates. */
const PUMP_TICK_MS = 250;

/** RMS floor (dBFS) under which new audio counts as silence — never sent. */
const PARTIAL_SILENCE_RMS_DB = -45;

/**
 * Bottom mask band of `.karaoke-book` in px — mirrors its `scroll-padding-block`
 * (the transparent gradient band the reading row must stay clear of).
 */
const LIVE_SCROLL_MASK_PX = 48;

/**
 * Rows kept visible BELOW the reading row: the live scroll fires and rests
 * when the active row reaches the ANTEPENULTIMATE visible row of the book,
 * so the line being read never rides the bottom edge of the viewport.
 */
const LIVE_SCROLL_KEPT_ROWS = 2;

// ---------------------------------------------------------------------------
// Module state (mirrors PracticeState in karaoke.ts)
// ---------------------------------------------------------------------------

/** @type {"question"|"model"|"repeatingFragment"|"feedback"|"fullAnswer"|"done"} */
let phase = "question";
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

/** Last recorded WAV blob (played on demand via the feedback chip's speaker). */
let lastWavBlob = null;

/**
 * Line the last attempt was scored against: `>= 0` fragment index, `-1` the
 * full answer, `-2` no attempt yet (colors must not be restored from it).
 */
let lastAttemptLineIndex = -2;

/**
 * `attemptId` of the attempt currently painted (feature 116): a landing
 * refinement may only recolor/refresh the line when it still identifies THIS
 * attempt. Null when there is none (blank transcript, timed-out turn).
 */
let lastAttemptId = null;

/** Pending karaoke read; the dock's retry pill can cut it short. */
let stopKaraokeRead = null;

/**
 * The `<audio>` element of the read in flight (karaoke reads build their own
 * element instead of going through `BrowserTTS`), so a settings change can
 * re-apply the volume while it plays.
 * @type {HTMLAudioElement|null}
 */
let readAudio = null;

/** Pending user-WAV replay; the feedback chip's speaker, the retry pill and `cancelFlow()` can cut it. */
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

/**
 * Live position of the FULL-answer capture in flight (feature 121), or null
 * outside one (and always null for fragment captures: their short lines
 * already scroll through `setCurrentLine`). Routes the PTT press (`begin`),
 * the Web Speech interims (`feed`) and — on the whisper route — the
 * cumulative-window pump into a `LivePositionSource`, and owns the
 * provisional `kw-live`/`kw-live-spoken`/`kw-live-missing` paint + auto-scroll
 * of the karaoke book. `attachRecorder` hands the pump the capture's
 * `WaveRecorder` (settle/finally always dispose the whole thing).
 * @type {{ begin: () => void, feed: (text: string) => void, dispose: () => void, attachRecorder?: (recorder: import("../speech/recorder-wave.js").WaveRecorder|null) => void }|null}
 */
let livePosition = null;

/** True while the coach is reading a line (blocks karaoke interaction). */
let coachSpeaking = false;

/** Word-click listeners (feature 113) installed once, at document level. */
let wordClickInstalled = false;

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

  // Keyboard scroll guard for the model answer (feature 121): with a
  // selection inside `.karaoke-book`, scroll keys never scroll it — only the
  // mouse wheel does — so keyboard defaults cannot fight the live auto-scroll.
  window.addEventListener("keydown", onBookScrollGuard);

  // Word lookup popover (feature 112): one shared node + delegated listeners
  // inside the module (survives rebuildBook), gated by the same
  // coach/capture rule as the word interactions of 111/113.
  initLookupPopover({ isAllowed: canInteractWithWords });

  // Word click → pronunciation (feature 113): document-level delegated
  // listeners (also survive rebuildBook), fed the SAME gate as 112 and
  // re-checking it inside the handler.
  installWordClick();
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
 * Guards: text entry keeps typing spaces, and outside a capture SPACE keeps
 * its default meaning (scrolling / button activation). Inside one it is fully
 * consumed — INCLUDING the browser's auto-repeat: `preventDefault()` runs
 * before the `event.repeat` guard, because the default action of every
 * repeated keydown is also scrolling. Skipping it let the held key scroll the
 * model answer against the live auto-scroll of feature 121 (the book jumped
 * up/down for the whole utterance). Auto-repeat still never starts a second
 * capture.
 *
 * @param {KeyboardEvent} event
 */
function onPttKeyDown(event) {
  if (!isSpaceKey(event)) return;
  if (isTextEntryTarget(event.target)) return;
  if (!activePtt) return;
  event.preventDefault();
  if (event.repeat) return;
  // Capture start closes the lookup popover (feature 112).
  closeLookupPopover();
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

/** `event.key` spellings whose browser default action scrolls (feature 121). */
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End"]);

/**
 * Keyboard scroll guard for the model answer (feature 121 regression fix).
 *
 * The karaoke book is its own scroller (`overflow-y: auto`, 46vh): as soon as
 * a selection sits inside it, the usual scroll keys (SPACE, arrows,
 * PageUp/PageDown, Home/End) make the browser scroll — and that default fights
 * the live auto-scroll of a full-answer capture, bouncing the book up and down.
 * This guard consumes ONLY those keyboard defaults, and ONLY while the
 * selection lives inside `.karaoke-book`: the mouse wheel keeps working, and
 * the rest of the app (long config pages, settings) keeps its normal keyboard
 * scrolling.
 *
 * SPACE during an armed turn (auto-repeat included) is already consumed by
 * `onPttKeyDown`; this guard covers the remaining keys and SPACE pressed with
 * a selection while no turn is in flight. Text-entry targets are left alone so
 * SPACE/arrows keep typing and moving the caret in inputs.
 *
 * @param {KeyboardEvent} event
 */
function onBookScrollGuard(event) {
  if (event.defaultPrevented) return;
  if (!isSpaceKey(event) && !SCROLL_KEYS.has(event.key)) return;
  if (isTextEntryTarget(event.target)) return;
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const node = selection.getRangeAt(0).commonAncestorContainer;
  const element = node.nodeType === 1 ? /** @type {Element} */ (node) : node.parentElement;
  if (!element?.closest(".karaoke-book")) return;
  event.preventDefault();
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

/**
 * Mirror the shared gate onto the book's `data-interactive="on|off"` flag
 * (feature 113): the FIRST line of defense is CSS — no hover affordance and
 * no pointer hits on the words while the coach reads or a capture is held.
 * The listeners still re-check `canInteractWithWords()` inside their
 * handlers, so a stale flag, a programmatic click or a timing race can never
 * pronounce a word (second line of defense, spec 113).
 *
 * Safe to call at any time: it is a pure projection of the current state and
 * a no-op before the book exists (question phase, review mode).
 */
function syncBookInteraction() {
  if (!els?.book) return;
  els.book.setAttribute("data-interactive", canInteractWithWords() ? "on" : "off");
}

/**
 * Install the document-level word-click listeners (feature 113), once.
 *
 * The handler gets the shared gate + the pronunciation side-effect + the
 * selection/scope probes of "click a selection → hear the phrase": it never
 * touches the flow (no `TTS_END`, no phase advance, no turn cancel).
 */
function installWordClick() {
  if (wordClickInstalled) return;
  wordClickInstalled = true;
  const handler = createWordClickHandler({
    isAllowed: canInteractWithWords,
    pronounce: pronounceWord,
    selection: selectedWordTokens,
    isScope: isWordScope,
    now: () => performance.now(),
  });
  document.addEventListener("pointerdown", handler.onPointerDown);
  document.addEventListener("click", handler.onClick);
}

// ---------------------------------------------------------------------------
// Flow lifecycle
// ---------------------------------------------------------------------------

/** Cancel the running flow: stop audio, recording, timers and the dock. */
function cancelFlow() {
  flowToken++;
  clearTimeout(autoAdvanceTimer);
  clearTimeout(adjustmentTimer);
  closeLookupPopover();
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
  // The flow is gone: no read and no capture can be holding the gate closed.
  coachSpeaking = false;
  syncBookInteraction();
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
  phase = "question";
  fragmentCount = 0;
  fragmentIndex = 0;
  attemptCount = 0;
  passedFragments = [];
  fragmentScores = [];
  lastAttempt = null;
  lastAttemptLineIndex = -2;
  lastAttemptId = null;
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
  fullLine = data.fullLine;
  passThreshold = data.passThreshold ?? 70;
  autoAdvance = data.autoAdvance ?? false;
  fragmentCount = question?.fragments?.length ?? 0;
}

// ---------------------------------------------------------------------------
// The CU2 flow (imperative port of the karaoke.ts reducer)
// ---------------------------------------------------------------------------

async function runFlow(token) {
  // Feature 115: no opening speech — the flow starts at the question (the
  // loop below renders and reads it right away, so the panel/orb/dock show
  // the question state immediately). Resume only shifts where the fragment
  // loop starts; it no longer changes whether a prelude is spoken (none is).
  await runQuestionLoop(token, { resume: isResume() });
}

/**
 * True when the session has progress to resume (feature 109): more than one
 * question, or the last question already has attempts / a full answer / an
 * evaluation. A fresh session starts at the first fragment.
 */
function isResume() {
  const q = session?.questions?.at(-1);
  return (
    (session?.questions?.length ?? 0) > 1 ||
    Boolean(q && (q.fragments.some((f) => f.attempts.length > 0) || q.fullAttempt || q.eval))
  );
}

/**
 * One question pass: question → model → fragments → full → done. Reused by
 * `nextQuestion()` for the continuous session (feature 107). When `resume`
 * is true (feature 109) the fragment loop starts at the first unpassed
 * fragment instead of fragment 0.
 */
async function runQuestionLoop(token, { resume = false } = {}) {
  // A new question starts without a scorable attempt to re-color.
  lastAttempt = null;
  lastAttemptLineIndex = -2;
  lastAttemptId = null;

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
    // Feature 116: this line's paint is about to be cleared — a refinement
    // still in flight for it must not recolor it afterwards (the line has to
    // stay white while the coach reads and the user speaks).
    if (lastAttemptLineIndex === fi) lastAttemptId = null;
    clearLineColors(fi);
    await speakWithKaraoke(question.fragments[fi].text, token, { spans: lineWordSpans(fi) });
    if (token !== flowToken) return;

    const outcome = await captureAttempt(question.fragments[fi].text, "fragment", token);
    if (token !== flowToken) return;

    setPhase("feedback");
    lastAttempt = outcome;
    attemptCount++;
    renderFeedback(outcome, fi);
    // Feature 116: ask for the LLM refinement right away (NO await) — it
    // repaints the line with the forced-amber words when it lands and is only
    // awaited before speaking, on the fail path.
    const refinement = startRefinement(outcome, fi, token);

    if (outcome.passed) {
      // Feature 110: pass → synthesized chime (no spoken congratulation),
      // then advance straight to the next fragment — its read is verbatim
      // `fragment.text`, with no spoken preamble (the loop reads it below).
      passedFragments.push(fi);
      fragmentScores.push(outcome.score);
      await playAttemptChime("pass");
      if (token !== flowToken) return;
      fi++;
      continue;
    }

    // Fail (CU2 alt flow): play the "incorrecto" chime (feature 110's module,
    // kind `fail`) where the old spoken opener (score + retry line) used to
    // be, speak the focus hint and re-read the SAME fragment. The user's take
    // is NOT replayed automatically anymore: the feedback chip carries a
    // speaker button to hear it on demand.
    await playAttemptChime("fail");
    if (token !== flowToken) return;
    // The refinement request has been in flight since the paint (overlapping
    // the chime): wait for it — capped — so the coach keeps its LLM-quality
    // line. On timeout, dead provider or a blank transcript (no attemptId)
    // the deterministic coachLine is spoken instead. An EMPTY line (nothing to
    // focus on) means silence: the fail chime already said it.
    const refined = await refinement;
    if (token !== flowToken) return;
    const refinedLine = refined?.coachLine || outcome.coachLine;
    if (refinedLine) await speak(refinedLine, token);
    if (token !== flowToken) return;
  }

  // FULL — the user reads the whole answer until it passes (same loop as the
  // karaoke.ts reducer: fullAnswer → feedback → fullAnswer on failure). Every
  // round repaints the book from scratch, so the answer starts white.
  fullAttemptCount = 0;
  fullPassed = false;
  let fullOutcome;
  do {
    // Feature 116: `renderFull()` rebuilds the book white — drop every
    // in-flight refinement (the previous full attempt, or a lingering
    // fragment one whose line no longer exists) before the read starts.
    lastAttemptId = null;
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
    // Feature 116: same as the fragment loop — no await, repainted on arrival.
    const refinement = startRefinement(fullOutcome, -1, token);

    if (fullOutcome.passed) {
      // Feature 110: pass → chime, then close the session without the spoken
      // congratulation (the DONE panel is the reward).
      await playAttemptChime("pass");
      if (token !== flowToken) return;
      break;
    }

    // Same fail treatment as the fragment loop: "incorrecto" chime →
    // focus hint (only when there is one) → retry the whole answer. The user's
    // take is on-demand via the feedback chip's speaker button.
    await playAttemptChime("fail");
    if (token !== flowToken) return;
    // Overlapped with the chime + paint since the request was fired; capped,
    // and falling back to the deterministic coachLine on timeout / dead
    // provider / blank input.
    const refined = await refinement;
    if (token !== flowToken) return;
    const refinedLine = refined?.coachLine || fullOutcome.coachLine;
    if (refinedLine) await speak(refinedLine, token);
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
 * the session snapshot (fresh fullLine/autoAdvance + the new last question)
 * and restart the question loop from the QUESTION phase.
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
  // Phase change closes the lookup popover (feature 112).
  closeLookupPopover();
  // Phase transitions are where the gate flips most often (112/113 flag).
  syncBookInteraction();
  dock?.setRetryEnabled(p === "feedback" || p === "repeatingFragment" || p === "fullAnswer");
}

// ---------------------------------------------------------------------------
// Adaptive-difficulty pill (feature 107)
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Play the attempt chime at the coach volume (feature 110), time-boxed: the
 * race settles even if the chime never resolves, so phase `feedback` cannot
 * hang on a sound that will not play. If the cap wins, the chime is silenced
 * so it can never start under the next read (chime and TTS must not overlap).
 * Callers must re-check `flowToken` after awaiting.
 *
 * @param {"pass"|"fail"} kind - `pass` on a cleared attempt, `fail` on a
 *   failed one (the sound that replaced the spoken "Almost there… percent")
 */
async function playAttemptChime(kind) {
  const ended = playChime({ kind, volume: volumeSetting() }).then(() => "ended");
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

/** Word surfaces where a native selection may be pronounced (features 112/113). */
const WORD_SCOPE_SEL = ".karaoke-book, .review-words";

/** Word spans read from a selection, in document order (karaoke + review). */
const WORD_SPAN_SEL = ".karaoke-book .kw, .review-words .kw";

/**
 * The coach voice chosen in settings (`engcoach.voice`, feature 114) or null
 * to keep the default engine chain ("Auto" / missing pref). Read live on every
 * read, so changing the select applies to the very next line.
 *
 * @returns {string|null} a Piper voice id, or null for the default chain
 */
function coachVoice() {
  const v = getLocal("voice", "auto");
  return typeof v === "string" && v && v !== "auto" ? v : null;
}

/**
 * Pronounce the karaoke word(s) clicked or selected (features 112/113) through the
 * EXISTING TTS chain — BrowserTTS (`GET /api/tts?…&rate=<dock tempo>`), with
 * the `speechSynthesis` fallback and silent degradation when no engine exists.
 * No third audio channel, no re-render, no flow event: a pure side-effect.
 *
 * Accepts ONE token (word click) or an ARRAY of tokens (selection click). The
 * array is handed to `tts.speak()` AS-IS — `BrowserTTS` synthesizes it in ONE
 * `/api/tts` request (repeated `segments` params) with measured silence
 * between tokens, i.e. the phrase plays as a single utterance. Deliberately
 * NOT a per-word loop: that would chop the phrase into separate round-trips
 * and could overlap or queue.
 *
 * `tts.stop()` runs first so a rapid second click REPLACES the playback in
 * flight (generation cancel, same semantics as `_gen` in `BrowserTTS`) instead
 * of queueing behind or overlapping it. The rate/volume are read live from the
 * dock, so the word matches the current tempo (0.75/1/1.25) and coach volume.
 * Conversely, a coach read started later cancels an isolated word the same
 * way (`speak()`/`speakWithKaraoke()` stop the TTS first): never two coach
 * audios at once.
 *
 * @param {string|string[]} words - exact token(s) from `data-word`
 *   (contractions kept verbatim), one per selected word
 */
function pronounceWord(words) {
  const list = (Array.isArray(words) ? words : [words]).filter(
    (w) => typeof w === "string" && w.trim() !== "",
  );
  if (!list.length || !tts) return;
  tts.stop();
  void tts.speak(list, { rate: dock?.getRate() ?? 1, volume: volumeSetting(), piperVoice: coachVoice() });
}

/**
 * Tokens of the CURRENT native selection, scoped to the word surfaces
 * (feature 113: click a selection → hear the whole phrase).
 *
 * Returns `[]` when there is no selection, when it is collapsed, or when its
 * common ancestor sits outside `.karaoke-book`/`.review-words`: a selection
 * made anywhere else in the app (settings, sidebar, chat transcript) must
 * never trigger audio. The tokens come from `tokensFromRange` — the exact
 * `data-word` values in document order, never normalized (contractions and
 * casing preserved for the TTS).
 *
 * @returns {string[]} the selected tokens, or [] outside the word surface
 */
function selectedWordTokens() {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return [];
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const scopeEl = node.nodeType === 1 ? /** @type {Element} */ (node) : node.parentElement;
  if (!scopeEl?.closest(WORD_SCOPE_SEL)) return [];
  return tokensFromRange(range, document.querySelectorAll(WORD_SPAN_SEL));
}

/**
 * True when an event target sits inside the word surface (`.karaoke-book` or
 * `.review-words`): the scope probe the click handler applies to BOTH the
 * press and the click before honoring an active selection (feature 113).
 * `instanceof Element` guards against text nodes / non-DOM synthetic targets.
 *
 * @param {unknown} target - event target
 * @returns {boolean}
 */
function isWordScope(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(WORD_SCOPE_SEL));
}

/** Speak a line through the best TTS engine; returns false when stopped. */
async function speak(text, token) {
  dock?.setMode("ai");
  coachSpeaking = true;
  syncBookInteraction();
  // The coach wins over an isolated word click still playing (feature 113).
  tts?.stop();
  try {
    const ok = await tts.speak(text, { rate: dock?.getRate() ?? 1, volume: volumeSetting(), piperVoice: coachVoice() });
    if (token !== flowToken) return false;
    dock?.setMode("idle");
    return ok;
  } finally {
    // Karaoke interaction (112/113) re-opens the moment the coach stops.
    coachSpeaking = false;
    syncBookInteraction();
  }
}

/**
 * Speak a line through the server TTS and light the karaoke words live.
 *
 * Fetches the TTS audio directly so we can decode its duration and highlight
 * the spans (Piper emits no word timestamps). `spans` defaults to every word
 * of the book (the full model answer); pass a single line's spans to light
 * only that fragment. Whatever path the read takes — finished, error or
 * fallback to plain `tts.speak()` — the spans return to white at the end.
 *
 * Feature 114 (prosody): the line is split into clauses client-side and sent
 * as `segments[]` + `pausesMs[]`, so the server returns ONE audio file with
 * human pauses — and this side knows where those pauses are, which lets the
 * word highlight PAUSE with them (see `buildWordStarts`) instead of drifting
 * ahead during the silences. The chosen coach voice goes along as `voice`.
 *
 * Level: the Piper WAV arrives normalized from the server; an edge-tts MP3 is
 * normalized here through the client gain (`speech/level.js`), which also
 * yields the duration — one decode instead of two.
 *
 * @param {string} text - what the coach reads
 * @param {number} token - flow cancellation token
 * @param {{ spans?: Element[] | null }} [opts] - spans to light while reading
 */
async function speakWithKaraoke(text, token, { spans = null } = {}) {
  dock?.setMode("ai");
  coachSpeaking = true;
  syncBookInteraction();
  // The coach wins over an isolated word click still playing (feature 113).
  tts?.stop();
  const activeSpans = spans ?? allWordSpans();
  const { segments, pausesMs } = splitForTts(text);
  const params = new URLSearchParams();
  for (const s of segments) params.append("segments", s);
  for (const p of pausesMs) params.append("pausesMs", String(p));
  const rate = dock?.getRate() ?? 1;
  if (rate !== 1) params.set("rate", String(rate));
  const voice = coachVoice();
  if (voice && health?.tts?.engine === "piper") params.set("voice", voice);

  let audio = null;
  let stopProgress = () => {};
  try {
    const res = await fetch(`/api/tts?${params.toString()}`);
    // The flow may have been cancelled while the audio was being fetched.
    if (token !== flowToken) return;
    if (!res.ok) throw new Error("tts-unavailable");
    // Did THIS response actually carry the requested silences? Only Piper
    // inserts them (edge joins the segments without), and the health snapshot
    // may be stale — the schedule must follow the response, not the snapshot
    // (review major #1). `none`/absent → plain linear spread, exact for edge.
    const pausesMeasured = res.headers.get("X-TTS-Pauses") === "measured";
    const blob = await res.blob();
    if (token !== flowToken) return;
    const url = URL.createObjectURL(blob);
    audio = new Audio(url);
    // The engine defaults to 1.0: without this the model answer and every
    // fragment re-read played at 100% regardless of the user's setting.
    let durationMs = 0;
    let ctl = null;
    if (health?.tts?.engine === "edge-tts") {
      // Edge MP3: client-side level normalization (feature 114) — it decodes
      // the blob, so its duration serves as the karaoke duration too.
      ctl = await tryNormalizeElement(audio, blob);
      if (token !== flowToken) return;
      durationMs = ctl?.durationMs ?? 0;
    }
    if (ctl) ctl.setVolume(volumeSetting());
    else audio.volume = volumeSetting();
    readAudio = audio;
    if (!(durationMs > 0)) {
      try {
        const buf = await blob.arrayBuffer();
        const ac = new AudioContext();
        const decoded = await ac.decodeAudioData(buf);
        durationMs = decoded.duration * 1000;
        ac.close();
      } catch {
        durationMs = 0; // no progress highlight
      }
    }
    // Word onsets that honor the clause pauses — only when the served bytes
    // really contain them (Piper); edge falls back to the linear spread.
    const wordStarts = pausesMeasured
      ? buildWordStarts(durationMs, segments, pausesMs, activeSpans.length)
      : null;
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
      if (durationMs > 0) stopProgress = animateWordProgress(durationMs, token, activeSpans, wordStarts);
    });
  } catch {
    // Server TTS unavailable → plain browser speech, no progress.
    if (token !== flowToken) return;
    await tts.speak(text, { rate, volume: volumeSetting(), piperVoice: coachVoice() });
  } finally {
    stopKaraokeRead = null;
    coachSpeaking = false; // karaoke interaction (112/113) re-opens here
    syncBookInteraction();
    if (readAudio === audio) readAudio = null;
    stopProgress();
    activeSpans.forEach((s) => s.classList.remove("kw-spoken"));
    releaseElement(audio); // edge gain graph, if any (no-op otherwise)
    if (audio) URL.revokeObjectURL(audio.src);
  }
  if (token !== flowToken) return;
  dock?.setMode("idle");
}

/**
 * Highlight the given karaoke spans over `durationMs` (rAF loop).
 *
 * With `starts` (feature 114) each span lights at its scheduled onset, so the
 * highlight waits out the clause pauses with the audio; without it the spread
 * is linear over the duration (legacy behavior / fallback).
 *
 * @param {number} durationMs - duration of the read
 * @param {number} token - flow cancellation token
 * @param {Element[]} spans - spans to light, in reading order
 * @param {number[]|null} [starts] - per-span onset in ms (pause-aware)
 * @returns {() => void} `stop()` — cancels the loop (safe to call twice)
 */
function animateWordProgress(durationMs, token, spans, starts = null) {
  if (!spans.length) return () => {};
  const start = performance.now();
  let cancelled = false;
  const tick = () => {
    if (cancelled || token !== flowToken) return;
    const elapsed = performance.now() - start;
    const t = Math.min(1, elapsed / durationMs);
    const count = starts
      ? starts.filter((s) => s <= elapsed).length
      : Math.floor(t * spans.length);
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
  // Feature 121: provisional paint + auto-scroll while the answer is being
  // captured. Only the full answer needs it — its single long line has no
  // scroll of its own while SPACE is held by PTT. The post-hoc traffic light
  // (106/116) keeps precedence: this layer is torn down before returning, so
  // `renderFeedback → colorWords()` paints over a clean book.
  livePosition = kind === "full" ? createLiveCapturePosition(target, stt) : null;
  try {
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
  } finally {
    // Cleanup on EVERY exit (release, ceiling, error, cancel): no `kw-live`
    // span, timer or interim feed may survive into the next turn.
    livePosition?.dispose();
    livePosition = null;
  }
}

// ---------------------------------------------------------------------------
// Live position during a FULL capture (feature 121): kw-live paint + auto-scroll
// ---------------------------------------------------------------------------

/**
 * RMS in dBFS of the frames appended after the first `skip` samples of the
 * capture buffer (feature 121 silence gate: a fan-hum window is never sent
 * to the partial endpoint).
 *
 * @param {Array<Float32Array>} chunks - recorder frames (append-only)
 * @param {number} skip - leading samples that already belong to a sent window
 * @returns {number|null} RMS in dBFS (-Infinity for digital silence), or
 *   null when there is no new audio at all
 */
function newSamplesRmsDb(chunks, skip) {
  let seen = 0;
  let sumSq = 0;
  let n = 0;
  for (const chunk of chunks) {
    const from = Math.max(0, skip - seen);
    for (let i = from; i < chunk.length; i++) {
      sumSq += chunk[i] * chunk[i];
      n++;
    }
    seen += chunk.length;
  }
  if (!n) return null;
  const rms = Math.sqrt(sumSq / n);
  return rms === 0 ? -Infinity : 20 * Math.log10(rms);
}

/**
 * Build the cumulative-window pump behind the `streaming` live source
 * (feature 121 v2): every {@link PUMP_TICK_MS} it evaluates the gates and,
 * when they all pass, POSTs a `snapshotWav()` — the cumulative prefix of the
 * capture, a copy that never mutates the recorder buffer — to
 * `/api/transcribe-partial`, and feeds the returned text into the single
 * `feed` funnel.
 *
 * Gates (all must pass): a recorder is attached AND still recording; at least
 * {@link MIN_NEW_AUDIO_MS} of audio is new since the last send; at least
 * {@link MIN_WINDOW_INTERVAL_MS} elapsed since the last send; at most one
 * request in flight; and the new audio's RMS is above
 * {@link PARTIAL_SILENCE_RMS_DB}.
 *
 * Failure policy: ANY error (network, 4xx/5xx) disables the pump for good
 * with a single `console.warn` — it NEVER throws toward `captureAttempt`: the
 * whisper→browser fallback is decided only by `submitAudio`, never by this
 * live layer. Releasing push-to-talk aborts the in-flight request (the route
 * kills its whisper child) so a window never competes with the final
 * `/api/attempt` spawn; `dispose()` aborts anything that remains.
 *
 * @param {() => import("../speech/recorder-wave.js").WaveRecorder|null} getRecorder
 * @param {(text: string) => void} onText - partial transcript sink (the feed funnel)
 * @returns {{ dispose: () => void }} stops the loop and aborts the request in flight
 */
function createWindowPump(getRecorder, onText) {
  /** Cumulative samples already covered by a sent window. */
  let sentSamples = 0;
  /** Wall-clock of the last request (0 = none yet). */
  let lastSentAt = 0;
  /** True while one POST /api/transcribe-partial is in flight. */
  let inFlight = false;
  /** AbortController of the in-flight request (null when idle). */
  let inflightController = null;
  /** True after dispose(): every late rejection is then silent. */
  let disposed = false;
  /** True once a failure disabled the pump (single-warn policy). */
  let disabled = false;
  /** True while WE abort a request (release/dispose) — not a real failure. */
  let aborting = false;

  /** Abort the window in flight, if any (deliberately, never a failure). */
  const stopRequest = () => {
    if (!inflightController) return;
    aborting = true;
    inflightController.abort();
  };

  function tick() {
    if (disposed || disabled) return;
    const recorder = getRecorder();
    if (!recorder || !recorder.recording) {
      stopRequest(); // released PTT: cut the window; the server kills its child
      return;
    }
    if (inFlight) return;
    const chunks = recorder.samples;
    let total = 0;
    for (const c of chunks) total += c.length;
    // discard()/stop() emptied the buffer (accidental tap, new turn): the
    // cumulative counters restart with it.
    if (total < sentSamples) sentSamples = 0;
    const sampleRate = recorder.sampleRate || 16000;
    if (total - sentSamples < (MIN_NEW_AUDIO_MS / 1000) * sampleRate) return;
    const rms = newSamplesRmsDb(chunks, sentSamples);
    if (rms === null || rms < PARTIAL_SILENCE_RMS_DB) return;
    const now = Date.now();
    if (lastSentAt && now - lastSentAt < MIN_WINDOW_INTERVAL_MS) return;

    inFlight = true;
    aborting = false;
    inflightController = new AbortController();
    lastSentAt = now;
    sentSamples = total;
    fetch("/api/transcribe-partial", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: recorder.snapshotWav(),
      signal: inflightController.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!disposed && typeof data?.text === "string" && data.text) onText(data.text);
      })
      .catch(() => {
        if (aborting || disposed) return;
        disabled = true;
        clearInterval(timer);
        console.warn("[practice] transcribe-partial failed — live coloring disabled for this capture.");
      })
      .finally(() => {
        inFlight = false;
        inflightController = null;
        aborting = false;
      });
  }

  const timer = setInterval(tick, PUMP_TICK_MS);
  return {
    dispose: () => {
      disposed = true;
      clearInterval(timer);
      stopRequest();
    },
  };
}

/**
 * Live auto-scroll of the ACTIVE word's row (feature 121).
 *
 * Keeps the reading row at the ANTEPENULTIMATE visible row of the book: the
 * rest line sits {@link LIVE_SCROLL_KEPT_ROWS} word-rows above the bottom
 * mask band ({@link LIVE_SCROLL_MASK_PX}), so two full rows stay visible
 * below what the user is reading instead of the row riding the bottom edge
 * (what `scrollIntoView({ block: "nearest" })` + the book's `scroll-padding-block`
 * produced: it only fired at the LAST visible row). The extra row offset
 * cannot be expressed with scroll-padding alone without also moving the
 * coach's line scroll (`setCurrentLine`), so the minimal distance is computed
 * here: fire only when the active row drops below the rest line (≈ once per
 * row advanced), scroll exactly the overflow, smooth, and leave the scroll
 * alone while the row is in range. The row height is MEASURED from the wrap
 * so the scroll adapts to the IPA annotation being on or off.
 *
 * Failures never break the paint: measurement/scroll errors are swallowed.
 *
 * @param {HTMLElement|null} wrap - the active word's `.kw-wrap` (its parent)
 */
function scrollLiveWord(wrap) {
  if (!wrap || !els.book) return;
  try {
    const book = els.book;
    const wrapRect = wrap.getBoundingClientRect();
    const bookRect = book.getBoundingClientRect();
    const rowHeight = wrapRect.height;
    if (!rowHeight) return;
    const restY = bookRect.bottom - LIVE_SCROLL_MASK_PX - LIVE_SCROLL_KEPT_ROWS * rowHeight;
    const overflow = wrapRect.bottom - restY;
    if (overflow <= 0) return;
    book.scrollTo({ top: book.scrollTop + overflow, behavior: "smooth" });
  } catch {
    // measurement/scroll unavailable → the paint still marks the word
  }
}

/**
 * Wire a live position to the karaoke book for ONE full-answer capture
 * (feature 121).
 *
 * The source kind follows the STT route of the turn: Web Speech gets the
 * `interim` source (the recognizer's rewritten transcript), whisper gets the
 * `streaming` source fed by the cumulative-window pump ({@link createWindowPump}).
 * The live position always follows REAL speech — the v1 clock source (a fixed
 * coach cadence) was rejected in manual testing and is gone for good: without
 * a signal the capture behaves exactly as before the feature.
 *
 * `feed(text)` is the single funnel: browser interims (`onInterim`) and
 * server partials (pump) both land here, run through `matchLiveWords` once,
 * and one coalesced rAF frame paints THREE provisional states over the full
 * answer's spans:
 *   - `kw-live` on the active word, plus {@link scrollLiveWord} on its
 *     `.kw-wrap` (keeps the reading row at the ANTEPENULTIMATE visible row,
 *     two rows of buffer below);
 *   - `kw-live-spoken` on the words confirmed as already said;
 *   - `kw-live-missing` on the earlier words the user skipped.
 * The paint is monotonic and cumulative per capture: a shorter rewritten
 * partial can neither rewind the index nor un-mark a word already confirmed
 * as spoken. The class sits on the span, the scroll on the WRAP: in the full
 * phase the whole answer is ONE line, so scrolling the line would move
 * nothing.
 *
 * @param {string} target - the full answer being captured
 * @param {"browser"|"whisper"} stt - engine chosen for this turn
 * @returns {{ begin: () => void, feed: (text: string) => void, dispose: () => void, attachRecorder: (recorder: import("../speech/recorder-wave.js").WaveRecorder|null) => void }|null}
 */
function createLiveCapturePosition(target, stt) {
  const targetTokens = tokenizeWords(target);
  if (!targetTokens.length) return null;
  /** Partial sink installed by the source's `register` (no-op until armed). */
  let sourceFeed = () => {};
  const source = createLivePositionSource({
    kind: stt === "browser" ? "interim" : "streaming",
    targetTokens,
    register: (handler) => {
      sourceFeed = handler;
      return () => {
        if (sourceFeed === handler) sourceFeed = () => {};
      };
    },
  });
  /** Recorder of the capture in flight (attached by waitForUserRecording). */
  let recorder = null;
  /** Whisper route only: the window pump that streams cumulative snapshots. */
  const pump = stt === "whisper" ? createWindowPump(() => recorder, feed) : null;

  // Per-capture paint state (reset by begin(), swept by dispose()).
  /** Highest active index reached during this capture (monotonic floor). */
  let highWater = 0;
  /** Cumulative "already said" mask (survives shorter rewritten partials). */
  const spokenSoFar = new Array(targetTokens.length).fill(false);
  /** Pending rAF frame of the paint/scroll (0 = none scheduled). */
  let frame = 0;
  let disposed = false;

  /** Apply the provisional live states to the full answer's spans. */
  function paint() {
    frame = 0;
    const spans = spansForLine(-1);
    spans.forEach((span, i) => {
      span.classList.remove("kw-live", "kw-live-spoken", "kw-live-missing");
      if (i === highWater) span.classList.add("kw-live");
      else if (spokenSoFar[i]) span.classList.add("kw-live-spoken");
      else if (i < highWater) span.classList.add("kw-live-missing");
    });
    const active = spans[highWater];
    if (active) scrollLiveWord(active.parentElement);
  }

  /** Single funnel of real-speech text (browser interims + server partials). */
  function feed(text) {
    if (disposed) return;
    sourceFeed(text); // the source's onWord contract keeps tracking the same text
    const match = matchLiveWords(targetTokens, text);
    highWater = Math.max(highWater, match.index);
    for (let i = 0; i < spokenSoFar.length; i++) {
      if (match.spoken[i]) spokenSoFar[i] = true;
    }
    if (!frame) frame = requestAnimationFrame(paint);
  }

  return {
    // Every PTT press (re)arms: a discarded accidental tap (111) restarts at
    // word 0 instead of inheriting the tap's position.
    begin: () => {
      highWater = 0;
      spokenSoFar.fill(false);
      source.start();
    },
    feed,
    attachRecorder: (r) => {
      recorder = r;
    },
    dispose: () => {
      disposed = true;
      pump?.dispose();
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      source.stop();
      // Sweep the whole book (not just the active span): a settings-triggered
      // rebuildBook() mid-capture may have replaced the spans under us.
      els?.book
        ?.querySelectorAll(".kw-live, .kw-live-spoken, .kw-live-missing")
        .forEach((span) => span.classList.remove("kw-live", "kw-live-spoken", "kw-live-missing"));
    },
  };
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
      syncBookInteraction(); // capture released → word interaction (112/113) re-opens
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
    // Feature 121 v2: the live-window pump reads the recorder's buffer, so the
    // live position of a whisper turn gets a handle to it (no-op otherwise).
    livePosition?.attachRecorder?.(recorder);
    // Live VU meter while the capture is held (informative, fan included).
    recorder.onLevel = (db) => dock?.setVU(db);

    ptt = new PushToTalk({
      maxCaptureMs: ceilingMs,
      now: () => performance.now(),
      // "Usable audio" for the accidental-tap guard: at least one frame was
      // buffered (`WaveRecorder.stop()` will report the same count).
      hasAudio: () => (recorder?.samples.length ?? 0) > 0,
      onStart: () => {
        closeLookupPopover(); // capture start closes the lookup card (112)
        livePosition?.begin(); // feature 121: arm the live position at the press
        dock?.setMode("recording");
        dock?.setMicLabel(PTT_RECORD_LABEL);
        syncBookInteraction(); // capture held → word interaction (112/113) off
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
        syncBookInteraction(); // accidental tap → back to waiting for the press
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
      syncBookInteraction(); // capture released → word interaction (112/113) re-opens
      resolve(value);
    };

    const stt = new BrowserSTT({
      // Feature 121: the rewritten interim transcript refines the live
      // position of a full-answer capture (no-op outside one).
      onInterim: (text) => livePosition?.feed(text),
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
        closeLookupPopover(); // capture start closes the lookup card (112)
        livePosition?.begin(); // feature 121: arm the live position at the press
        started = true;
        ceilingTimer = setTimeout(() => ptt.tick(), ceilingMs);
        dock?.setMode("recording");
        dock?.setMicLabel(PTT_RECORD_LABEL);
        syncBookInteraction(); // capture held → word interaction (112/113) off
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
        syncBookInteraction(); // accidental tap → back to waiting for the press
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

/** Map the /api/attempt response into an AttemptOutcome (karaoke.ts shape). */
function outcomeFromJson(json, target, kind) {
  return {
    kind,
    // Feature 116: handle of the background LLM refinement (absent for a
    // blank transcript — that path answers exactly as before, no refinement).
    attemptId: typeof json.attemptId === "string" && json.attemptId ? json.attemptId : null,
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
// LLM refinement (feature 116): background feedback + forced-amber recolor
// ---------------------------------------------------------------------------

/**
 * Request the LLM refinement of the attempt just painted, raced against the
 * REFINE_WAIT_MS cap.
 *
 * Fired WITHOUT `await` right after `renderFeedback`, so the request overlaps
 * the fail chime and the paint; only the FAIL path awaits the raced promise,
 * just before speaking (PASS never waits — the recolor simply lands whenever
 * it arrives). Never rejects: network errors, a 404 (expired/unknown id) and
 * `refined: false` (LLM down / server timeout) all resolve to null, which
 * means "keep the deterministic state and coach line".
 *
 * @param {{ attemptId?: string|null }} outcome - the attempt just painted
 * @param {number} lineIndex - fragment index, or `-1` for the full answer
 * @param {number} token - flow cancellation token
 * @returns {Promise<object|null>} the refinement payload, or null
 */
function startRefinement(outcome, lineIndex, token) {
  if (!outcome.attemptId) return Promise.resolve(null);
  // The deadline starts at the PAINT, not at the await: the cap is spent
  // under the chime + paint, so the wait right before speak is the remainder.
  return Promise.race([
    fetchRefinement(outcome.attemptId, lineIndex, token),
    sleep(REFINE_WAIT_MS).then(() => null),
  ]);
}

/**
 * Long-poll GET /api/attempt/:id/feedback and apply the refinement when it
 * lands. Every await re-checks `flowToken`, so a refinement of a session that
 * was left mid-flight is dropped instead of repainting.
 *
 * @param {string} attemptId - id returned by POST /api/attempt (116)
 * @param {number} lineIndex - fragment index, or `-1` for the full answer
 * @param {number} token - flow cancellation token
 * @returns {Promise<object|null>} the refinement, or null (never throws)
 */
async function fetchRefinement(attemptId, lineIndex, token) {
  try {
    const res = await fetch(`/api/attempt/${encodeURIComponent(attemptId)}/feedback`);
    if (token !== flowToken) return null;
    if (!res.ok) return null;
    const data = await res.json();
    if (token !== flowToken) return null;
    if (!data || data.refined !== true) return null;
    applyRefinement(attemptId, lineIndex, data, token);
    return data;
  } catch {
    return null;
  }
}

/**
 * Apply a landed refinement to the attempt on screen (feature 116): repaint
 * the line with the forced-amber words and refresh the outcome's coach line
 * (so a later `rebuildBook()` restores the refined colors too).
 *
 * Guarded by attemptId + flowToken + line index: a refinement of an attempt
 * that is no longer the one displayed — or whose line was cleared for a new
 * capture/read — is dropped and the deterministic paint stays.
 *
 * @param {string} attemptId
 * @param {number} lineIndex
 * @param {{ words?: Array<object>, coachLine?: string }} data
 * @param {number} token - flow cancellation token
 */
function applyRefinement(attemptId, lineIndex, data, token) {
  if (token !== flowToken) return;
  if (attemptId !== lastAttemptId || lineIndex !== lastAttemptLineIndex) return;
  if (!lastAttempt) return;
  if (Array.isArray(data.words)) lastAttempt.words = data.words;
  if (typeof data.coachLine === "string" && data.coachLine) lastAttempt.coachLine = data.coachLine;
  colorWords(lastAttempt, lineIndex);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Live-practice chrome: adjustment + feedback chips, book, sub, done. (No title, no speech pill — both were removed as redundant: the pill lives in the sidebar.) */
function renderHeader() {
  els = {
    adjustment: h("div", { class: "adjustment-chip", hidden: true }),
    feedbackChip: h("div", { class: "feedback-chip", hidden: true }),
    book: h("div", { class: "karaoke-book" }),
    sub: h("div", { class: "practice-sub" }),
    done: h("div", { class: "practice-done", hidden: true }),
  };
  root.append(els.adjustment, els.feedbackChip, els.book, els.sub, els.done);
  // Fresh book node → project the interaction gate onto it (features 112/113).
  syncBookInteraction();
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
 *   - model → one line per fragment with the book in `reading` mode
 *     (every line legible while the coach reads the whole answer);
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
  const reading = phase === "model";
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
    lines[index]?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "smooth" });
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
  // A new attempt supersedes any replay still playing from the previous one.
  stopReplay?.();
  lastAttemptLineIndex = lineIndex;
  // Feature 116: the refinement guard — only the refinement of THIS attempt
  // may recolor the line (blank transcripts / timed-out turns have none).
  lastAttemptId = outcome.attemptId ?? null;
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
  // Speaker button: only on a failed attempt (and only when the take was
  // captured as a WAV). It replays the user's own audio on demand — the fail
  // path no longer auto-replays it. A click while one is playing cuts it.
  if (!passed && lastWavBlob) {
    parts.push(
      h(
        "button",
        {
          type: "button",
          class: "chip-hear-btn",
          "aria-label": "Escuchar tu intento",
          title: "Escuchar tu intento",
          onclick: () => {
            if (stopReplay) {
              stopReplay();
              return;
            }
            // Never overlap the coach: cut a pending read/TTS before playing.
            stopKaraokeRead?.();
            tts.stop();
            replayUserWav(lastWavBlob);
          },
        },
        [h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "volume_up")],
      ),
    );
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
// User WAV replay (feedback chip speaker: hear yourself while the colors stay on screen)
// ---------------------------------------------------------------------------

/**
 * Replay the user's last recording while the traffic-light colors of the
 * attempt stay visible.
 *
 * On demand only: the feedback chip's speaker button triggers it when the
 * attempt failed (the fail path no longer auto-replays the take). There is
 * no lyric animation here on purpose: the line was already scored with
 * green/amber/red, and lighting it blue would hide the feedback the colors
 * exist to give.
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
  // `setElementVolume` knows about the edge gain graph (feature 114): it
  // moves the gain node when one is attached, the plain volume otherwise.
  if (readAudio) setElementVolume(readAudio, v);
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
