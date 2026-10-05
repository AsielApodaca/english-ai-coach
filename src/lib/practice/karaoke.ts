// ---------------------------------------------------------------------------
// CU2 practice state machine (feature 105) — pure, side-effect free.
//
// Models the karaoke practice flow of use case CU2 as a deterministic state
// machine driven by TTS/STT events. The view (public/ui/practice-view.js) is
// the effectful layer: it speaks, records and calls the API, then dispatches
// events into this reducer (TTS/STT events, plus CHIME_END — the success
// chime of feature 110 — for a passing attempt). Keeping the reducer pure
// makes the transitions unit-testable without audio, network or DOM.
//
// Phases (feature 115: the session opens straight at the question, with no
// spoken preamble before it and no spoken explanation after the model answer):
//   question → model → repeatingFragment ⇄ feedback
//            → fullAnswer → done
//
// The LOOP (repeatingFragment ↔ feedback) runs once per fragment; a failed
// attempt (score < passThreshold) retries the same fragment. After the last
// fragment passes, the flow moves to the full answer, and after it passes the
// session is done.
//
// Feature 117 split the module; this file recomposes it, so every existing
// `from "./karaoke.ts"` import keeps resolving unchanged:
//   - karaoke-state.ts       — types, initial state, `reducePractice`, queries
//   - karaoke-transitions.ts — the private transition handlers reducePractice uses
//   - karaoke-lines.ts       — spoken lines + `DEFAULT_PASS_THRESHOLD`/`readPassThreshold`
// ---------------------------------------------------------------------------

export * from "./karaoke-state.ts";
export * from "./karaoke-transitions.ts";
export * from "./karaoke-lines.ts";
