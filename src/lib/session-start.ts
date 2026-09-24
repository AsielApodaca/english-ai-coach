import { buildDocumentContext, type ExtractedFile } from "./extract.ts";
import { buildLearnerMemory, deriveSessionTitle } from "./learner.ts";
import { generateFirstQuestion, type Candidate } from "./practice.ts";
import { buildSettingsSnapshot, mergeSettings, parseLocalSettings, profileSettings } from "./settings.ts";
import {
  DEFAULT_ACCENT,
  isLevel,
  type ContextFileRef,
  type CreateSessionOptions,
  type FileKind,
  type Profile,
  type SessionConfig,
  type SessionV2,
} from "./storage.ts";

// ---------------------------------------------------------------------------
// POST /api/session/start handler (feature 103 / CU1)
//
// Wraps session creation (feature 102) + first-question generation (practice.ts)
// into a single endpoint. The user's role instruction becomes the system persona
// and the topic prompt is passed as context; learner memory is always included
// (project rule) and attached context files are injected as a DOCUMENT CONTEXT
// block (feature 104). NO session is created until this endpoint is hit (CU3).
//
// The handler is extracted from the route so it can be unit-tested without HTTP
// or network: LLM calls go through the injected `candidates` (same pattern as
// `handleExtractRequest` in extract.ts).
// ---------------------------------------------------------------------------

const FILE_KINDS: FileKind[] = ["pdf", "docx", "txt", "md"];

function isFileKind(v: unknown): v is FileKind {
  return typeof v === "string" && (FILE_KINDS as string[]).includes(v);
}

/** Minimal persistence surface the session-start handler needs (storage.ts). */
export interface SessionStartDeps {
  loadProfile(): Profile;
  loadAllSessions(): SessionV2[];
  loadContextText(bucket: string, textRef: string): string | undefined;
  createSession(config: SessionConfig, opts?: CreateSessionOptions): string;
  loadSession(id: string): SessionV2 | undefined;
  saveSession(session: SessionV2): void;
}

export interface SessionStartResponse {
  status: number;
  json: Record<string, unknown>;
}

/**
 * Handle a `POST /api/session/start` request body and return the HTTP response.
 *
 * Validates `topicPrompt` (non-empty) and `level` (A1–C2), loads learner memory,
 * resolves attached context files to their extracted text (draft bucket, feature
 * 104), generates the first question + a session title, creates the v2 session
 * with the config snapshot and persists the first question into it.
 *
 * Returns `{ sessionId, firstQuestion }` on success; `{ error }` with 400 for
 * validation failures or 502 when the LLM generation fails (no session is
 * created in either case).
 */
export async function handleSessionStartRequest(
  deps: SessionStartDeps,
  candidates: Candidate[],
  body: unknown,
): Promise<SessionStartResponse> {
  const { topicPrompt, level, contextFiles, accent, focusPhonemes, settings } = (body ?? {}) as Record<string, unknown>;
  if (typeof topicPrompt !== "string" || topicPrompt.trim().length === 0) {
    return { status: 400, json: { error: "topicPrompt is required." } };
  }
  if (!isLevel(level)) {
    return { status: 400, json: { error: "Invalid level. Expected one of: A1, A2, B1, B2, C1, C2." } };
  }

  const profile = deps.loadProfile();
  const sessions = deps.loadAllSessions();
  const learnerMemory = buildLearnerMemory(profile, sessions);

  // Settings snapshot (feature 108): merge the device prefs sent by the
  // frontend (localStorage) over the profile-persisted settings, then capture
  // the training keys into the session config so it is self-contained.
  const localSettings = settings && typeof settings === "object" ? parseLocalSettings(settings as Record<string, unknown>) : {};
  const mergedSettings = mergeSettings({ local: localSettings, profile: profileSettings(profile) });
  const settingsSnapshot = buildSettingsSnapshot(mergedSettings);

  // Resolve attached context files to their extracted text (draft bucket) and
  // build the DOCUMENT CONTEXT block (feature 104). Files whose text is missing
  // are skipped defensively — they only enrich the prompt.
  const files: ExtractedFile[] = [];
  if (Array.isArray(contextFiles)) {
    for (const entry of contextFiles) {
      if (!entry || typeof entry !== "object") continue;
      const f = entry as Partial<ContextFileRef>;
      if (typeof f.textRef !== "string" || !f.textRef) continue;
      const text = deps.loadContextText("draft", f.textRef);
      if (text === undefined) continue;
      files.push({
        name: typeof f.name === "string" && f.name ? f.name : "file",
        size: typeof f.size === "number" ? f.size : 0,
        kind: isFileKind(f.kind) ? f.kind : "txt",
        text,
        textRef: f.textRef,
        truncated: false,
      });
    }
  }
  const documentContext = buildDocumentContext(files);

  try {
    const { question, provider } = await generateFirstQuestion(candidates, {
      topicPrompt: topicPrompt.trim(),
      level,
      learnerMemory,
      documentContext: documentContext || undefined,
    });
    const { title } = await deriveSessionTitle(candidates, topicPrompt.trim());

    const config: SessionConfig = {
      topicPrompt: topicPrompt.trim(),
      level,
      category: "free",
      accent: typeof accent === "string" && accent.trim() ? accent.trim() : DEFAULT_ACCENT,
      phonemes: Array.isArray(focusPhonemes) ? focusPhonemes.filter((p): p is string => typeof p === "string") : [],
      contextFiles: files.map(({ name, size, kind, textRef }) => ({ name, size, kind, textRef })),
      settingsSnapshot,
    };

    const sessionId = deps.createSession(config, { title, provider });
    const session = deps.loadSession(sessionId);
    if (session) {
      session.questions = [
        {
          q: question.q,
          answer: question.answer,
          // Fragments must carry an attempts array from birth: consumers
          // (persistAttempt, computeStats) assume it exists.
          fragments: question.fragments.map((f) => ({ ...f, attempts: [], passed: false })),
          fullAttempt: null,
          eval: null,
        },
      ];
      deps.saveSession(session);
    }
    return { status: 200, json: { sessionId, firstQuestion: question } };
  } catch (err) {
    return { status: 502, json: { error: (err as Error).message } };
  }
}