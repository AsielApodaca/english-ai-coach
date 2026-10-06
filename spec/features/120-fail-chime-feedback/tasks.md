# 120 · Fail chime instead of the spoken retry line — Tasks

- [x] Trim `buildFeedbackText`'s fail branch in `src/lib/practice/karaoke-lines.ts` to the focus hint only (or `""`); document the contract in the JSDoc.
- [x] Generalize `playSuccessChime()` → `playAttemptChime(kind)` in `public/ui/practice-view.js` (same `CHIME_MAX_MS` cap and volume clamp).
- [x] Redesign the `fail` cue in `public/speech/chime.js`: note schedule (`notes[]`), descending 523 → 349 Hz sequence with its own envelope per note, loudness equal to `pass`, and drop/recreate a `closed` AudioContext.
- [x] Fragment loop: replay → `playAttemptChime("fail")` → awaited refinement → guarded `speak(refinedLine)`.
- [x] Full-answer loop: same treatment; both pass call sites switch to `playAttemptChime("pass")`.
- [x] `tests/karaoke.test.ts`: fail line assertions (exact focus hint, no opener) + empty-line case.
- [x] `tests/chime.test.ts`: fail plan (descending, not quieter than pass) + view wiring (2 pass / 2 fail call sites, chime before the guarded speak, opener gone).
- [x] `tests/refinement.test.ts`: guarded speak in both fail loops.
- [x] Update this folder, the roadmap entry, and the stale statements in `../110-success-chime/spec.md`, `../105-karaoke-practice-cu2/spec.md`, `../../use-cases/CU2.md`.
- [x] `npm run check` and `npm test` green.
- [ ] Manual: fail a fragment → fail chime after your replay → focus hint (or silence) → same fragment re-read.
- [ ] Manual: fail the full answer → same treatment; pass keeps the pass chime with no congratulation.
