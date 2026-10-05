// ---------------------------------------------------------------------------
// Continuous session flow (feature 107) — pure, side-effect free.
//
// Turns the single-question practice (105) into a continuous session
// (Q1 → Q∞): the same v2 session keeps growing its `questions[]` array, one
// question per `next-question` call, until the user finishes the session.
//
// On LLM failure the session stays `active` and the client can retry from the
// last saved question — nothing is lost (spec 107 NFR).
//
// Feature 117 split; this file recomposes the module, so every existing
// `from "./continuous.ts"` import keeps resolving unchanged:
//   - continuous-adaptive.ts — rolling scores + computeAdaptive (clamps)
//   - continuous-generate.ts — SYSTEM_NEXT_QUESTION + generateNextQuestion
//                              + buildContextSummary
//   - continuous-handler.ts  — handleNextQuestionRequest + its deps/response
// ---------------------------------------------------------------------------

export * from "./continuous-adaptive.ts";
export * from "./continuous-generate.ts";
export * from "./continuous-handler.ts";
