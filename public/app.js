import { BrowserTTS } from "./speech/browser-tts.js";
import { BrowserSTT } from "./speech/browser-stt.js";
import { WaveRecorder } from "./speech/recorder-wave.js";
import { pickStt } from "./speech/stt-pick.js";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tts = new BrowserTTS();
const settings = {
  provider: localStorage.getItem("engcoach.provider") ?? "cloudflare",
  stt: localStorage.getItem("engcoach.stt") ?? "browser",
  voice: localStorage.getItem("engcoach.voice") ?? "",
  piperVoice: localStorage.getItem("engcoach.piperVoice") ?? "en_US-amy-medium",
  rate: Number(localStorage.getItem("engcoach.rate") ?? 0.95),
  autoplay: (localStorage.getItem("engcoach.autoplay") ?? "1") === "1",
  autoConversation: (localStorage.getItem("engcoach.autoConversation") ?? "1") === "1",
};
const saveSetting = (k, v) => {
  settings[k] = v;
  localStorage.setItem(`engcoach.${k}`, String(v));
};

let allSessionsLoaded = false;

// ---------- tabs ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`));
    if (btn.dataset.tab === "progress") loadProgress();
  });
});

// ---------- boot ----------
async function boot() {
  await tts.allVoices();
  populateVoices();
  bindSettings();
  bindChat();
  api("/api/health").then((h) => {
    tts.setHealth(h);
    renderHealth(h);
    renderWhisperStatus(h);
    renderTtsStatus(h);
    applySttDefault(h);
  });
}
boot();

function populateVoices() {
  const sel = $("set-voice");
  const voices = tts.allVoices();
  const preferred = voices.find((v) => /samantha|daniel|aaron|ava|google us/i.test(v.name)) ?? voices[0];
  sel.innerHTML = "";
  for (const v of voices) {
    const opt = document.createElement("option");
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} (${v.lang})`;
    sel.appendChild(opt);
  }
  sel.value = settings.voice || preferred?.voiceURI || "";
  sel.addEventListener("change", () => saveSetting("voice", sel.value));
}

function bindSettings() {
  $("set-provider").value = settings.provider;
  $("set-stt").value = settings.stt;
  $("set-rate").value = String(settings.rate);
  $("set-autoplay").checked = settings.autoplay;
  $("set-auto-conversation").checked = settings.autoConversation;
  $("set-piper-voice").value = settings.piperVoice;
  $("set-provider").addEventListener("change", (e) => saveSetting("provider", e.target.value));
  $("set-stt").addEventListener("change", (e) => saveSetting("stt", e.target.value));
  $("set-rate").addEventListener("change", (e) => saveSetting("rate", Number(e.target.value)));
  $("set-autoplay").addEventListener("change", (e) => saveSetting("autoplay", e.target.checked));
  $("set-auto-conversation").addEventListener("change", (e) => saveSetting("autoConversation", e.target.checked));
  $("set-piper-voice").addEventListener("change", (e) => {
    saveSetting("piperVoice", e.target.value);
    // Re-check TTS status with the newly selected voice.
    api("/api/health").then((h) => {
      tts.setHealth(h);
      renderTtsStatus(h);
    });
  });
}

function renderHealth(h) {
  const pill = $("health-pill");
  const online = Object.values(h.providers).some(Boolean);
  pill.textContent = h.primary;
  pill.classList.toggle("ok", online);
  pill.classList.toggle("bad", !online);
  pill.title = `LLM providers: ${Object.entries(h.providers)
    .map(([k, v]) => `${k}:${v ? "ok" : "off"}`)
    .join("  ")} · Whisper: ${h.whisper?.available ? "installed" : "not installed"}`;
}

function renderWhisperStatus(h) {
  const el = $("whisper-status");
  const w = h.whisper;
  const ok = Boolean(w?.available && w?.modelReady);
  if (ok) {
    el.textContent = "Preferred — local & offline";
    return;
  }
  if (w?.available) {
    el.textContent = `Installed — run "npm run setup" to download the ${w.model} model (or it will download on first use).`;
    return;
  }
  el.textContent = "Not installed — brew install whisper-cpp, then npm run setup";
}

function renderTtsStatus(h) {
  const el = $("tts-status");
  const t = h.tts;
  const p = t?.piper;
  const e = t?.edge;
  // Hide the browser-voice dropdown when Piper is active (it's not used).
  const voiceLabel = $("set-voice")?.closest("label");
  if (voiceLabel) voiceLabel.style.display = t?.engine === "piper" ? "none" : "";
  if (t?.engine === "piper") {
    el.textContent = `TTS: Piper neural voice (${p.voice}) — local & offline`;
    el.style.color = "var(--green)";
    return;
  }
  if (t?.engine === "edge-tts") {
    el.textContent = `TTS: Piper not installed — using edge-tts (${e?.voice ?? "online"})`;
    el.style.color = "var(--amber)";
    return;
  }
  if (p?.available) {
    el.textContent = `TTS: Piper installed — run "npm run setup -- --tts" to download the voice model.`;
    el.style.color = "var(--amber)";
    return;
  }
  el.textContent = "TTS: using browser speechSynthesis. Install Piper locally for a neural voice: pipx install piper-tts";
  el.style.color = "var(--muted)";
}

/** Auto-select whisper as the STT engine when it is ready and the user has not chosen otherwise. */
function applySttDefault(h) {
  const userChoice = localStorage.getItem("engcoach.stt");
  const stt = pickStt(h, userChoice);
  if (stt !== settings.stt) {
    settings.stt = stt;
    $("set-stt").value = stt;
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: typeof opts.body === "string" ? { "Content-Type": "application/json" } : undefined,
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `HTTP ${res.status}`);
    err.code = data.code;
    throw err;
  }
  return data;
}

// ---------- practice session ----------
const sess = {
  id: crypto.randomUUID(),
  category: "interviews",
  level: "B2",
  set: null,
  fragments: [],
  idx: 0,
  transcript: "",
  recording: false,
  stt: null,
  recorder: null,
  checking: false,
  lastEval: null,
  whisperWarned: false,
};

function providerBody() {
  return { provider: settings.provider };
}

$("start-practice").addEventListener("click", async () => {
  sess.category = $("category").value;
  sess.level = $("level").value;
  sess.id = crypto.randomUUID();
  $("practice-loading").classList.remove("hidden");
  $("start-practice").disabled = true;
  try {
    const data = await api("/api/practice/new", {
      method: "POST",
      body: JSON.stringify({ ...providerBody(), category: sess.category, level: sess.level, personalized: $("personalized").checked }),
    });
    sess.set = data.set;
    sess.fragments = data.set.fragments.map((f) => ({ ...f, attempts: [], passed: false }));
    sess.id = crypto.randomUUID();
    enterSession();
  } catch (err) {
    alert(`Could not generate the practice: ${err.message}`);
  } finally {
    $("practice-loading").classList.add("hidden");
    $("start-practice").disabled = false;
  }
});

function enterSession() {
  $("setup-view").classList.add("hidden");
  $("session-view").classList.remove("hidden");
  $("category-badge").textContent = sess.category;
  $("level-badge").textContent = sess.level;
  $("question-text").textContent = sess.set.question;
  $("coach-note").textContent = sess.set.context;
  $("coach-note").style.display = "block";
  setFragment(0);
}

function setFragment(idx) {
  sess.idx = idx;
  const f = sess.fragments[idx];
  sess.lastEval = null;
  $("stage-chip").textContent = f.stage || `Part ${idx + 1}`;
  $("fragment-text").innerHTML = `<span class="coach-line">${escapeHtml(f.text)}</span>`;
  $("progress-bar").style.width = `${((idx + 1) / sess.fragments.length) * 100}%`;
  showFragmentArea();
  resetTranscript();
  if (settings.autoplay) autoplayFragment(f);
}

function currentFragment() {
  return sess.fragments[sess.idx];
}

function showFragmentArea() {
  $("feedback-area").classList.add("hidden");
  $("done-area").classList.add("hidden");
  $("fragment-area").classList.remove("hidden");
  $("fragment-area").classList.remove("live-subs");
}

function showFeedback(evalData) {
  sess.lastEval = evalData;
  $("feedback-area").classList.remove("hidden");
  $("fragment-area").classList.add("live-subs");
  const frag = currentFragment();
  const missed = new Set((evalData.missing ?? []).map((w) => w.toLowerCase()));
  const fragTokens = frag.text.split(/(\s+)/);
  $("fragment-text").innerHTML = `<span class="coach-line">${fragTokens
    .map((t) => (missed.has(t.toLowerCase()) ? `<span class="miss">${escapeHtml(t)}</span>` : escapeHtml(t)))
    .join("")}</span>`;
  renderUserTranscript();
  const ring = $("score-ring");
  const score = evalData.score;
  $("score-num").textContent = score;
  const angle = score * 3.6;
  const color = score >= 70 ? "#34d399" : score >= 50 ? "#fbbf24" : "#f87171";
  ring.style.background = `conic-gradient(${color} ${angle}deg, var(--panel-2) 0deg)`;
  $("score-num").style.color = color;
  const verdict =
    score >= 70 ? "Great! You nailed that fragment." : score >= 50 ? "Almost there!" : "Let's practice this one more time.";
  $("verdict-text").textContent = verdict;
  renderIssues(evalData.issues);
  renderTips(evalData.tips);
  $("btn-try-again").classList.toggle("hidden", evalData.next);
  $("btn-next").classList.toggle("hidden", !evalData.next);
  if (settings.autoplay) speakCoachFeedback(evalData, verdict);
}

function renderUserTranscript() {
  const evalData = sess.lastEval;
  if (!evalData || !sess.transcript) {
    $("transcript").textContent = sess.transcript || "Your words will appear here.";
    return;
  }
  const wrong = new Set((evalData.extra ?? []).map((w) => w.toLowerCase()));
  const tokens = sess.transcript.split(/(\s+)/);
  $("transcript").innerHTML = `<span class="user-line">${tokens
    .map((t) => (wrong.has(t.toLowerCase()) ? `<span class="miss">${escapeHtml(t)}</span>` : escapeHtml(t)))
    .join("")}</span>`;
}

function speakCoachFeedback(evalData, verdict) {
  tts.stop();
  const issues = evalData.issues ?? [];
  const fix = issues.find((i) => i.fix)?.fix;
  const line = fix ? `${verdict} ${fix}` : verdict;
  tts.speak(line, { rate: settings.rate, voiceURI: settings.voice, piperVoice: settings.piperVoice }).then(() => {
    if (!settings.autoConversation) return;
    // Guard: never auto-advance once the user has left this session view.
    if ($("session-view").classList.contains("hidden")) return;
    if (evalData.next) {
      // Passed: move to the next fragment (or finish if no more remain).
      if (sess.idx + 1 < sess.fragments.length) {
        setFragment(sess.idx + 1);
      } else {
        finishFragmentsUI();
      }
    } else {
      // Retry the same fragment naturally after feedback.
      showFragmentArea();
      resetTranscript();
      autoplayFragment(currentFragment());
    }
  });
}

function renderIssues(issues) {
  const el = $("issues");
  el.innerHTML = "";
  if (!issues || issues.length === 0) {
    el.innerHTML = `<div class="tip">No issues found — clean repetition.</div>`;
    return;
  }
  for (const iss of issues) {
    const div = document.createElement("div");
    div.className = "issue";
    const fix = iss.fix ? `<br/><em>${escapeHtml(iss.fix)}</em>` : "";
    div.innerHTML = `<span class="cat">${escapeHtml(iss.category)}</span> — ${escapeHtml(iss.message)}${fix}`;
    el.appendChild(div);
  }
}

function renderTips(tips) {
  const el = $("tips");
  el.innerHTML = "";
  el.innerHTML = `<div class="tiphead">Coach tips</div>`;
  for (const t of tips ?? []) {
    const div = document.createElement("div");
    div.className = "tip";
    div.textContent = t;
    el.appendChild(div);
  }
}

function resetTranscript() {
  sess.transcript = "";
  $("transcript").textContent = "Your words will appear here.";
  $("transcript").classList.remove("interim");
  $("btn-check").disabled = true;
  $("btn-check").classList.add("disabled");
  stopRecording();
}

async function autoplayFragment(f) {
  tts.stop();
  const intro = f.coach_intro ? f.coach_intro : "Repeat after me.";
  await tts.speak([intro, f.text], {
    rate: settings.rate,
    voiceURI: settings.voice,
    piperVoice: settings.piperVoice,
    pauseAfterMs: 500,
  });
  if (settings.autoConversation) startRecording();
}

$("btn-play").addEventListener("click", () => autoplayFragment(currentFragment()));

async function startRecording() {
  if (sess.recording) return;
  if (settings.stt === "whisper") {
    sess.recording = true;
    $("listening-dot").classList.remove("hidden");
    resetButtonsRecording();
    sess.recorder = new WaveRecorder({
      onSilenceStop: async () => {
        // Whisper silence detected: transcribe and (in auto mode) evaluate.
        await handleWhisperSilenceStop();
      },
    });
    try {
      await sess.recorder.start();
    } catch (err) {
      alert(`Microphone error: ${err.message}`);
      stopRecording();
    }
  } else {
    startBrowserRecording();
  }
}

/** Whisper auto-stop hook: stop the recorder, transcribe, then act on the result. */
async function handleWhisperSilenceStop() {
  if (!sess.recorder) return;
  const blob = sess.recorder.stop();
  sess.recorder = null;
  await endWhisperTurn(blob);
}

/** Transcribe a captured whisper blob and (in auto mode) evaluate the attempt. */
async function endWhisperTurn(blob) {
  $("listening-dot").textContent = "Transcribing locally…";
  let fallbackStarted = false;
  try {
    const { text } = await api("/api/transcribe", { method: "POST", body: blob });
    sess.transcript = text ?? "";
    $("transcript").textContent = sess.transcript || "Nothing heard — try again.";
    updateCheckButton();
    if (settings.autoConversation && sess.transcript.trim()) {
      await evaluateCurrent();
    }
  } catch (err) {
    if (isModelDownloaded(err)) {
      $("transcript").textContent = err.message;
    } else {
      warnWhisperFallback();
      fallbackStarted = true;
      sess.recording = false;
      startBrowserRecording();
    }
  } finally {
    $("listening-dot").textContent = "Listening…";
    if (!fallbackStarted) {
      sess.recording = false;
      $("listening-dot").classList.add("hidden");
      resetButtonsIdle();
    }
  }
}

/** Start a browser (Web Speech) recording for the current fragment. */
function startBrowserRecording() {
  if (sess.recording) return;
  sess.recording = true;
  $("listening-dot").classList.remove("hidden");
  resetButtonsRecording();
  sess.stt = new BrowserSTT({
    onInterim: (t) => {
      $("transcript").innerHTML = `${escapeHtml(t)}<span class="interim">…</span>`;
    },
    onEnd: () => {
      const text = sess.stt?.result();
      sess.stt = null;
      sess.transcript = text ?? "";
      $("transcript").textContent = sess.transcript || "Nothing heard — try again.";
      updateCheckButton();
      stopRecording();
      if (settings.autoConversation && sess.transcript.trim()) {
        evaluateCurrent();
      }
    },
    onError: (e) => {
      if (e.error === "not-allowed") {
        alert("Microphone permission denied. Allow it in Chrome and try again.");
        stopRecording();
      }
    },
  });
  let started = false;
  try {
    started = sess.stt.start() !== false;
  } catch {
    started = false;
  }
  if (!started) {
    sess.stt = null;
    stopRecording();
  }
}

/** Warn once per session when whisper fails and browser recognition takes over. */
function warnWhisperFallback() {
  if (sess.whisperWarned) return;
  sess.whisperWarned = true;
  toast("Whisper unavailable — using browser recognition");
}

/** True when the server downloaded the whisper model on demand and asked to record again. */
function isModelDownloaded(err) {
  return err?.code === "MODEL_DOWNLOADED" || (err?.message ?? "").includes("Model downloaded");
}

function stopRecording() {
  sess.recording = false;
  $("listening-dot").classList.add("hidden");
  resetButtonsIdle();
  if (sess.stt) {
    sess.stt.stop();
  }
  if (sess.recorder) {
    sess.recorder.cancel();
    sess.recorder = null;
  }
}

/** Stop recording and restore the full-answer controls to idle. */
function stopFullRecording() {
  stopRecording();
  $("btn-record-full").classList.remove("hidden");
}

function resetButtonsRecording() {
  $("btn-record").classList.add("hidden");
  $("btn-stop").classList.remove("hidden");
  $("btn-stop-full").classList.add("hidden");
}

function resetButtonsIdle() {
  $("btn-record").classList.remove("hidden");
  $("btn-stop").classList.add("hidden");
  $("btn-stop-full").classList.add("hidden");
}

function updateCheckButton() {
  const ok = sess.transcript.trim().length > 0;
  $("btn-check").disabled = !ok;
  $("btn-check").classList.toggle("disabled", !ok);
}

$("btn-record").addEventListener("click", startRecording);
$("btn-stop").addEventListener("click", async () => {
  if (settings.stt === "whisper" && sess.recorder) {
    const blob = sess.recorder.stop();
    sess.recorder = null;
    await endWhisperTurn(blob);
  } else {
    stopRecording();
    sess.transcript = sess.stt?.result() ?? sess.transcript;
    $("transcript").textContent = sess.transcript || "Nothing heard — try again.";
    updateCheckButton();
  }
});

/** Evaluate the current transcript against the current fragment. */
async function evaluateCurrent() {
  if (sess.checking || !sess.transcript.trim()) return;
  sess.checking = true;
  $("btn-check").disabled = true;
  const frag = currentFragment();
  try {
    const data = await api("/api/evaluate", {
      method: "POST",
      body: JSON.stringify({
        ...providerBody(),
        target: frag.text,
        userText: sess.transcript,
        question: sess.set.question,
        level: sess.level,
        sessionId: sess.id,
        fragmentId: frag.id,
      }),
    });
    frag.attempts.push({ text: sess.transcript, evaluation: data.evaluation });
    if (data.evaluation.next) frag.passed = true;
    showFeedback(data.evaluation);
  } catch (err) {
    alert(`Evaluation failed: ${err.message}`);
    updateCheckButton();
  } finally {
    sess.checking = false;
  }
}

$("btn-check").addEventListener("click", evaluateCurrent);

$("btn-try-again").addEventListener("click", () => {
  showFragmentArea();
  resetTranscript();
  autoplayFragment(currentFragment());
});

$("btn-next").addEventListener("click", () => {
  if (sess.idx + 1 < sess.fragments.length) {
    setFragment(sess.idx + 1);
  } else {
    finishFragmentsUI();
  }
});

$("quit-session").addEventListener("click", () => {
  if (sess.fragments.some((f) => f.attempts.length > 0)) saveSession(); // persist partial
  exitToSetup();
});

function finishFragmentsUI() {
  $("fragment-area").classList.add("hidden");
  $("feedback-area").classList.add("hidden");
  $("done-area").classList.remove("hidden");
  $("progress-bar").style.width = "100%";
  const attempts = sess.fragments.flatMap((f) => f.attempts).length;
  const passed = sess.fragments.filter((f) => f.passed).length;
  $("session-summary").textContent = `${passed} of ${sess.fragments.length} fragments passed · ${attempts} attempts recorded.`;
  resetTranscript();
}

function fullAnswerText() {
  return sess.fragments.map((f) => f.text).join(" ");
}

$("btn-play-full").addEventListener("click", () => {
  tts.stop();
  tts.speak(fullAnswerText(), { rate: settings.rate, voiceURI: settings.voice, piperVoice: settings.piperVoice });
});

$("btn-record-full").addEventListener("click", async () => {
  if (sess.recording) return;
  if (settings.stt === "whisper") {
    sess.recording = true;
    $("listening-dot").classList.remove("hidden");
    $("btn-record-full").classList.add("hidden");
    $("btn-stop-full").classList.remove("hidden");
    sess.recorder = new WaveRecorder();
    try {
      await sess.recorder.start();
    } catch (err) {
      alert(`Microphone error: ${err.message}`);
      sess.recording = false;
      $("btn-record-full").classList.remove("hidden");
      $("btn-stop-full").classList.add("hidden");
    }
  } else {
    startFullBrowserRecording();
  }
});

/** Start a browser (Web Speech) recording for the full answer. */
function startFullBrowserRecording() {
  if (sess.recording) return;
  sess.recording = true;
  $("listening-dot").classList.remove("hidden");
  $("btn-record-full").classList.add("hidden");
  $("btn-stop-full").classList.remove("hidden");
  sess.stt = new BrowserSTT({
    onInterim: (t) => ($("transcript-full").textContent = t),
    onEnd: () => {
      const t = sess.stt?.result();
      sess.stt = null;
      if (t) {
        $("transcript-full").textContent = t;
        $("btn-check-full").disabled = false;
      }
      stopFullRecording();
    },
  });
  let started = false;
  try {
    started = sess.stt.start() !== false;
  } catch {
    started = false;
  }
  if (!started) {
    sess.stt = null;
    stopFullRecording();
  }
}

$("btn-stop-full").addEventListener("click", async () => {
  let text = "";
  let modelDownloaded = false;
  if (settings.stt === "whisper" && sess.recorder) {
    const blob = sess.recorder.stop();
    sess.recorder = null;
    $("listening-dot").textContent = "Transcribing locally…";
    let fallbackStarted = false;
    try {
      const r = await api("/api/transcribe", { method: "POST", body: blob });
      text = r.text ?? "";
    } catch (err) {
      if (isModelDownloaded(err)) {
        modelDownloaded = true;
        $("transcript-full").textContent = err.message;
      } else {
        warnWhisperFallback();
        fallbackStarted = true;
        sess.recording = false;
        startFullBrowserRecording();
      }
    } finally {
      $("listening-dot").textContent = "Listening…";
      if (!fallbackStarted) {
        sess.recording = false;
        $("listening-dot").classList.add("hidden");
        $("btn-record-full").classList.remove("hidden");
        $("btn-stop-full").classList.add("hidden");
      }
    }
    if (fallbackStarted || modelDownloaded) return;
  } else {
    sess.stt?.stop();
    text = sess.stt?.result() ?? "";
  }
  $("transcript-full").textContent = text || "Nothing heard — try again.";
  const ok = text.trim().length > 0;
  $("btn-check-full").disabled = !ok;
});

$("btn-check-full").addEventListener("click", async () => {
  const text = $("transcript-full").textContent.trim();
  if (!text) return;
  try {
    const data = await api("/api/evaluate", {
      method: "POST",
      body: JSON.stringify({
        ...providerBody(),
        target: fullAnswerText(),
        userText: text,
        question: sess.set.question,
        level: sess.level,
        sessionId: sess.id,
        fragmentId: "full-answer",
      }),
    });
    sess.fullAnswerEval = data.evaluation;
    const fb = $("full-feedback");
    fb.classList.remove("hidden");
    fb.innerHTML = `<div class="score-row"><div id="full-ring" style="font-size:20px;color:#34d399">Score: ${data.evaluation.score}/100 (${data.evaluation.verdict})</div></div>`;
    renderIssuesIn(data.evaluation.issues, fb);
  } catch (err) {
    alert(`Evaluation failed: ${err.message}`);
  }
});

function renderIssuesIn(issues, container) {
  const list = document.createElement("div");
  list.className = "issues";
  for (const iss of issues ?? []) {
    const d = document.createElement("div");
    d.className = "issue";
    d.innerHTML = `<span class="cat">${escapeHtml(iss.category)}</span> — ${escapeHtml(iss.message)}`;
    list.appendChild(d);
  }
  container.appendChild(list);
}

$("btn-finish").addEventListener("click", async () => {
  await saveSession();
  exitToSetup();
  loadProgress();
});

async function saveSession() {
  const payload = {
    id: sess.id,
    category: sess.category,
    level: sess.level,
    provider: settings.provider,
    question: sess.set.question,
    context: sess.set.context,
    fragments: sess.fragments.map((f) => ({
      id: f.id,
      stage: f.stage,
      text: f.text,
      passed: f.passed,
      attempts: f.attempts.map((a) => {
        const e = a.evaluation;
        return {
          text: a.text,
          score: e?.score,
          missing: e?.missing ?? [],
          extra: e?.extra ?? [],
          issues: e?.issues ?? [],
          verdict: e?.verdict,
        };
      }),
    })),
    fullAnswer: sess.fullAnswerEval
      ? { text: fullAnswerText(), score: sess.fullAnswerEval.score, feedback: sess.fullAnswerEval.verdict }
      : undefined,
  };
  try {
    const r = await api("/api/session/save", { method: "POST", body: JSON.stringify(payload) });
    if (r.nextStep) {
      toast(`Next step: ${r.nextStep.focus}`);
    }
  } catch (err) {
    alert(`Could not save the session: ${err.message}`);
  }
}

function exitToSetup() {
  $("session-view").classList.add("hidden");
  $("setup-view").classList.remove("hidden");
  tts.stop();
  stopRecording();
}

// ---------- chat ----------
const chat = {
  mode: "text", // "text" | "spoken" | "interview"
  history: [], // Array<{role:"user"|"assistant", content}> for /api/chat
  turns: [], // Array<{role:"user"|"assistant", text}> for session save
  sessionId: null,
  recording: false,
  stt: null,
  recorder: null,
  whisperWarned: false,
  interview: null, // { topic, total, index }
  busy: false, // true while a /api/chat request is in flight
  epoch: 0, // bumped on mode switch so stale responses are discarded
};

function bindChat() {
  $("chat-send").addEventListener("click", () => sendChat());
  $("chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });
  $("chat-mic").addEventListener("click", toggleChatMic);
  $("chat-interview").addEventListener("click", startInterview);
  $("chat-end-session").addEventListener("click", endChatSession);
}

/** Send a chat message. `text` is used when the message came from the mic (spoken mode). */
async function sendChat(text) {
  if (chat.busy) return;
  const input = $("chat-input");
  const msg = (text ?? input.value).trim();
  if (!msg) return;
  chat.busy = true;
  $("chat-send").disabled = true;
  const epoch = chat.epoch;
  input.value = "";
  // A pending bubble (live caption from browser STT) becomes the final user message.
  const pending = $("chat-log").querySelector(".msg.user[data-pending]");
  if (pending) {
    pending.textContent = msg;
    pending.removeAttribute("data-pending");
  } else {
    appendMsg("user", msg);
  }
  chat.turns.push({ role: "user", text: msg });
  chat.history.push({ role: "user", content: msg });
  if (text && chat.mode === "text") enterSpokenMode();
  appendMsg("coach", "…", true);
  // Mirror the server cap (sanitizeHistory keeps the last 30) so payloads stay bounded.
  const body = { ...providerBody(), message: msg, history: chat.history.slice(-30) };
  if (chat.mode === "interview") {
    body.mode = "interview";
    body.interview = { index: chat.interview.index, total: chat.interview.total, category: "interviews", level: "B2" };
  } else {
    body.mode = "chat";
  }
  try {
    const data = await api("/api/chat", { method: "POST", body: JSON.stringify(body) });
    if (epoch !== chat.epoch) return; // a mode switch invalidated this response
    updateLastMsg(data.reply);
    chat.history.push({ role: "assistant", content: data.reply });
    chat.turns.push({ role: "assistant", text: data.reply });
    if (chat.mode === "spoken" || chat.mode === "interview") {
      await speakChat(data.reply);
    }
    if (chat.mode === "interview" && chat.interview && !data.done) {
      if (data.nextQuestion) {
        appendMsg("coach", data.nextQuestion);
        chat.history.push({ role: "assistant", content: data.nextQuestion });
        chat.turns.push({ role: "assistant", text: data.nextQuestion });
        chat.interview.index += 1;
        showChatBadge(`Interview — question ${chat.interview.index}/${chat.interview.total}`);
        await speakChat(data.nextQuestion);
      }
    }
    if (chat.mode === "interview" && chat.interview && data.done) {
      await finishInterview();
    }
    if (data.correction) {
      appendMsg("coach", data.correction, false, "note");
      if (data.correction.length < 120) await speakChat(data.correction);
    }
    // Natural hands-free loop: after the whole turn has been said aloud,
    // hand the mic back to the user automatically in spoken modes.
    if (settings.autoConversation && (chat.mode === "spoken" || chat.mode === "interview")) {
      startChatRecording();
    }
  } catch (err) {
    if (epoch === chat.epoch) updateLastMsg(`(error) ${err.message}`);
  } finally {
    chat.busy = false;
    $("chat-send").disabled = false;
    if (epoch === chat.epoch && !chat.recording) setChatMicIdle();
  }
}

function appendMsg(role, text, isPlaceholder = false, extraClass = "") {
  const div = document.createElement("div");
  div.className = `msg ${role}${extraClass ? ` ${extraClass}` : ""}`;
  if (isPlaceholder) div.dataset.placeholder = "";
  div.textContent = text;
  $("chat-log").appendChild(div);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
  return div;
}

function updateLastMsg(text) {
  const nodes = $("chat-log").querySelectorAll(".msg.coach");
  const last = nodes[nodes.length - 1];
  last.textContent = text;
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
}

/** Update the last user bubble with a plain-text caption (safe: content is escaped). */
function updateLastUserMsg(text, live = false) {
  const nodes = $("chat-log").querySelectorAll(".msg.user");
  let last = nodes[nodes.length - 1];
  if (!last) last = appendMsg("user", "");
  last.innerHTML = `${escapeHtml(text)}${live ? '<span class="interim">…</span>' : ""}`;
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
}

// --- mic / spoken input ---

function toggleChatMic() {
  if (chat.recording) {
    if (settings.stt === "whisper" && chat.recorder) {
      transcribeChatRecording();
    } else {
      chat.stt?.stop(); // onEnd fires and sends the turn
    }
  } else {
    startChatRecording();
  }
}

async function startChatRecording() {
  if (chat.recording) return;
  const engine = settings.stt === "whisper" ? "whisper" : "browser";
  if (engine === "browser" && !new BrowserSTT({}).isSupported()) {
    toast("Speech recognition unavailable — type your message instead.");
    return;
  }
  chat.recording = true;
  setChatMicRecording();
  $("chat-listening").classList.remove("hidden");
  $("chat-listening").textContent = "Listening…";
  if (engine === "whisper") {
    chat.recorder = new WaveRecorder({
      onSilenceStop: async () => {
        // Whisper detected sustained silence: transcribe and send the turn.
        await transcribeChatRecording();
      },
    });
    try {
      await chat.recorder.start();
    } catch (err) {
      alert(`Microphone error: ${err.message}`);
      stopChatRecording();
    }
  } else {
    startBrowserRecordingChat();
  }
}

/** Start a browser (Web Speech) recording for a chat message. */
function startBrowserRecordingChat() {
  if (chat.recording) return;
  chat.recording = true;
  setChatMicRecording();
  $("chat-listening").classList.remove("hidden");
  $("chat-listening").textContent = "Listening…";
  const bubble = appendMsg("user", "");
  bubble.dataset.pending = "";
  chat.stt = new BrowserSTT({
    onInterim: (t) => {
      updateLastUserMsg(t, true);
    },
    onEnd: () => {
      const text = chat.stt?.result();
      chat.stt = null;
      stopChatRecording();
      if (text) {
        sendChat(text);
      } else {
        updateLastUserMsg("Nothing heard — try again.");
      }
    },
    onError: (e) => {
      if (e.error === "not-allowed") {
        alert("Microphone permission denied. Allow it in Chrome and try again.");
        stopChatRecording();
      }
    },
  });
  let started = false;
  try {
    started = chat.stt.start() !== false;
  } catch {
    started = false;
  }
  if (!started) {
    chat.stt = null;
    stopChatRecording();
  }
}

/** Stop whisper recording and transcribe the captured audio. */
async function transcribeChatRecording() {
  const blob = chat.recorder.stop();
  chat.recorder = null;
  $("chat-listening").textContent = "Transcribing locally…";
  let fallbackStarted = false;
  try {
    const { text } = await api("/api/transcribe", { method: "POST", body: blob });
    stopChatRecording();
    if (text) {
      sendChat(text);
    } else {
      updateLastUserMsg("Nothing heard — try again.");
    }
  } catch (err) {
    if (isModelDownloaded(err)) {
      stopChatRecording();
      appendMsg("coach", `${err.message} — press the mic and record again.`, false, "note");
    } else {
      warnChatFallback();
      fallbackStarted = true;
      chat.recording = false;
      startBrowserRecordingChat();
    }
  } finally {
    $("chat-listening").textContent = "Listening…";
    if (!fallbackStarted) $("chat-listening").classList.add("hidden");
  }
}

/** Warn once per chat session when whisper fails and browser recognition takes over. */
function warnChatFallback() {
  if (chat.whisperWarned) return;
  chat.whisperWarned = true;
  toast("Whisper unavailable — using browser recognition");
}

function stopChatRecording() {
  chat.recording = false;
  $("chat-listening").classList.add("hidden");
  $("chat-listening").textContent = "Listening…";
  setChatMicIdle();
  if (chat.stt) {
    chat.stt.stop();
    chat.stt = null;
  }
  if (chat.recorder) {
    chat.recorder.cancel();
    chat.recorder = null;
  }
}

function setChatMicRecording() {
  const mic = $("chat-mic");
  mic.textContent = "⏹";
  mic.classList.add("recording");
  mic.title = "Stop recording";
}

function setChatMicIdle() {
  const mic = $("chat-mic");
  mic.textContent = "🎤";
  mic.classList.remove("recording");
  mic.title = "Speak your message";
  mic.disabled = false;
}

/** Speak a coach reply; the mic stays locked until TTS finishes. */
async function speakChat(text) {
  $("chat-mic").disabled = true;
  try {
    await tts.speak(text, { rate: settings.rate, voiceURI: settings.voice, piperVoice: settings.piperVoice });
  } finally {
    $("chat-mic").disabled = false;
  }
}

// --- modes ---

function showChatBadge(text) {
  const badge = $("chat-mode-badge");
  badge.textContent = text;
  badge.classList.remove("hidden");
}

function enterSpokenMode() {
  chat.mode = "spoken";
  if (!chat.sessionId) chat.sessionId = crypto.randomUUID();
  showChatBadge("Spoken mode — reply aloud");
  $("chat-end-session").classList.remove("hidden");
}

async function startInterview() {
  if (chat.mode === "interview") return;
  if (chat.recording) stopChatRecording();
  chat.epoch++; // invalidate in-flight /api/chat responses
  $("chat-interview").disabled = true;
  try {
    const data = await api("/api/interview/start", {
      method: "POST",
      body: JSON.stringify({ ...providerBody(), category: "interviews", level: "B2" }),
    });
    chat.mode = "interview";
    if (!chat.sessionId) chat.sessionId = crypto.randomUUID();
    chat.history = [];
    chat.turns = [];
    chat.interview = { topic: data.topic, total: data.total, index: 1 };
    $("chat-log").innerHTML = "";
    $("interview-score").classList.add("hidden");
    $("interview-score").innerHTML = "";
    appendMsg("coach", data.question);
    chat.history.push({ role: "assistant", content: data.question });
    chat.turns.push({ role: "assistant", text: data.question });
    showChatBadge(`Interview — question 1/${data.total}`);
    $("chat-end-session").classList.remove("hidden");
    await speakChat(data.question);
    if (settings.autoConversation) startChatRecording();
  } catch (err) {
    alert(`Could not start the interview: ${err.message}`);
  } finally {
    $("chat-interview").disabled = chat.mode === "interview";
  }
}

/** Score and save the finished interview; returns false when scoring failed. */
async function finishInterview() {
  showChatBadge("Interview complete");
  $("chat-interview").disabled = false;
  if (!chat.turns.some((t) => t.role === "user")) {
    chat.mode = "text";
    $("chat-end-session").classList.add("hidden");
    return true;
  }
  try {
    const data = await api("/api/interview/score", {
      method: "POST",
      body: JSON.stringify({ transcript: buildChatTranscript(), level: "B2", ...providerBody() }),
    });
    renderInterviewScore(data);
    await saveChatSession("interview", data);
    chat.mode = "text";
    $("chat-end-session").classList.add("hidden");
    return true;
  } catch (err) {
    alert(`Could not score the interview: ${err.message}`);
    return false;
  }
}

function buildChatTranscript() {
  return chat.turns.map((t) => (t.role === "user" ? `A: ${t.text}` : `Q: ${t.text}`)).join("\n");
}

function renderInterviewScore(data) {
  const el = $("interview-score");
  el.classList.remove("hidden");
  const score = data.score;
  const color = score >= 70 ? "#34d399" : score >= 50 ? "#fbbf24" : "#f87171";
  const verdict = score >= 70 ? "Great interview!" : score >= 50 ? "Solid effort — keep practicing." : "Good start — review the feedback below.";
  const strengths = (data.strengths ?? []).map((s) => `<div class="tip">${escapeHtml(s)}</div>`).join("");
  const improvements = (data.improvements ?? []).map((i) => `<div class="issue"><span class="cat">Improve</span> — ${escapeHtml(i)}</div>`).join("");
  el.innerHTML = `
    <div class="interview-score-head">Interview score</div>
    <div class="score-row">
      <div class="score-ring" style="background:conic-gradient(${color} ${score * 3.6}deg, var(--panel-2) 0deg)">
        <span class="score-num" style="color:${color}">${score}</span>
      </div>
      <div class="verdict-text">${verdict}</div>
    </div>
    <div class="issues">${improvements || `<div class="tip">No improvements needed — clean interview.</div>`}</div>
    <div class="tips">${strengths || `<div class="tip">No strengths recorded.</div>`}</div>`;
}

async function endChatSession() {
  let ok = true;
  if (chat.mode === "interview") {
    ok = await finishInterview();
  } else if (chat.turns.length > 0) {
    await saveChatSession("chat");
  }
  if (ok) {
    resetChatSession();
    toast("Session saved");
  }
}

function resetChatSession() {
  stopChatRecording();
  chat.mode = "text";
  chat.history = [];
  chat.turns = [];
  chat.sessionId = null;
  chat.interview = null;
  chat.whisperWarned = false;
  $("chat-log").innerHTML = "";
  $("chat-mode-badge").classList.add("hidden");
  $("chat-end-session").classList.add("hidden");
  $("chat-interview").disabled = false;
  $("chat-listening").classList.add("hidden");
  setChatMicIdle();
}

async function saveChatSession(category, scoreData) {
  const firstUserTurn = chat.turns.find((t) => t.role === "user");
  const payload = {
    id: chat.sessionId,
    category,
    level: "B2",
    provider: settings.provider,
    question: firstUserTurn?.text ?? "Free spoken conversation",
    context: chat.interview?.topic ?? category,
    turns: chat.turns,
  };
  if (category === "interview" && scoreData) {
    payload.fragments = [
      {
        id: "overall",
        stage: "Interview",
        text: chat.interview?.topic ?? "Overall",
        attempts: [
          {
            text: buildChatTranscript(),
            score: scoreData.score,
            missing: [],
            extra: [],
            issues: (scoreData.improvements ?? []).map((i) => ({ category: "other", message: i })),
            verdict: scoreData.score >= 70 ? "great" : "almost",
          },
        ],
        passed: scoreData.score >= 70,
      },
    ];
  }
  try {
    const r = await api("/api/session/save", { method: "POST", body: JSON.stringify(payload) });
    if (r.nextStep) toast(`Next step: ${r.nextStep.focus}`);
  } catch (err) {
    alert(`Could not save the session: ${err.message}`);
  }
}

// ---------- progress ----------
async function loadProgress() {
  try {
    const [p, h] = await Promise.all([api("/api/profile"), api("/api/history")]);
    renderSnapshot(p);
    renderWeak(p);
    renderTrend(p);
    renderVocab(p);
    renderNextStep(p.profile.nextStep);
    renderHistory(h.sessions);
  } catch (err) {
    console.error("progress load failed", err);
  }
}

function renderSnapshot(p) {
  const s = p.stats;
  $("progress-snapshot").innerHTML = `
    <div class="stat-row"><span>Level</span><b>${escapeHtml(p.profile.level)}</b></div>
    <div class="stat-row"><span>Sessions</span><b>${s.sessions}</b></div>
    <div class="stat-row"><span>Average score</span><b>${s.avg}/100</b></div>`;
  for (const [cat, c] of Object.entries(s.byCategory)) {
    $("progress-snapshot").insertAdjacentHTML(
      "beforeend",
      `<div class="stat-row"><span>${escapeHtml(cat)}</span><b>${c.avgScore} (${c.sessions})</b></div>`,
    );
  }
}

function renderWeak(p) {
  const el = $("progress-weak");
  const weak = p.stats.weakErrorsTop;
  el.innerHTML = "";
  if (weak.length === 0) {
    el.textContent = "No recurring weaknesses yet. Practice a few sessions.";
    return;
  }
  for (const [cat, n] of weak) {
    const div = document.createElement("div");
    div.className = "stat-row";
    div.innerHTML = `<span>${escapeHtml(cat)}</span><b>${n}×</b>`;
    el.appendChild(div);
  }
}

function renderTrend(p) {
  const el = $("trend-chart");
  const trend = p.stats.trend.slice(-24);
  el.innerHTML = "";
  if (trend.length === 0) {
    el.textContent = "No scores yet.";
    return;
  }
  const chart = document.createElement("div");
  chart.className = "chart";
  for (const s of trend) {
    const bar = document.createElement("div");
    bar.className = `bar ${s < 50 ? "low" : s < 70 ? "mid" : ""}`;
    bar.style.height = `${Math.max(6, s)}%`;
    bar.title = `Attempt score: ${s}`;
    chart.appendChild(bar);
  }
  el.appendChild(chart);
}

function renderVocab(p) {
  const el = $("progress-vocab");
  const gaps = p.stats.vocabGaps ?? [];
  el.innerHTML = "";
  if (gaps.length === 0) {
    el.textContent = "No vocabulary gaps detected yet.";
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "pill-list";
  for (const w of gaps) {
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = w;
    wrap.appendChild(pill);
  }
  el.appendChild(wrap);
}

function renderNextStep(ns) {
  const el = $("next-step-box");
  if (!ns) {
    el.innerHTML = `<span class="muted">Finish a session to unlock a personalized recommendation.</span>`;
    return;
  }
  el.innerHTML = `
    <div class="focus">${escapeHtml(ns.focus)}</div>
    <div>Topic: <b>${escapeHtml(ns.topic)}</b></div>
    <div>Target level: ${escapeHtml(ns.targetLevel)}</div>
    <div class="muted" style="margin-top:6px">${escapeHtml(ns.why)}</div>`;
}

function renderHistory(sessions) {
  const el = $("session-history");
  el.innerHTML = "";
  if (sessions.length === 0) {
    el.textContent = "No sessions yet.";
    return;
  }
  for (const s of sessions.reverse()) {
    const div = document.createElement("div");
    div.className = "history-item";
    div.innerHTML = `<span class="q">${escapeHtml(s.question)}</span>
      <span class="meta">${escapeHtml(s.category)} · ${escapeHtml(s.level)} · score ${escapeHtml(String(s.avgScore ?? "–"))}<br/>${new Date(s.date).toLocaleString()}</span>`;
    el.appendChild(div);
  }
}

$("btn-refresh-next").addEventListener("click", async () => {
  $("btn-refresh-next").disabled = true;
  try {
    const r = await api("/api/next-step", { method: "POST" });
    renderNextStep(r.nextStep);
  } catch (err) {
    alert(`Failed: ${err.message}`);
  } finally {
    $("btn-refresh-next").disabled = false;
  }
});

// ---------- utils ----------
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toast(msg) {
  const el = document.createElement("div");
  el.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#2a303c;color:#fff;padding:12px 18px;border-radius:10px;z-index:50;box-shadow:0 6px 20px rgba(0,0,0,.4);font-size:14px`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}