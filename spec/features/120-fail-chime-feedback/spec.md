# 120 · Fail chime instead of the spoken retry line

**Status:** done ✅ (branch `feat/fail-chime-feedback`)

## What it does

When an attempt does not pass the threshold, the coach no longer reads
`"Almost there. That was N percent. Let's try that again."`. In the place where
that sentence used to be, the view now plays the **fail chime**
(`playChime({ kind: "fail" })`), the same short synthesized cue family as the
pass chime.

The `fail` tone itself was redesigned for this feature: the old shape (a
quieter, lower chord — it read as a softer "correcto") is now a **descending
pair played in sequence** (523 Hz → 349 Hz, 20 ms apart, its own envelope per
note), at the **same loudness as the pass cue** so it cuts through the user's
replay that precedes it.

What is still spoken is the focused correction only: `buildFeedbackText`'s fail
branch now returns `Focus on: a, b, c.` / `Drop the extra words: x, y, z.` (or
both, joined), and returns `""` when there is nothing to point at — in that
case the turn is silent apart from the chime. The score itself stays visual
(the feedback chip: `Foco en … · N%`).

Applies to **both** fail paths: the fragment loop and the full-answer loop. The
no-speech line (`buildNoSpeechText` → `"I didn't hear you. Let's try that
again."`) is untouched.

## Why

- **The score is already on screen.** Reading "that was 43 percent" out loud
  costs ~2 s of turn time to repeat information the chip shows instantly.
- **A sound is faster feedback.** The fail chime is ≤ 300 ms, keeps the
  listen → repeat → *result* rhythm tight and mirrors what the pass path
  already does (110), so the two outcomes are announced the same way.
- **Keeps the correction.** The useful part of the line — which words to focus
  on and which to drop — is unchanged; only the praise/retry preamble is gone.

## Acceptance criteria

- [x] `buildFeedbackText` fail branch returns only the focus hint
  (`Focus on: …` / `Drop the extra words: …`, joined with `". "`, or `""` when
  there is no missing/extra word); the pass branch is untouched.
- [x] The view plays `playAttemptChime("fail")` on both fail paths (fragment
  loop and full answer), after the user's replay and **before** any spoken
  hint, so the chime never overlaps TTS.
- [x] The focus hint is spoken only when non-empty: `if (refinedLine) await
  speak(refinedLine, token)` in both loops; an empty line means silence after
  the chime.
- [x] The pass path keeps its chime, order and timing (`playAttemptChime("pass")`
  with the same `CHIME_MAX_MS` cap).
- [x] The fail chime is a **descending sequence** (`chimePlan({kind:"fail"})`
  → two notes, the second lower and scheduled after the first, one envelope per
  note) with `gainScale` equal to pass — never quieter than the "correcto"
  cue — no audio assets and no new dependencies. Total length stays within the
  300 ms budget of spec 110; the pass cue keeps its original 250 ms chord.
- [x] Tests: `tests/karaoke.test.ts` asserts the fail line is exactly the focus
  hint (no `percent` / `Almost there` / `try that again`) plus the empty-line
  case; `tests/chime.test.ts` asserts the view wiring (2 pass + 2 fail call
  sites, chime before the guarded `speak`, no opener left in the view);
  `tests/refinement.test.ts` asserts the guarded speak in both loops.
- [x] `npm run check` and `npm test` green.
- [ ] Manual: fail a fragment → hear the descending "incorrecto" chime right after
  your own replay, then the focus hint (or silence when there is nothing to
  focus on), then the same fragment re-read.
- [ ] Manual: fail the full answer → same treatment; pass still plays the pass
  chime with no congratulation line.

## Out of scope

- Changing the pass chime or the pass branch of `buildFeedbackText`.
- Different chimes per score band or per error type (still open from 110).
- The chip visual (`renderFeedback`), the word coloring and the PTT mechanics.
- `buildNoSpeechText` (the no-speech retry keeps its spoken line).
- The score shown in the chip and in the persisted attempt.
