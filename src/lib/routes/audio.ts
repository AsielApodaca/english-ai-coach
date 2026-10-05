/**
 * Audio routes: STT (whisper) and TTS (Piper/edge-tts) (features 002/007/114).
 *
 * Route contracts (JSDoc blocks moved verbatim from server.ts in feature 117):
 *   POST /api/transcribe     — whisper transcription of a raw WAV
 *   GET  /api/whisper/status — whisper readiness for the STT picker
 *   GET  /api/tts/status     — TTS engine readiness
 *   GET  /api/tts            — synthesized audio (cached, pause-aware)
 */

import express, { type Express } from "express";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { checkWhisper, DEFAULT_WHISPER_MODEL, downloadModel, transcribeWav, transcribeWords } from "../audio/whisper.ts";
import { isWavBuffer } from "../audio/wav.ts";
import { clampNumber, queryList, ttsStatus } from "../audio/tts-status.ts";
import { ttsCacheKey, withTtsCache } from "../audio/tts-cache.ts";
import { isVoiceReady, synthesizeSegments as piperSynthesizeSegments, DEFAULT_VOICE, SUPPORTED_VOICES } from "../audio/piper.ts";
import { synthesizeEdge, DEFAULT_EDGE_VOICE } from "../audio/edge-tts.ts";
import { splitForTts } from "../audio/prosody.ts";
import type { AppDeps } from "../app.ts";

const TTS_MAX_CHARS = 1000;
const TTS_MAX_PAUSE_MS = 10_000;
/** Segment cap checked BEFORE the cache is consulted (feature 114). */
const TTS_MAX_SEGMENTS = 40;
const RATE_MIN = 0.5;
const RATE_MAX = 2;

/**
 * Register the STT/TTS routes.
 *
 * @param app - Express instance under construction (createApp)
 * @param deps - injected dependencies (storage, ttsCache, rootDir, env, …)
 */
export function registerAudioRoutes(app: Express, deps: AppDeps): void {
  const whisperModel = deps.env.WHISPER_MODEL ?? DEFAULT_WHISPER_MODEL;

  /**
   * POST /api/transcribe — whisper transcription of a raw WAV (feature 002).
   *
   * Input: raw binary body (Content-Type audio/*, ≤ 80 MB) — NOT JSON; optional
   *   query `words=1|true` to also return word-level timestamps.
   * 200 → { text, durationMs }  |  { text, words: WhisperWord[], durationMs }
   *        (words only with `words=1`).
   * 400 { error } → empty body, a body that is not a RIFF/WAVE file (checked
   *   BEFORE anything touches the disk — feature 117), whisper binary not
   *   installed (message = hint), or the model had just been downloaded — this
   *   last answer carries `code: "MODEL_DOWNLOADED"` (spec 002) and the client
   *   must record again.
   * 500 { error } → model download failed, or the transcription itself failed.
   * The temp WAV is written under data/tmp/ with a random name and always
   * removed (finally), success or failure.
   */
  app.post("/api/transcribe", express.raw({ type: "audio/*", limit: "80mb" }), async (req, res) => {
    const buf = req.body as Buffer | undefined;
    if (!buf || buf.length === 0) return res.status(400).json({ error: "No audio received." });
    if (!isWavBuffer(buf)) return res.status(400).json({ error: "Body is not a RIFF/WAVE (WAV) audio file." });
    const whisper = checkWhisper(whisperModel, deps.rootDir);
    if (!whisper.available) return res.status(400).json({ error: whisper.hint });
    if (!whisper.modelReady) {
      try {
        await downloadModel(whisperModel, deps.rootDir);
      } catch (err) {
        return res.status(500).json({ error: `Model download failed: ${(err as Error).message}` });
      }
      return res.status(400).json({ error: "Model downloaded. Please record again.", code: "MODEL_DOWNLOADED" });
    }
    const tmpDir = join(deps.rootDir, "data", "tmp");
    mkdirSync(tmpDir, { recursive: true });
    const wavPath = join(tmpDir, `rec-${randomUUID()}.wav`);
    writeFileSync(wavPath, buf);
    const withWords = req.query.words === "1" || req.query.words === "true";
    try {
      if (withWords) {
        const result = await transcribeWords(wavPath, whisper.modelPath!, deps.rootDir);
        res.json({ text: result.text, words: result.words, durationMs: result.durationMs });
      } else {
        const result = await transcribeWav(wavPath, whisper.modelPath!, deps.rootDir);
        res.json({ text: result.text, durationMs: result.durationMs });
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    } finally {
      rmSync(wavPath, { force: true });
    }
  });

  /**
   * GET /api/whisper/status — whisper readiness for the STT picker (feature 002).
   *
   * No input. 200 → { available: boolean, binary: string | null,
   *   modelName, modelFile, modelReady: boolean, modelPath: string | null,
   *   hint: string }.
   * Total by design: a missing binary or model is reported as available:false /
   * modelReady:false with the install hint, never as an error status. The same
   * payload (minus binary/modelPath) is embedded in GET /api/health.
   */
  app.get("/api/whisper/status", (_req, res) => {
    res.json(checkWhisper(whisperModel, deps.rootDir));
  });

  /** Report TTS readiness for the frontend (same shape as `/api/health`'s tts). */
  app.get("/api/tts/status", (_req, res) => {
    res.json(ttsStatus(deps.env, deps.rootDir));
  });

  /**
   * Serve TTS audio as a binary file (features 007 + 114).
   *
   * Query params:
   *   text         — text to speak (required unless `segments` is given; ≤ 1000
   *                  chars). The server runs the clause splitter itself, so
   *                  plain-text callers get human pauses too.
   *   segments     — repeatable: pre-split clauses (preferred; feature 114 — the
   *                  frontend splits and sends `pausesMs` alongside).
   *   pausesMs     — repeatable: silence AFTER each segment (one per segment,
   *                  ≤ 10 s each). When absent, the legacy contract applies:
   *                  `pauseAfterMs` = silence BETWEEN segments, no trailing beat.
   *   pauseAfterMs — for the `text` route: overrides the trailing handover pause.
   *   rate         — speed factor 0.5–2 (Piper length_scale / edge --rate);
   *                  pauses stay fixed in ms (they are not scaled).
   *   voice        — Piper voice id; unsupported → 400, supported-but-not-
   *                  downloaded → silently falls back to the default voice.
   *
   * Engine chain (server-side): Piper → edge-tts (unless OFFLINE_MODE) →
   * 503 so the frontend can fall back to browser `speechSynthesis`.
   *
   * Response headers: `X-TTS-Cache: hit|miss` (feature 114 synthesis cache —
   * key = sha1(engine|voice|rate|segments|pauses), LRU + 24 h TTL under
   * `data/tmp/tts-cache/`) and `X-TTS-Pauses: measured|none` (whether the
   * served bytes actually contain the requested silences: Piper yes, edge MP3
   * no — the karaoke keys its pause-aware schedule on it). Piper output is
   * level-normalized and faded server-side (`normalizeWav`); edge MP3 is
   * served as-is (client gain, see `public/speech/level.js`).
   */
  app.get("/api/tts", async (req, res) => {
    const rawSegments = queryList(req.query.segments);
    const rawPauses = queryList(req.query.pausesMs);
    const text = typeof req.query.text === "string" ? req.query.text.trim() : "";
    const hasPauseAfter = "pauseAfterMs" in req.query;
    const pauseAfterMs = clampNumber(req.query.pauseAfterMs, 0, TTS_MAX_PAUSE_MS, 0);
    const rate = clampNumber(req.query.rate, RATE_MIN, RATE_MAX, 1);
    const voiceParam = typeof req.query.voice === "string" && req.query.voice ? req.query.voice : undefined;

    // --- resolve segments + the silence after each one (feature 114) ---
    let segments: string[];
    let pausesMs: number[];

    if (rawSegments.length) {
      // Explicit segments: the client already split the line into clauses.
      // Empty entries are dropped FIRST so the pause count is validated against
      // the segments that will actually be synthesized (the error message stays
      // accurate and `pausesMs` cannot drift out of sync — review fix #4).
      segments = rawSegments.map((s) => s.trim()).filter(Boolean);
      if (rawPauses.length) {
        if (rawPauses.length !== segments.length) {
          return res.status(400).json({
            error: `pausesMs must have one entry per segment (${segments.length} expected).`,
          });
        }
        pausesMs = rawPauses.map((p) => clampNumber(p, 0, TTS_MAX_PAUSE_MS, 0));
      } else {
        // Legacy contract (pre-114 callers): pauseAfterMs = between segments.
        pausesMs = segments.map((_, i) => (i < segments.length - 1 ? pauseAfterMs : 0));
      }
    } else if (text) {
      // Plain text: split server-side so curl/old clients get the same prosody.
      const split = splitForTts(text);
      segments = split.segments;
      pausesMs = split.pausesMs;
      // An explicit pauseAfterMs keeps its legacy meaning: the trailing beat.
      if (hasPauseAfter && pausesMs.length) pausesMs[pausesMs.length - 1] = pauseAfterMs;
    } else {
      return res.status(400).json({ error: "text or segments query parameter is required." });
    }

    const totalChars = segments.reduce((sum, s) => sum + s.length, 0);
    if (!segments.length || totalChars === 0) {
      return res.status(400).json({ error: "Text must not be empty." });
    }
    if (totalChars > TTS_MAX_CHARS) {
      return res.status(400).json({ error: `Text exceeds ${TTS_MAX_CHARS} character limit.` });
    }
    if (segments.length > TTS_MAX_SEGMENTS) {
      return res.status(400).json({ error: `Too many segments (max ${TTS_MAX_SEGMENTS}).` });
    }

    const status = ttsStatus(deps.env, deps.rootDir);
    if (status.engine === null) {
      return res.status(503).json({
        error: "tts-unavailable",
        hint: status.piper.hint || status.edge.hint || "No local TTS engine is installed.",
      });
    }

    // Voice selection only applies to Piper; edge-tts keeps its default voice.
    // A supported but not-downloaded voice falls back to the default one so a
    // stale settings value degrades instead of failing the read (feature 114).
    let effectiveVoice: string;
    if (status.engine === "piper") {
      if (voiceParam && !SUPPORTED_VOICES.includes(voiceParam)) {
        return res.status(400).json({ error: `Unsupported voice "${voiceParam}". Supported: ${SUPPORTED_VOICES.join(", ")}.` });
      }
      effectiveVoice = voiceParam && isVoiceReady(deps.rootDir, voiceParam) ? voiceParam : DEFAULT_VOICE;
    } else {
      effectiveVoice = DEFAULT_EDGE_VOICE;
    }

    // Validate BEFORE touching the cache (spec 114: limits checked first).
    const key = ttsCacheKey({ engine: status.engine, voice: effectiveVoice, rate, segments, pauses: pausesMs });

    try {
      const { audio, cacheHit } = await withTtsCache(deps.ttsCache, key, async () => {
        if (status.engine === "piper") {
          // Per-segment normalization + measured silence happen inside
          // `synthesizeSegments` (RMS target, peak ceiling, anti-click fades).
          return piperSynthesizeSegments(segments, deps.rootDir, {
            pausesAfterMs: pausesMs,
            lengthScale: 1 / rate,
            voice: effectiveVoice,
          });
        }
        // edge-tts (MP3): ONE synthesis of the joined line. Measured silence
        // cannot be inserted without an MP3 encoder — accepted codec limitation
        // (spec 114 "Edge MP3 sin normalización server-side"; the client gain
        // node compensates the level instead).
        return synthesizeEdge(segments.join(" "), deps.rootDir, { rate });
      });

      res.setHeader("Content-Type", status.engine === "edge-tts" ? "audio/mpeg" : "audio/wav");
      res.setHeader("Content-Length", String(audio.length));
      res.setHeader("X-TTS-Cache", cacheHit ? "hit" : "miss");
      // Only Piper inserts the requested silences into the bytes (edge joins the
      // segments without them), so the karaoke derives its pause-aware schedule
      // from THIS response instead of the possibly-stale health snapshot
      // (review major #1).
      res.setHeader("X-TTS-Pauses", status.engine === "piper" ? "measured" : "none");
      res.end(audio);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
