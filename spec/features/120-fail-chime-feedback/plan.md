# 120 · Fail chime instead of the spoken retry line — Plan

## Approach

Reuse the chime module that 110 already ships, and give it the cue the fail
path actually needs. `public/speech/chime.js` already had two plans (`pass` and
`fail`) but 110 only ever played `pass`; the dormant `fail` shape was the pass
chime made quieter and lower — on review it read as "correcto" and was lost
under the user's own replay. This feature switches the fail path from "read a
sentence" to "play the fail chime", redesigns that cue as a descending
sequence, and trims the spoken feedback down to the part that is genuinely
spoken value: the focus hint.

The decision (which line is spoken, which sound plays) stays in the **view**,
exactly like 110 did, so no endpoint shape changes.

## Implementation

1. `src/lib/practice/karaoke-lines.ts` — `buildFeedbackText` fail branch drops
   `Almost there. That was N percent. Let's try that again.` and returns only
   the focus hint (`Focus on: …` / `Drop the extra words: …`) or `""` when
   there is nothing to point at. Pass branch untouched. JSDoc documents the new
   contract (empty = silence).
2. `public/speech/chime.js` — `KINDS` becomes a note schedule
   (`{ frequency, atMs }[]` + `noteMs` + `gainScale`): `pass` keeps its
   simultaneous 250 ms chord, `fail` plays 523 → 349 Hz sequentially at pass
   loudness. `chimePlan()` exposes `notes[]` (keeping `frequencies`,
   `attack`, `decay`, `gain` for the existing tests); `playChime()` builds one
   gain node per note and drops/recreates a `closed` AudioContext.
3. `public/ui/practice-view.js`:
   - `playSuccessChime()` → `playAttemptChime(kind)` (same `CHIME_MAX_MS` race,
     same volume clamp, same "silence on cap" behaviour).
   - Fragment loop fail path: replay → `await playAttemptChime("fail")` →
     `await refinement` → speak only if the line is non-empty.
   - Full-answer fail path: identical treatment.
   - Both pass call sites → `playAttemptChime("pass")`.
4. Tests:
   - `tests/karaoke.test.ts` — fail line is exactly the focus hint; new case
     for the empty line.
   - `tests/chime.test.ts` — fail descends and is at least as loud as pass,
     pass keeps its 250 ms chord, plus the source wiring of the view (2 pass /
     2 fail call sites, chime before the guarded `speak`, no opener left
     behind).
   - `tests/refinement.test.ts` — the guarded `if (refinedLine) await speak(…)`
     in both loops.
5. Docs: this folder, roadmap entry, and the stale "fallo intacto" statements
   in `../110-success-chime/spec.md`, `../105-karaoke-practice-cu2/spec.md` and
   `../../use-cases/CU2.md`.

## Decisions

- **Chime before the refinement wait** — the chime is the immediate verdict
  (it follows the user's own replay, ≤ 500 ms); the focus hint still waits for
  the LLM refinement as before. Playing it after the capped wait would delay
  the "incorrecto" signal by up to 10 s.
- **Chime after the replay, not before** — the replay is the user's own audio;
  a chime over it would fight it, and 110's invariant is chime/TTS never
  overlap.
- **Empty line = silence, not a fallback sentence** — `buildFeedbackText`
  returns `""`, the view guards `speak()`. Alternative discarded: keep the
  opener only when there is no focus hint (a silent failure with no
  explanation is the clearer signal when there is nothing to explain).
- **`refined?.coachLine || outcome.coachLine` kept** — empty string is falsy,
  so the deterministic line still wins when the refinement comes back empty;
  the no-speech path (`buildNoSpeechText`) keeps speaking.
- **Redesigned the `fail` tone instead of reusing the old one** — the pre-120
  `fail` plan was the pass chord at 60% volume and a lower fifth: on review it
  "sounded like the repetition was correct" and it was quiet enough to be lost
  right after the user's own replay. The new shape is a descending sequence
  (523 → 349 Hz, own envelope per note) at pass loudness. The plan grew a
  `notes[]` schedule (`{ frequency, startMs, gain }`) while keeping
  `frequencies`/`attack`/`decay`/`gain`, so the existing plan tests and the
  pass cue stay valid.
- **Recreated a closed AudioContext** — a context evicted by the per-page
  AudioContext limit is `closed`; `audioCtx ??=` would keep handing out a dead
  handle and `createGain()` would throw into the catch → silence for every
  later chime. `playChime` now drops a closed handle, and warns
  `[chime] could not play:` when scheduling fails, so a silent cue is
  observable instead of invisible.

## Risks

- **Silent turn when there is no focus hint** — accepted: the chip still shows
  `Foco en … · N%` and the fragment is re-read immediately.
- **A fail now plays two audio events (replay + chime)** — both are short and
  strictly sequential; the `CHIME_MAX_MS` cap keeps the chime from ever running
  under the next read.
- **Historical sessions** may hold persisted attempts built before this change;
  they are never spoken on resume (a resumed session re-reads the fragment and
  re-evaluates on the next attempt), so no stale opener can come back that way.
