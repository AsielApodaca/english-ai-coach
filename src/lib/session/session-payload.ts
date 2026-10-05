import { buildFullLine, readPassThreshold } from "../practice/karaoke.ts";
import { readAutoAdvance } from "../settings.ts";
import type { SessionQuestion, SessionV2 } from "./storage.ts";

// ---------------------------------------------------------------------------
// GET /api/session/:id response payload (feature 105; contract trimmed by 115)
//
// Extracted from the route as a pure function so the payload shape can be
// unit-tested without importing server.ts (which binds a port on import):
// same pattern as `handleSessionStartRequest` (session-start.ts) and
// `handleNextQuestionRequest` (continuous.ts).
//
// Feature 115 removed the opening-speech fields (`intro`, `explainLine`) from
// this contract: the session now starts at the question, and the model answer
// hands over directly to the first fragment. `fullLine` (the instruction read
// before the whole answer) is kept.
// ---------------------------------------------------------------------------

/** The question served to the view: a projection of the stored question. */
export type SessionPayloadQuestion = Pick<SessionQuestion, "q" | "answer" | "fragments">;

/** Body served by `GET /api/session/:id` — no `intro`/`explainLine` (feature 115). */
export interface SessionPayload {
  session: SessionV2;
  fullLine: string;
  passThreshold: number;
  autoAdvance: boolean;
  question: SessionPayloadQuestion | null;
}

/**
 * Build the JSON body of `GET /api/session/:id`.
 *
 * Serves the stored v2 session plus the lines and flags the view needs to run
 * the CU2 flow without importing server-side modules: the full-answer
 * instruction (`fullLine`) and the pass threshold / auto-advance flag read
 * from the session's settings snapshot (features 108 / 107). The question
 * served is the LAST one — continuous sessions (107) grow `questions[]` —
 * or `null` when the session carries none.
 */
export function buildSessionPayload(session: SessionV2): SessionPayload {
  const question = session.questions.at(-1);
  return {
    session,
    fullLine: buildFullLine(),
    passThreshold: readPassThreshold(session.config.settingsSnapshot),
    autoAdvance: readAutoAdvance(session.config.settingsSnapshot),
    question: question
      ? { q: question.q, answer: question.answer, fragments: question.fragments }
      : null,
  };
}
