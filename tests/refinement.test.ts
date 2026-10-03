// ---------------------------------------------------------------------------
// Feature 116 — background LLM refinement of a fast attempt.
//
// Unit-level (no HTTP, no network): the merge/coach-line/forced-amber pass of
// `refineAttempt`, the TTL+cap registry behind `POST /api/attempt`, and the
// long-poll contract of `GET /api/attempt/:id/feedback`
// (`refined: true | false`, 404 for unknown ids, server-side timeout).
// A few source-level assertions pin the wiring in server.ts / practice-view.js.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderError } from "../src/lib/providers/index.ts";
import type { Candidate, Evaluation } from "../src/lib/practice.ts";
import { tokenize } from "../src/lib/practice.ts";
import type { WhisperWord } from "../src/lib/whisper.ts";
import {
  awaitRefinement,
  createRefinementRegistry,
  handleAttemptFeedbackRequest,
  refineAttempt,
  REFINEMENT_MAX_ENTRIES,
  REFINEMENT_TTL_MS,
  DEFAULT_REFINE_TIMEOUT_MS,
  type AttemptRefinement,
  type RefineAttemptParams,
} from "../src/lib/refinement.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TARGET = "Once in this company I had a difficult situation.";

/** LLM reply: pronunciation issue quoting "difficult", one tip, naturalness 60. */
const FAKE_REFINE = `{"issues":[{"category":"pronunciation","message":"Watch \\"difficult\\"","fix":"Say \\"difficult\\" clearly"}],"tips":["Slow down"],"naturalness":60}`;

function fake(id: string, reply: string): Candidate {
  return {
    id: id as never,
    async available() {
      return true;
    },
    async complete() {
      return reply;
    },
  };
}

function failing(id: string): Candidate {
  return {
    id: id as never,
    async available() {
      return true;
    },
    async complete() {
      throw new ProviderError("boom", true, id as never);
    },
  };
}

/** Word-timestamped copy of `text` (100 ms per word), like whisper emits. */
function spokenFrom(text: string): WhisperWord[] {
  return tokenize(text).map((word, i) => ({ word, startMs: i * 100, endMs: i * 100 + 90 }));
}

/** Base params of a perfect repetition of TARGET (lexical score 100). */
function perfectParams(overrides?: Partial<RefineAttemptParams>): RefineAttemptParams {
  const base: RefineAttemptParams = {
    target: TARGET,
    userText: TARGET,
    question: "Tell me about a difficult situation.",
    level: "B2",
    spokenWords: spokenFrom(TARGET),
    passed: true,
  };
  return { ...base, ...overrides };
}

/** Registry stub promise: an `AttemptRefinement` nobody reads in TTL/cap tests. */
function stubRefinement(): Promise<AttemptRefinement> {
  return Promise.resolve({} as AttemptRefinement);
}

// ---------------------------------------------------------------------------
// refineAttempt — the LLM pass itself
// ---------------------------------------------------------------------------

test("refineAttempt: combined score, real tips and forced-amber re-alignment", async () => {
  const hooked: Evaluation[] = [];
  const refinement = await refineAttempt([fake("amber", FAKE_REFINE)], perfectParams({
    onRefined: (merged) => {
      hooked.push(merged);
    },
  }));

  assert.equal(refinement.provider, "amber");
  // 0.75·lexical(100) + 0.25·naturalness(60) — the pre-116 score formula.
  assert.equal(refinement.score, 90);
  assert.equal(refinement.verdict, "great");
  assert.equal(refinement.next, true);
  assert.deepEqual(refinement.tips, ["Slow down"]);

  // The hook receives the merged evaluation (the review-panel patch).
  assert.equal(hooked.length, 1);
  assert.equal(hooked[0].score, 90);

  // Forced amber: the word the LLM quoted is downgraded green → amber, while
  // the rest of the line stays green and the alignment data is untouched.
  assert.equal(refinement.words.find((w) => w.word === "difficult")?.status, "amber");
  assert.equal(refinement.words.find((w) => w.word === "company")?.status, "green");
  assert.equal(refinement.words.length, tokenize(TARGET).length);

  // Coach line built with the REAL tips (pass branch of buildFeedbackText);
  // its percentage is the ALIGN score, exactly as the fast response reports it.
  assert.match(refinement.coachLine, /^Great job! That was 100 percent accurate\./);
  assert.ok(refinement.coachLine.includes("Slow down"));
});

test("refineAttempt: a throwing onRefined hook never breaks the refinement", async () => {
  const refinement = await refineAttempt([fake("amber", FAKE_REFINE)], perfectParams({
    onRefined: () => {
      throw new Error("disk full");
    },
  }));
  assert.equal(refinement.score, 90);
  assert.ok(refinement.coachLine.length > 0);
});

test("refineAttempt: text-mode attempts (no timestamps) still refine without amber", async () => {
  const refinement = await refineAttempt([fake("amber", FAKE_REFINE)], perfectParams({
    spokenWords: [],
  }));
  assert.equal(refinement.score, 90);
  // alignTextWords knows only green/red: no word timestamps → no forced amber.
  assert.ok(refinement.words.every((w) => w.status === "green"));
});

test("refineAttempt: rejects when every provider is down (the long-poll's refined:false)", async () => {
  await assert.rejects(
    () => refineAttempt([failing("amber"), failing("gemini")], perfectParams()),
    /All LLM providers failed/,
  );
});

// ---------------------------------------------------------------------------
// Registry — TTL purge on access + entry cap
// ---------------------------------------------------------------------------

test("refinement registry: entries expire after the TTL on the next access", async () => {
  let now = 0;
  const registry = createRefinementRegistry({ ttlMs: 60_000, maxEntries: 10, now: () => now });
  registry.set("a", stubRefinement());
  assert.ok(registry.get("a"), "live entry is served");
  now = 60_000;
  assert.equal(registry.get("a"), undefined, "expired exactly at the TTL boundary");
});

test("refinement registry: new entries purge expired ones on set", async () => {
  let now = 0;
  const registry = createRefinementRegistry({ ttlMs: 1_000, maxEntries: 10, now: () => now });
  registry.set("old", stubRefinement());
  now = 2_000;
  registry.set("fresh", stubRefinement());
  assert.equal(registry.get("old"), undefined);
  assert.ok(registry.get("fresh"));
});

test("refinement registry: the cap drops the oldest entry, never the newest", async () => {
  const registry = createRefinementRegistry({ ttlMs: REFINEMENT_TTL_MS, maxEntries: 2, now: () => 0 });
  registry.set("first", stubRefinement());
  registry.set("second", stubRefinement());
  registry.set("third", stubRefinement());
  assert.equal(registry.get("first"), undefined, "oldest evicted at the cap");
  assert.ok(registry.get("second"));
  assert.ok(registry.get("third"));
});

test("refinement registry: shipped constants match the spec 116 budget", () => {
  assert.equal(REFINEMENT_TTL_MS, 60_000);
  assert.equal(DEFAULT_REFINE_TIMEOUT_MS, 20_000);
  assert.equal(REFINEMENT_MAX_ENTRIES, 100);
});

// ---------------------------------------------------------------------------
// Long-poll — resolve / reject / timeout / unknown id
// ---------------------------------------------------------------------------

test("awaitRefinement: a fulfilled refinement reports refined", async () => {
  const entry = { promise: stubRefinement(), expiresAt: Number.MAX_SAFE_INTEGER };
  assert.equal((await awaitRefinement(entry, 100)).status, "refined");
});

test("awaitRefinement: a rejected refinement reports failed (never throws)", async () => {
  const entry = { promise: Promise.reject(new Error("llm down")), expiresAt: Number.MAX_SAFE_INTEGER };
  assert.equal((await awaitRefinement(entry, 100)).status, "failed");
});

test("awaitRefinement: a stalled refinement reports timeout after the cap", async () => {
  const entry = { promise: new Promise<AttemptRefinement>(() => {}), expiresAt: Number.MAX_SAFE_INTEGER };
  const started = Date.now();
  assert.equal((await awaitRefinement(entry, 30)).status, "timeout");
  assert.ok(Date.now() - started >= 25, "waited for the cap before giving up");
});

test("attempt feedback: unknown id → 404 { error }", async () => {
  const registry = createRefinementRegistry();
  const res = await handleAttemptFeedbackRequest(registry, "nope", 50);
  assert.equal(res.status, 404);
  assert.match(String(res.json.error), /attempt/i);
});

test("attempt feedback: resolved refinement → 200 { refined: true, ... }", async () => {
  const registry = createRefinementRegistry();
  registry.set("id-1", Promise.resolve({
    issues: [],
    tips: ["Slow down"],
    verdict: "great",
    score: 90,
    next: true,
    coachLine: "Great job!",
    words: [],
    provider: "amber",
  }));
  const res = await handleAttemptFeedbackRequest(registry, "id-1", 100);
  assert.equal(res.status, 200);
  assert.equal(res.json.refined, true);
  assert.equal(res.json.provider, "amber");
  assert.equal(res.json.score, 90);
  assert.deepEqual(res.json.tips, ["Slow down"]);
});

test("attempt feedback: LLM outage → 200 { refined: false } (deterministic state kept)", async () => {
  const registry = createRefinementRegistry();
  registry.set("id-2", Promise.reject(new Error("all providers down")));
  const res = await handleAttemptFeedbackRequest(registry, "id-2", 100);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { refined: false });
});

test("attempt feedback: server timeout → 200 { refined: false }", async () => {
  const registry = createRefinementRegistry();
  registry.set("id-3", new Promise<AttemptRefinement>(() => {}));
  const res = await handleAttemptFeedbackRequest(registry, "id-3", 30);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { refined: false });
});

// ---------------------------------------------------------------------------
// Wiring — server.ts and practice-view.js honour the contract
// ---------------------------------------------------------------------------

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const serverSrc = readFileSync(join(repoRoot, "src", "server.ts"), "utf8");
const viewSrc = readFileSync(join(repoRoot, "public", "ui", "practice-view.js"), "utf8");

test("wiring: server registers the refinement before answering and exposes the long-poll", () => {
  assert.match(serverSrc, /app\.get\("\/api\/attempt\/:id\/feedback"/);
  // Scope everything to the POST /api/attempt handler (the file also holds
  // /api/evaluate, which keeps the synchronous composed evaluation).
  const start = serverSrc.indexOf('app.post("/api/attempt"');
  const end = serverSrc.indexOf('app.get("/api/attempt/:id/feedback"');
  assert.ok(start > -1 && end > start);
  const handlerSrc = serverSrc.slice(start, end);
  assert.match(handlerSrc, /refinements\.set\(attemptId, pendingRefinement\)/);
  assert.match(handlerSrc, /attemptId = randomUUID\(\)/);
  // Persisted (durable, deterministic) BEFORE the response goes out.
  const persistAt = handlerSrc.indexOf("persistAttempt({");
  const respondAt = handlerSrc.indexOf("attemptId,");
  assert.ok(persistAt > -1 && respondAt > -1 && persistAt < respondAt);
  // The blank transcript answers exactly as before: no attemptId at all.
  const blankAt = handlerSrc.indexOf("coachLine: buildNoSpeechText()");
  assert.ok(blankAt > -1 && blankAt < persistAt);
  assert.ok(!handlerSrc.slice(blankAt, handlerSrc.indexOf("return;", blankAt)).includes("attemptId"));
});

test("wiring: the view launches the refinement without await and gates it by attemptId", () => {
  assert.doesNotMatch(viewSrc, /await startRefinement/);
  assert.match(viewSrc, /const refinement = startRefinement\(outcome, fi, token\)/);
  assert.match(viewSrc, /const refinement = startRefinement\(fullOutcome, -1, token\)/);
  // Fail path waits (capped) right before speaking; PASS never waits.
  assert.equal(viewSrc.match(/await refinement/g)?.length, 2);
  assert.match(viewSrc, /await speak\(refined\?\.coachLine \|\| outcome\.coachLine, token\)/);
  assert.match(viewSrc, /attemptId !== lastAttemptId/);
  assert.match(viewSrc, /outcome\.attemptId \?\? null/);
});
