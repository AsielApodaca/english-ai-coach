import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildLookupPrompt,
  createDictionaryLookup,
  createLlmLookup,
  createLookupCache,
  createTranslationLookup,
  countLookupTokens,
  isSameOriginLookupRequest,
  LOOKUP_DEADLINE_MS,
  LOOKUP_MAX_CHARS,
  LOOKUP_UNAVAILABLE,
  lookupKind,
  normalizeLookupText,
  parseDictionaryEntry,
  parseLookupLlmReply,
  resolveLookup,
  validateLookupText,
  type FetchLike,
  type LlmCandidate,
  type LookupResult,
  type LookupSuccess,
} from "../src/lib/lookup/lookup.ts";
import { ProviderError } from "../src/lib/providers/index.ts";
import {
  isCompleteEntry,
  normalizeLookupText as normalizeClientText,
  phraseFromRange,
} from "../public/ui/lookup-popover.js";

// ---------------------------------------------------------------------------
// Helpers & fixtures
// ---------------------------------------------------------------------------

/** Assert a result is successful and return it narrowed (test readability). */
function asOk(result: LookupResult): LookupSuccess {
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  return result as LookupSuccess;
}

/** Fake provider returning a fixed reply (registry chain in tests). */
function fakeCandidate(reply: string): LlmCandidate {
  return {
    id: "mock",
    async available() {
      return true;
    },
    async complete() {
      return reply;
    },
  };
}

/** Fake provider that always fails (LLM outage). */
function failingCandidate(): LlmCandidate {
  return {
    id: "mock",
    async available() {
      return true;
    },
    async complete() {
      throw new ProviderError("boom", true, "mock");
    },
  };
}

/** Injectable fetch fake: records URLs, answers with `handler`, may throw. */
function fakeFetch(handler: (url: string) => { status: number; body: unknown }) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const { status, body } = handler(url);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchImpl, calls };
}

/** Real-shaped dictionaryapi.dev payload for "hello". */
const DICT_HELLO = [
  {
    word: "hello",
    phonetics: [
      { text: "/həˈləʊ/", audio: "https://api.dictionaryapi.dev/media/pronunciations/en/hello/us.mp3" },
      { text: "/həˈloʊ/", audio: "" },
    ],
    meanings: [
      {
        partOfSpeech: "exclamation",
        definitions: [
          {
            definition: "used as a greeting or to begin a telephone conversation.",
            example: "Hello there, Kate!",
            synonyms: ["hi"],
            antonyms: [],
          },
        ],
        synonyms: ["hi"],
        antonyms: [],
      },
      {
        partOfSpeech: "noun",
        definitions: [
          {
            definition: "an utterance of “hello”; a greeting.",
            example: "she was getting polite nods and hellos from people",
            synonyms: [],
            antonyms: [],
          },
        ],
        synonyms: [],
        antonyms: [],
      },
    ],
    sourceUrls: ["https://en.wiktionary.org/wiki/hello"],
  },
];

// ---------------------------------------------------------------------------
// dictionaryapi.dev parser (real-shaped fixture)
// ---------------------------------------------------------------------------

test("parser: real dictionaryapi.dev fixture → gloss + example", () => {
  const hit = parseDictionaryEntry(DICT_HELLO);
  assert.ok(hit);
  assert.equal(hit.gloss, "used as a greeting or to begin a telephone conversation.");
  assert.equal(hit.example, "Hello there, Kate!");
});

test("parser: gloss comes from the FIRST definition, example is best effort", () => {
  const hit = parseDictionaryEntry([
    {
      word: "run",
      meanings: [
        {
          partOfSpeech: "verb",
          definitions: [
            { definition: "move at a speed faster than a walk." },
            { definition: "operate or function.", example: "The engine is running." },
          ],
        },
      ],
    },
  ]);
  assert.ok(hit);
  assert.equal(hit.gloss, "move at a speed faster than a walk.");
  assert.equal(hit.example, "The engine is running.");
});

test("parser: long definitions are cut to ~140 chars at a word boundary", () => {
  const long = `${"word ".repeat(60)}end`;
  const hit = parseDictionaryEntry([{ meanings: [{ definitions: [{ definition: long }] }] }]);
  assert.ok(hit);
  assert.ok(hit.gloss.length <= 141, `gloss too long: ${hit.gloss.length}`);
  assert.ok(hit.gloss.endsWith("…"));
});

test("parser: 404 body / non-array payloads → null (routes to the LLM)", () => {
  assert.equal(parseDictionaryEntry({ title: "No Definitions Found", resolution: "..." }), null);
  assert.equal(parseDictionaryEntry("not json"), null);
  assert.equal(parseDictionaryEntry(null), null);
  assert.equal(parseDictionaryEntry([{ meanings: [] }]), null);
  assert.equal(parseDictionaryEntry([{}]), null);
});

// ---------------------------------------------------------------------------
// Normalization of the selected phrase (spaces, punctuation, multi-line)
// ---------------------------------------------------------------------------

test("normalize: collapses spaces, strips edge punctuation, lowercases", () => {
  assert.equal(normalizeLookupText("  SHUT   up!  "), "shut up");
  assert.equal(normalizeLookupText("«handled\tit…»"), "handled it");
  assert.equal(normalizeLookupText("'Quoted'."), "quoted");
  assert.equal(normalizeLookupText("don't"), "don't");
  assert.equal(normalizeLookupText("end-to-end"), "end-to-end");
});

test("normalize: multi-line selections join into one phrase", () => {
  assert.equal(normalizeLookupText("first line\nsecond  line"), "first line second line");
  assert.equal(normalizeLookupText("shut\r\n up"), "shut up");
});

test("normalize: non-strings / punctuation-only → empty", () => {
  assert.equal(normalizeLookupText("..."), "");
  assert.equal(normalizeLookupText("   "), "");
  assert.equal(normalizeLookupText(null), "");
  assert.equal(normalizeLookupText(42), "");
});

test("validate: valid text normalizes; limits and arbitrary text rejected", () => {
  assert.deepEqual(validateLookupText("Shut  up!"), { ok: true, text: "shut up" });
  assert.deepEqual(validateLookupText("line one\nline two"), { ok: true, text: "line one line two" });
  assert.equal(validateLookupText("").ok, false);
  assert.equal(validateLookupText("   ").ok, false);
  assert.equal(validateLookupText(`x${"y".repeat(LOOKUP_MAX_CHARS)}`).ok, false);
  assert.equal(validateLookupText("https://example.com/path").ok, false);
  assert.equal(validateLookupText("hello @ world").ok, false); // internal symbol
  assert.match((validateLookupText("x".repeat(LOOKUP_MAX_CHARS + 1)) as { error: string }).error, /60/);
});

test("client and server normalization agree (shared cache keys)", () => {
  const samples = ["  SHUT   up!  ", "«Handled\tit…»", "first\nsecond", "don't", "...", "", "Shut UP!"];
  for (const sample of samples) {
    assert.equal(normalizeClientText(sample), normalizeLookupText(sample), `mismatch for ${JSON.stringify(sample)}`);
  }
});

test("token count drives the kind (word vs phrase)", () => {
  assert.equal(countLookupTokens("shut up"), 2);
  assert.equal(lookupKind("shut"), "word");
  assert.equal(lookupKind("shut up"), "phrase");
  assert.equal(lookupKind("end-to-end"), "word");
});

// ---------------------------------------------------------------------------
// Pipeline selection: word → dict, phrase → LLM, dict-404 → LLM,
// MyMemory-fail → LLM
// ---------------------------------------------------------------------------

test("pipeline: single word → dictionary + MyMemory, LLM untouched", async () => {
  const calls: string[] = [];
  const result = await resolveLookup("Hello!", {
    dictionary: async (word) => {
      calls.push(`dict:${word}`);
      return { gloss: "a greeting", example: "Hello there!" };
    },
    translate: async (text) => {
      calls.push(`tr:${text}`);
      return "hola";
    },
    llm: async () => {
      calls.push("llm");
      return null;
    },
    retryDelayMs: 0,
  });
  const ok = asOk(result);
  assert.equal(ok.kind, "word");
  assert.equal(ok.source, "dictionary");
  assert.deepEqual(ok.entry, { gloss: "a greeting", example: "Hello there!", translationEs: "hola" });
  assert.deepEqual(calls, ["dict:hello", "tr:hello"]);
});

test("pipeline: phrase (≥ 2 tokens) → LLM, dictionary never consulted", async () => {
  const calls: string[] = [];
  const result = await resolveLookup("take it easy", {
    dictionary: async () => {
      calls.push("dict");
      return { gloss: "unused", example: "" };
    },
    translate: async () => {
      calls.push("tr");
      return "literal";
    },
    llm: async (text, kind) => {
      calls.push(`llm:${kind}`);
      return { gloss: "relax", example: "Take it easy.", translationEs: "relájate" };
    },
    retryDelayMs: 0,
  });
  const ok = asOk(result);
  assert.equal(ok.kind, "phrase");
  assert.equal(ok.source, "llm");
  assert.deepEqual(calls, ["llm:phrase"]);
});

test("pipeline: dictionary 404 → LLM fallback", async () => {
  const calls: string[] = [];
  const result = await resolveLookup("zzzzq", {
    dictionary: async () => {
      calls.push("dict");
      return null;
    },
    translate: async () => {
      calls.push("tr");
      return null;
    },
    llm: async () => {
      calls.push("llm");
      return { gloss: "an invented word", example: "Zzzzq!", translationEs: "palabra inventada" };
    },
    retryDelayMs: 0,
  });
  const ok = asOk(result);
  assert.equal(ok.source, "llm");
  assert.equal(ok.kind, "word");
  assert.deepEqual(calls, ["dict", "llm"]);
});

test("pipeline: MyMemory failure → LLM fallback keeps the lookup alive", async () => {
  const calls: string[] = [];
  const result = await resolveLookup("hello", {
    dictionary: async () => {
      calls.push("dict");
      return { gloss: "a greeting", example: "Hello!" };
    },
    translate: async () => {
      calls.push("tr");
      return null; // MyMemory quota / outage
    },
    llm: async () => {
      calls.push("llm");
      return { gloss: "a greeting", example: "Hello!", translationEs: "hola" };
    },
    retryDelayMs: 0,
  });
  const ok = asOk(result);
  assert.equal(ok.source, "llm");
  assert.equal(ok.entry.translationEs, "hola");
  assert.deepEqual(calls, ["dict", "tr", "llm"]);
});

test("pipeline: MyMemory-only degrade is ok but NOT cached (no gloss)", async () => {
  const cache = createLookupCache();
  const result = await resolveLookup("shut up", {
    dictionary: async () => null,
    translate: async () => "cállate",
    llm: async () => null, // LLM down
    cache,
    retryDelayMs: 0,
  });
  const ok = asOk(result);
  assert.equal(ok.source, "mymemory");
  assert.equal(ok.entry.gloss, "");
  assert.equal(cache.size, 0, "partial entries must not be cached as success");
});

// ---------------------------------------------------------------------------
// LLM prompt + tolerant JSON extraction (code fences)
// ---------------------------------------------------------------------------

test("LLM prompt: strict schema, anti-literal rule, LEARNER MEMORY block", () => {
  const { system, user } = buildLookupPrompt("shut up", "phrase", "Estimated level: B2.");
  assert.match(system, /"gloss"/);
  assert.match(system, /"example"/);
  assert.match(system, /"translationEs"/);
  assert.match(system, /NEVER a literal/i);
  assert.match(user, /LEARNER MEMORY:/);
  assert.match(user, /Estimated level: B2\./);
  assert.match(user, /"shut up"/);
  assert.match(user, /Kind: phrase/);
});

test("LLM extraction: code fences and surrounding prose are tolerated", () => {
  const fenced =
    'Claro, aquí va:\n```json\n{"gloss":"tell someone to stop talking","example":"Please shut up.","translationEs":"Cállate"}\n```\n¡Espero que sirva!';
  const entry = parseLookupLlmReply(fenced);
  assert.ok(entry);
  assert.equal(entry.gloss, "tell someone to stop talking");
  assert.equal(entry.example, "Please shut up.");
  assert.equal(entry.translationEs, "Cállate");
});

test("LLM extraction: unusable replies → null (no throw)", () => {
  assert.equal(parseLookupLlmReply("no json at all"), null);
  assert.equal(parseLookupLlmReply(""), null);
  assert.equal(parseLookupLlmReply(null), null);
  assert.equal(parseLookupLlmReply('{"gloss":"","translationEs":""}'), null);
});

test("createLlmLookup: fenced reply parsed through the provider chain", async () => {
  const llm = createLlmLookup([
    fakeCandidate('```json\n{"gloss":"a greeting","example":"Hello!","translationEs":"hola"}\n```'),
  ]);
  const entry = await llm("hello", "word", "memory");
  assert.ok(entry);
  assert.equal(entry.gloss, "a greeting");
  assert.equal(entry.translationEs, "hola");
});

// ---------------------------------------------------------------------------
// Cache: hit skips providers, errors never cached as success
// ---------------------------------------------------------------------------

test("cache: a hit serves instantly and never calls a provider again", async () => {
  const cache = createLookupCache();
  let dictCalls = 0;
  const deps = {
    dictionary: async () => {
      dictCalls++;
      return { gloss: "a greeting", example: "Hello!" };
    },
    translate: async () => "hola",
    llm: async () => {
      throw new Error("LLM must not be called");
    },
    cache,
    retryDelayMs: 0,
  };
  const first = asOk(await resolveLookup("Hello", deps));
  assert.equal(first.source, "dictionary");

  // Same text, different casing/punctuation → same normalized cache key.
  const second = asOk(await resolveLookup("  hello!  ", deps));
  assert.equal(second.source, "cache");
  assert.equal(second.kind, "word");
  assert.equal(second.entry.gloss, "a greeting");
  assert.equal(dictCalls, 1, "provider must be hit exactly once");
  assert.equal(cache.size, 1);
});

test("cache: failures are never stored — the next attempt hits providers", async () => {
  const cache = createLookupCache();
  const failed = await resolveLookup("quixotic", {
    dictionary: async () => null,
    translate: async () => null,
    llm: async () => null,
    cache,
    retryDelayMs: 0,
  });
  assert.equal(failed.ok, false);
  assert.equal(cache.size, 0);

  const recovered = asOk(
    await resolveLookup("quixotic", {
      dictionary: async () => ({ gloss: "exceedingly unusual", example: "A quixotic quest." }),
      translate: async () => "quijotesco",
      llm: async () => null,
      cache,
      retryDelayMs: 0,
    }),
  );
  assert.equal(recovered.source, "dictionary", "the failure must not poison the cache");
});

test("cache: LRU evicts the oldest entry beyond capacity", () => {
  const cache = createLookupCache(2);
  const entry = { gloss: "g", example: "e", translationEs: "t" };
  cache.set("a", { kind: "word", source: "llm", entry });
  cache.set("b", { kind: "word", source: "llm", entry });
  assert.ok(cache.get("a")); // refresh "a": now "b" is the oldest
  cache.set("c", { kind: "word", source: "llm", entry });
  assert.equal(cache.get("b"), undefined);
  assert.ok(cache.get("a"));
  assert.ok(cache.get("c"));
  assert.equal(cache.size, 2);
});

// ---------------------------------------------------------------------------
// Degraded mode: LLM (and everything) down → { ok: false }, no exception
// ---------------------------------------------------------------------------

test("total failure → { ok: false } without throwing (single attempt, no loop)", async () => {
  let llmCalls = 0;
  const result = await resolveLookup("anything", {
    dictionary: async () => null,
    translate: async () => null,
    llm: async () => {
      llmCalls++;
      return null;
    },
    retryDelayMs: 0,
  });
  assert.deepEqual(result, { ok: false, error: LOOKUP_UNAVAILABLE });
  // max 1 retry (spec 112): exactly two attempts, never a retry loop.
  assert.equal(llmCalls, 2);
});

test("createLlmLookup: provider outage → null, no exception escapes", async () => {
  const llm = createLlmLookup([failingCandidate()]);
  const entry = await llm("hello", "word", "memory");
  assert.equal(entry, null);
});

test("invalid input → { ok: false } with NO external call at all", async () => {
  let externalCalls = 0;
  const bump = async () => {
    externalCalls++;
    return null;
  };
  const tooLong = await resolveLookup("x".repeat(LOOKUP_MAX_CHARS + 1), {
    dictionary: bump,
    translate: bump,
    llm: bump,
    retryDelayMs: 0,
  });
  assert.equal(tooLong.ok, false);

  const arbitrary = await resolveLookup("https://example.com/very/long/path", {
    dictionary: bump,
    translate: bump,
    llm: bump,
    retryDelayMs: 0,
  });
  assert.equal(arbitrary.ok, false);
  assert.equal(externalCalls, 0, "rejected input must not trigger a single external request");
});

// ---------------------------------------------------------------------------
// Mandatory case: `shut up` → LLM with a NON-literal translationEs
// ---------------------------------------------------------------------------

test("mandatory: 'shut up' resolves via LLM, never literally", async () => {
  const calls: string[] = [];
  const result = await resolveLookup("shut  UP!", {
    dictionary: async () => {
      calls.push("dict");
      return { gloss: "to close something", example: "shut the door" };
    },
    translate: async () => {
      calls.push("tr");
      return "cerrar arriba"; // literal word-by-word garbage — must never win
    },
    llm: async (text, kind) => {
      calls.push(`llm:${kind}`);
      return {
        gloss: "tell someone to stop talking",
        example: "Just shut up already.",
        translationEs: "Cállate la boca",
      };
    },
    retryDelayMs: 0,
  });
  const ok = asOk(result);
  assert.equal(ok.kind, "phrase");
  assert.equal(ok.source, "llm");
  assert.equal(ok.entry.translationEs, "Cállate la boca");
  assert.ok(!/cerrar/i.test(ok.entry.translationEs), "literal translation leaked");
  assert.ok(!/arriba/i.test(ok.entry.translationEs), "literal translation leaked");
  assert.deepEqual(calls, ["llm:phrase"], "phrases go straight to the LLM");
});

// ---------------------------------------------------------------------------
// HTTP wrappers with fake fetch (zero real network)
// ---------------------------------------------------------------------------

test("dictionary wrapper: 200 fixture → hit, URL encoded, 404 → null", async () => {
  const ok = fakeFetch(() => ({ status: 200, body: DICT_HELLO }));
  const hit = await createDictionaryLookup(ok.fetchImpl)("hello");
  assert.ok(hit);
  assert.equal(hit.gloss, "used as a greeting or to begin a telephone conversation.");
  assert.match(ok.calls[0]!, /^https:\/\/api\.dictionaryapi\.dev\/api\/v2\/entries\/en\/hello$/);

  const notFound = fakeFetch(() => ({ status: 404, body: { title: "No Definitions Found" } }));
  assert.equal(await createDictionaryLookup(notFound.fetchImpl)("hello"), null);

  const networkDown = fakeFetch(() => {
    throw new Error("ECONNRESET");
  });
  assert.equal(await createDictionaryLookup(networkDown.fetchImpl)("hello"), null);
});

test("MyMemory wrapper: translation parsed; quota prose and errors → null", async () => {
  const ok = fakeFetch(() => ({
    status: 200,
    body: { responseStatus: 200, responseData: { translatedText: " hola " } },
  }));
  assert.equal(await createTranslationLookup(ok.fetchImpl)("hello"), "hola");
  assert.match(ok.calls[0]!, /^https:\/\/api\.mymemory\.translated\.net\/get\?q=hello&langpair=en%7Ces$/);

  const quota = fakeFetch(() => ({
    status: 200,
    body: {
      responseStatus: 200,
      responseData: { translatedText: "MYMEMORY WARNING: YOU USED ALL FREE TRANSLATIONS FOR TODAY." },
    },
  }));
  assert.equal(await createTranslationLookup(quota.fetchImpl)("hello"), null);

  const serverError = fakeFetch(() => ({ status: 503, body: {} }));
  assert.equal(await createTranslationLookup(serverError.fetchImpl)("hello"), null);
});

// ---------------------------------------------------------------------------
// Dictionary circuit breaker (fast-lookup fix): an unreachable
// dictionaryapi.dev must cost ONE timeout, then be skipped until cooldown.
// ---------------------------------------------------------------------------

test("breaker: a timeout opens the circuit — the second call skips fetch", async () => {
  const timedOut = fakeFetch(() => {
    throw new DOMException("timed out", "TimeoutError");
  });
  const lookup = createDictionaryLookup(timedOut.fetchImpl, { cooldownMs: 60_000 });
  assert.equal(await lookup("hello"), null);
  assert.equal(await lookup("hello"), null);
  assert.equal(timedOut.calls.length, 1, "an open circuit must not reach the network");
});

test("breaker: non-OK answers (404) do NOT trip the circuit", async () => {
  const notFound = fakeFetch(() => ({ status: 404, body: { title: "No Definitions Found" } }));
  const lookup = createDictionaryLookup(notFound.fetchImpl);
  assert.equal(await lookup("hello"), null);
  assert.equal(await lookup("hello"), null);
  assert.equal(notFound.calls.length, 2, "a 404 is an answer, not an outage");
});

test("breaker: the circuit closes again once the cooldown elapses", async () => {
  let clock = 1_000;
  const timedOut = fakeFetch(() => {
    throw new DOMException("timed out", "TimeoutError");
  });
  const lookup = createDictionaryLookup(timedOut.fetchImpl, { cooldownMs: 60_000, now: () => clock });
  assert.equal(await lookup("hello"), null);
  clock += 59_999;
  assert.equal(await lookup("hello"), null);
  assert.equal(timedOut.calls.length, 1, "still inside the cooldown window");
  clock += 1;
  assert.equal(await lookup("hello"), null);
  assert.equal(timedOut.calls.length, 2, "after the cooldown the network is retried");
});

test('breaker: a network TypeError ("fetch failed") trips the circuit too', async () => {
  const networkDown = fakeFetch(() => {
    throw new TypeError("fetch failed");
  });
  const lookup = createDictionaryLookup(networkDown.fetchImpl);
  assert.equal(await lookup("hello"), null);
  assert.equal(await lookup("hello"), null);
  assert.equal(networkDown.calls.length, 1, "an open circuit must not reach the network");
});

// ---------------------------------------------------------------------------
// Selection reconstruction (review fixes #2, #7): rebuild the phrase from the
// `.kw` spans a Range intersects — `Range.toString()` is polluted by `.kw-ipa`
// annotations and missing whitespace (`Shut~shuhtupuhpand`, `easy.EE·zeePlease`).
// ---------------------------------------------------------------------------

/** Minimal fake `.kw` element (karaoke: has `data-word`; review: text only). */
function fakeWord(word: string, opts: { text?: string } = {}) {
  return { dataset: { word }, textContent: opts.text ?? word };
}

/** Fake Range: intersects only the elements passed as `covered`. */
function fakeRange(covered: object[]) {
  return { intersectsNode: (el: object) => covered.includes(el) };
}

test("reconstruction: joins intersecting .kw data-word values in document order", () => {
  const shut = fakeWord("Shut");
  const up = fakeWord("up");
  const and = fakeWord("and");
  const relax = fakeWord("relax");
  // The old bug: Range.toString() over [Shut, up, and] ≈ "Shut~shuhtupuhpand".
  const phrase = phraseFromRange(fakeRange([shut, up, and]), [shut, up, and, relax]);
  assert.equal(phrase, "shut up and");
});

test("reconstruction: spans without data-word (review mode) use textContent", () => {
  const great = { textContent: "Great" };
  const job = { textContent: "job!" };
  const phrase = phraseFromRange(fakeRange([great, job]), [great, job]);
  assert.equal(phrase, "great job");
});

test("reconstruction: no intersecting word span → empty (fallback signal)", () => {
  const a = fakeWord("hello");
  const b = fakeWord("world");
  assert.equal(phraseFromRange(fakeRange([]), [a, b]), "");
});

test("reconstruction: partial drag picks whole words, never fragments", () => {
  const please = fakeWord("Please");
  const shut = fakeWord("Shut", { text: "Shut~shuht" });
  const up = fakeWord("up", { text: "upuhp" });
  // Drag starting mid-'up' intersects only 'up' (its `.kw`, not the annotation).
  assert.equal(phraseFromRange(fakeRange([up]), [please, shut, up]), "up");
  assert.equal(phraseFromRange(fakeRange([shut, up]), [please, shut, up]), "shut up");
});

// ---------------------------------------------------------------------------
// Cross-origin gate (review fix #3): /api/lookup must not work as a free
// translation proxy for arbitrary web pages (GET = CORS simple request).
// ---------------------------------------------------------------------------

test("origin: header-less clients (curl/smoke) are allowed", () => {
  assert.equal(isSameOriginLookupRequest({}), true);
  assert.equal(isSameOriginLookupRequest({ host: "localhost:3000" }), true);
});

test("origin: same-origin browser requests are allowed", () => {
  assert.equal(
    isSameOriginLookupRequest({ secFetchSite: "same-origin", host: "localhost:3000" }),
    true,
  );
  // Browsers omit Origin on same-origin GETs; with it, hosts must match.
  assert.equal(
    isSameOriginLookupRequest({ origin: "http://localhost:3000", host: "localhost:3000" }),
    true,
  );
});

test("origin: cross-site requests are rejected (proxy abuse)", () => {
  // <img src="http://localhost:3000/api/lookup?text=..."> from another page.
  assert.equal(
    isSameOriginLookupRequest({ secFetchSite: "cross-site", host: "localhost:3000" }),
    false,
  );
  // CORS fetch carrying an Origin from another host.
  assert.equal(
    isSameOriginLookupRequest({ origin: "http://evil.example", host: "localhost:3000" }),
    false,
  );
  // Opaque origin ("null", e.g. sandboxed iframe / file://).
  assert.equal(isSameOriginLookupRequest({ origin: "null", host: "localhost:3000" }), false);
  // Origin present but no Host to compare against → deny.
  assert.equal(isSameOriginLookupRequest({ origin: "http://localhost:3000" }), false);
  // Sec-Fetch-Site values other than same-origin (same-site, none).
  assert.equal(isSameOriginLookupRequest({ secFetchSite: "same-site" }), false);
  assert.equal(isSameOriginLookupRequest({ secFetchSite: "none" }), false);
});

// ---------------------------------------------------------------------------
// Cache completeness (review fix #5): partials (missing gloss OR translation)
// are never cached server-side or client-side, so the next attempt can heal.
// ---------------------------------------------------------------------------

test("cache: dictionary hit without translation is NOT cached", async () => {
  const cache = createLookupCache();
  const result = await resolveLookup("hello", {
    dictionary: async () => ({ gloss: "a greeting", example: "Hello!" }),
    translate: async () => null, // MyMemory down
    llm: async () => null, // LLM down too
    cache,
    retryDelayMs: 0,
  });
  const ok = asOk(result);
  assert.equal(ok.source, "dictionary");
  assert.equal(ok.entry.gloss, "a greeting");
  assert.equal(ok.entry.translationEs, "");
  assert.equal(cache.size, 0, "translation-less partial must not be cached");
});

test("cache: a later complete answer heals and is then cached", async () => {
  const cache = createLookupCache();
  const deps = {
    dictionary: async () => ({ gloss: "a greeting", example: "Hello!" }),
    translate: async (): Promise<string | null> => null,
    llm: async (): Promise<null> => null,
    cache,
    retryDelayMs: 0,
  };
  await resolveLookup("hello", deps); // partial → not cached
  assert.equal(cache.size, 0);

  const healed = asOk(await resolveLookup("hello", { ...deps, translate: async () => "hola" }));
  assert.equal(healed.source, "dictionary");
  assert.equal(healed.entry.translationEs, "hola");
  assert.equal(cache.size, 1, "complete entry is cached");
  assert.equal(isCompleteEntry(healed.entry), true);
  assert.equal(isCompleteEntry({ gloss: "g", example: "", translationEs: "" }), false);
  assert.equal(isCompleteEntry({ gloss: "", example: "", translationEs: "hola" }), false);
});

// ---------------------------------------------------------------------------
// Total deadline (review fix #8): the worst case must not leave the card in
// "cargando…" for ~45 s.
// ---------------------------------------------------------------------------

test("deadline: a hung pipeline degrades within the budget, no exception", async () => {
  const started = Date.now();
  const result = await resolveLookup("stalled word", {
    dictionary: () => new Promise(() => {}), // hangs forever (no timer → no leak)
    translate: () => new Promise(() => {}),
    llm: () => new Promise(() => {}),
    retryDelayMs: 0,
    deadlineMs: 40,
  });
  assert.deepEqual(result, { ok: false, error: LOOKUP_UNAVAILABLE });
  assert.ok(Date.now() - started < 5000, "must return when the deadline expires");
});

test("deadline: fast pipelines are unaffected (default budget)", async () => {
  const result = await resolveLookup("quickly", {
    dictionary: async () => ({ gloss: "g", example: "e" }),
    translate: async () => "t",
    llm: async () => null,
    retryDelayMs: 0,
  });
  assert.equal(asOk(result).source, "dictionary");
  assert.ok(LOOKUP_DEADLINE_MS >= 8000 && LOOKUP_DEADLINE_MS <= 10000, "8–10 s budget");
});
