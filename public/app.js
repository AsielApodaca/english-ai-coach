import { BrowserTTS } from "./speech/browser-tts.js";
import { BrowserSTT } from "./speech/browser-stt.js";
import { WaveRecorder } from "./speech/recorder-wave.js";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tts = new BrowserTTS();
const settings = {
  provider: localStorage.getItem("engcoach.provider") ?? "zen",
  stt: localStorage.getItem("engcoach.stt") ?? "browser",
  voice: localStorage.getItem("engcoach.voice") ?? "",
  rate: Number(localStorage.getItem("engcoach.rate") ?? 0.95),
  autoplay: (localStorage.getItem("engcoach.autoplay") ?? "1") === "1",
};
const saveSetting = (k, v) => {
  settings[k] = v;
  localStorage.setItem(`engcoach.${k}`, String(v));
};

let whisperOk = false;
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
  api("/api/health").then((h) => {
    whisperOk = h.whisper?.available ?? false;
    renderHealth(h);
    renderWhisperStatus(h);
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
  $("set-provider").addEventListener("change", (e) => saveSetting("provider", e.target.value));
  $("set-stt").addEventListener("change", (e) => saveSetting("stt", e.target.value));
  $("set-rate").addEventListener("change", (e) => saveSetting("rate", Number(e.target.value)));
  $("set-autoplay").addEventListener("change", (e) => saveSetting("autoplay", e.target.checked));
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
  if (!w.available) {
    el.textContent =
      "Whisper (local STT) is optional. To enable it: brew install whisper-cpp, then npm run setup. For now the app uses Chrome's speech recognition.";
    return;
  }
  el.textContent = w.modelReady
    ? `Whisper ready (${w.model}). First recording downloads the model if needed.`
    : `Whisper installed. Run "npm run setup" to download the ${w.model} model (or it will download on first use).`;
  el.style.display = "";
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
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
  tts.speak(line, { rate: settings.rate, voiceURI: settings.voice });
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
  await tts.speak("Repeat after me.", { rate: settings.rate, voiceURI: settings.voice });
  await tts.speak(f.text, { rate: settings.rate, voiceURI: settings.voice });
}

$("btn-play").addEventListener("click", () => autoplayFragment(currentFragment()));

async function startRecording() {
  sess.recording = true;
  $("listening-dot").classList.remove("hidden");
  resetButtonsRecording();
  if (settings.stt === "whisper") {
    sess.recorder = new WaveRecorder();
    try {
      await sess.recorder.start();
    } catch (err) {
      alert(`Microphone error: ${err.message}`);
      stopRecording();
    }
  } else {
    sess.stt = new BrowserSTT({
      onInterim: (t) => {
        $("transcript").innerHTML = `${escapeHtml(t)}<span class="interim">…</span>`;
      },
      onEnd: () => {
        $("listening-dot").classList.add("hidden");
        const text = sess.stt?.result();
        sess.stt = null;
        sess.transcript = text ?? "";
        $("transcript").textContent = sess.transcript || "Nothing heard — try again.";
        updateCheckButton();
      },
      onError: (e) => {
        if (e.error === "not-allowed") {
          alert("Microphone permission denied. Allow it in Chrome and try again.");
          stopRecording();
        }
      },
    });
    sess.stt.start();
  }
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
    $("listening-dot").textContent = "Transcribing locally…";
    try {
      const { text } = await api("/api/transcribe", { method: "POST", body: blob });
      sess.transcript = text ?? "";
      $("transcript").textContent = sess.transcript || "Nothing heard — try again.";
      updateCheckButton();
    } catch (err) {
      $("transcript").textContent = `Transcription failed: ${err.message}`;
    } finally {
      $("listening-dot").textContent = "Listening…";
      $("listening-dot").classList.add("hidden");
      resetButtonsIdle();
    }
  } else {
    stopRecording();
    sess.transcript = sess.stt?.result() ?? sess.transcript;
    $("transcript").textContent = sess.transcript || "Nothing heard — try again.";
    updateCheckButton();
  }
});

$("btn-check").addEventListener("click", async () => {
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
});

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
  tts.speak(fullAnswerText(), { rate: settings.rate, voiceURI: settings.voice });
});

$("btn-record-full").addEventListener("click", async () => {
  sess.recording = true;
  $("listening-dot").classList.remove("hidden");
  $("btn-record-full").classList.add("hidden");
  $("btn-stop-full").classList.remove("hidden");
  if (settings.stt === "whisper") {
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
    sess.stt = new BrowserSTT({
      onInterim: (t) => ($("transcript-full").textContent = t),
      onEnd: () => {
        $("listening-dot").classList.add("hidden");
        const t = sess.stt?.result();
        sess.stt = null;
        if (t) {
          $("transcript-full").textContent = t;
          $("btn-check-full").disabled = false;
        }
      },
    });
    sess.stt.start();
  }
});

$("btn-stop-full").addEventListener("click", async () => {
  $("btn-record-full").classList.remove("hidden");
  $("btn-stop-full").classList.add("hidden");
  $("listening-dot").classList.add("hidden");
  let text = "";
  if (settings.stt === "whisper" && sess.recorder) {
    const blob = sess.recorder.stop();
    sess.recorder = null;
    try {
      const r = await api("/api/transcribe", { method: "POST", body: blob });
      text = r.text ?? "";
    } catch (err) {
      $("transcript-full").textContent = `Transcription failed: ${err.message}`;
      return;
    }
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
$("chat-send").addEventListener("click", sendChat);
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

async function sendChat() {
  const input = $("chat-input");
  const msg = input.value.trim();
  if (!msg) return;
  input.value = "";
  appendMsg("user", msg);
  appendMsg("coach", "…", true);
  try {
    const data = await api("/api/chat", { method: "POST", body: JSON.stringify({ ...providerBody(), message: msg }) });
    updateLastMsg(data.reply);
  } catch (err) {
    updateLastMsg(`(error) ${err.message}`);
  }
}

function appendMsg(role, text, isPlaceholder = false) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
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