import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTtsCache,
  ttsCacheKey,
  withTtsCache,
  TTS_CACHE_TTL_MS,
} from "../src/lib/tts-cache.ts";

let dir = "";
let cacheDir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engcoach-cache-test-"));
  cacheDir = join(dir, "tts-cache");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BASE_KEY = {
  engine: "piper",
  voice: "en_US-amy-medium",
  rate: 1,
  segments: ["Hello there, my friend."],
  pauses: [220, 650],
};

/** Files currently living in the cache directory. */
function cacheFiles(): string[] {
  try {
    return readdirSync(cacheDir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Key: engine/voice/rate/segments/pauses all take part (spec acceptance)
// ---------------------------------------------------------------------------

test("ttsCacheKey: identical inputs produce the same key (⇒ hit)", () => {
  assert.equal(ttsCacheKey({ ...BASE_KEY }), ttsCacheKey({ ...BASE_KEY }));
});

test("ttsCacheKey: engine, voice, rate, segments and pauses each change the key", () => {
  const base = ttsCacheKey({ ...BASE_KEY });
  const variants = [
    { ...BASE_KEY, engine: "edge-tts" },
    { ...BASE_KEY, voice: "en_US-ryan-medium" },
    { ...BASE_KEY, rate: 1.25 },
    { ...BASE_KEY, segments: ["Hello there, my friend!"] },
    { ...BASE_KEY, pauses: [400, 650] },
  ];
  for (const v of variants) {
    assert.notEqual(ttsCacheKey(v), base, `variant must not collide: ${JSON.stringify(v)}`);
  }
});

test("ttsCacheKey: segment boundaries cannot be forged by re-joining text", () => {
  const joined = ttsCacheKey({ ...BASE_KEY, segments: ["ab", "c"] });
  const single = ttsCacheKey({ ...BASE_KEY, segments: ["abc"] });
  assert.notEqual(joined, single);
});

// ---------------------------------------------------------------------------
// Hit / miss
// ---------------------------------------------------------------------------

test("cache: miss then hit returns the very same bytes", async () => {
  const cache = createTtsCache({ dir: cacheDir });
  const key = ttsCacheKey({ ...BASE_KEY });
  const payload = Buffer.from("RIFF-fake-audio");

  let synthCount = 0;
  const synth = async () => {
    synthCount++;
    return payload;
  };

  const first = await withTtsCache(cache, key, synth);
  assert.equal(first.cacheHit, false);
  assert.equal(first.audio, payload);

  const second = await withTtsCache(cache, key, synth);
  assert.equal(second.cacheHit, true);
  assert.deepEqual(second.audio, payload);
  assert.equal(synthCount, 1, "a hit must not synthesize again");
});

test("cache: a different key misses even with the same cache instance", async () => {
  const cache = createTtsCache({ dir: cacheDir });
  await withTtsCache(cache, ttsCacheKey({ ...BASE_KEY }), async () => Buffer.from("a"));

  const otherEngine = await withTtsCache(
    cache,
    ttsCacheKey({ ...BASE_KEY, engine: "edge-tts" }),
    async () => Buffer.from("b"),
  );
  assert.equal(otherEngine.cacheHit, false);

  const otherRate = await withTtsCache(
    cache,
    ttsCacheKey({ ...BASE_KEY, rate: 1.25 }),
    async () => Buffer.from("c"),
  );
  assert.equal(otherRate.cacheHit, false);
  assert.equal(cache.size, 3);
});

test("cache: survives a restart (index rebuilt from the directory)", async () => {
  const key = ttsCacheKey({ ...BASE_KEY });
  const boot1 = createTtsCache({ dir: cacheDir });
  await withTtsCache(boot1, key, async () => Buffer.from("persisted"));

  const boot2 = createTtsCache({ dir: cacheDir }); // simulates a server restart
  const hit = await withTtsCache(boot2, key, async () => {
    throw new Error("must not synthesize on a warm cache");
  });
  assert.equal(hit.cacheHit, true);
  assert.equal(hit.audio.toString(), "persisted");
});

// ---------------------------------------------------------------------------
// TTL invalidation
// ---------------------------------------------------------------------------

test("cache: get() on an expired entry misses and drops the file", async () => {
  const key = ttsCacheKey({ ...BASE_KEY });
  const cache = createTtsCache({ dir: cacheDir, ttlMs: 1000 });
  await withTtsCache(cache, key, async () => Buffer.from("stale"));

  // Backdate the file beyond the TTL (the mtime is the source of truth).
  const file = join(cacheDir, `${key}.bin`);
  const past = new Date(Date.now() - TTS_CACHE_TTL_MS - 60_000);
  utimesSync(file, past, past);

  assert.equal(cache.get(key), null, "expired entries must miss");
  assert.equal(existsSync(file), false, "expired file must be removed from disk");
  assert.equal(cache.size, 0);
});

test("cache: purgeExpired removes only the entries past the TTL", () => {
  const cache = createTtsCache({ dir: cacheDir, ttlMs: 1000 });
  const staleKey = "d".repeat(40); // valid sha1 shape (hex), unlike a bare "s"
  const freshKey = "f".repeat(40);
  cache.set(staleKey, Buffer.from("old"));
  cache.set(freshKey, Buffer.from("new"));

  const file = join(cacheDir, `${staleKey}.bin`);
  const past = new Date(Date.now() - TTS_CACHE_TTL_MS - 60_000);
  utimesSync(file, past, past);

  const purged = cache.purgeExpired();
  assert.equal(purged, 1);
  assert.equal(existsSync(file), false, "expired file must be removed from disk");
  assert.equal(cache.size, 1);
  assert.ok(cache.get(freshKey), "the fresh entry survives the purge");
});

test("cache: a fresh restart purges what the TTL already expired", () => {
  const key = ttsCacheKey({ ...BASE_KEY });
  const first = createTtsCache({ dir: cacheDir });
  first.set(key, Buffer.from("old"));

  const file = join(cacheDir, `${key}.bin`);
  const past = new Date(Date.now() - TTS_CACHE_TTL_MS - 60_000);
  utimesSync(file, past, past);

  // New process → createTtsCache scans the dir and drops expired files.
  const second = createTtsCache({ dir: cacheDir });
  assert.equal(second.size, 0);
  assert.equal(existsSync(file), false);
});

// ---------------------------------------------------------------------------
// LRU eviction (entries + bytes)
// ---------------------------------------------------------------------------

test("cache: evicts the least recently used entry beyond maxEntries", async () => {
  const cache = createTtsCache({ dir: cacheDir, maxEntries: 2 });
  const keyA = "a".repeat(40);
  const keyB = "b".repeat(40);
  const keyC = "c".repeat(40);

  cache.set(keyA, Buffer.from("A"));
  cache.set(keyB, Buffer.from("B"));
  // Touch A so B becomes the least recently used.
  assert.ok(cache.get(keyA));

  cache.set(keyC, Buffer.from("C"));

  assert.equal(cache.size, 2);
  assert.ok(cache.get(keyA), "recently used entry survives");
  assert.equal(cache.get(keyB), null, "LRU entry was evicted");
  assert.ok(cache.get(keyC));
  assert.equal(cacheFiles().length, 2, "evicted files are deleted from disk");
});

test("cache: evicts until totalBytes fits maxBytes", () => {
  const cache = createTtsCache({ dir: cacheDir, maxEntries: 100, maxBytes: 2500 });
  // Keys must have the sha1-hex shape (get/set validate it — review fix #7).
  cache.set("a1".padEnd(40, "0"), Buffer.alloc(1000, 1));
  cache.set("b1".padEnd(40, "0"), Buffer.alloc(1000, 2));
  assert.equal(cache.size, 2);

  cache.set("c1".padEnd(40, "0"), Buffer.alloc(1000, 3)); // 3000 > 2500
  assert.ok(cache.totalBytes <= 2500, `totalBytes ${cache.totalBytes}`);
  assert.equal(cache.size, 2, "the oldest entry was dropped to fit the byte cap");
});

// ---------------------------------------------------------------------------
// Errors are never cached (spec acceptance)
// ---------------------------------------------------------------------------

test("cache: a failing synthesis is not stored and the next call retries", async () => {
  const cache = createTtsCache({ dir: cacheDir });
  const key = ttsCacheKey({ ...BASE_KEY });
  let calls = 0;

  await assert.rejects(
    () =>
      withTtsCache(cache, key, async () => {
        calls++;
        throw new Error("engine exploded");
      }),
    /engine exploded/,
  );
  assert.equal(cache.size, 0, "errors must never be cached");
  assert.equal(cacheFiles().length, 0);

  // Next call retries the synthesis (it did NOT latch the failure).
  const ok = await withTtsCache(cache, key, async () => {
    calls++;
    return Buffer.from("recovered");
  });
  assert.equal(ok.cacheHit, false);
  assert.equal(calls, 2);
  assert.equal(cache.size, 1);
});

test("cache: set() failures never throw (a broken tmp must not break the request)", () => {
  const cache = createTtsCache({ dir: cacheDir });
  // A file where the directory should be → mkdir/write fails → swallowed.
  const blocked = join(dir, "blocked");
  writeFileSync(blocked, "not a directory");
  const broken = createTtsCache({ dir: join(blocked, "nested") });
  assert.doesNotThrow(() => broken.set("a".repeat(40), Buffer.from("x")));
});

// ---------------------------------------------------------------------------
// Key shape (review fix #7): keys become file names — nothing else gets in
// ---------------------------------------------------------------------------

test("cache: get/set reject keys that are not sha1 hex (path-traversal defense)", () => {
  const cache = createTtsCache({ dir: cacheDir });
  const foreignKeys = [
    "../../etc/passwd",
    "../evil",
    "a/b",
    "",
    "nothex".padEnd(40, "0"), // wrong alphabet
    "A".repeat(40), // uppercase is not what ttsCacheKey produces
    "abc", // truncated
  ];
  for (const key of foreignKeys) {
    assert.equal(cache.get(key), null, `get must reject: ${key}`);
    assert.doesNotThrow(() => cache.set(key, Buffer.from("payload")));
    assert.equal(cache.size, 0, `set must ignore: ${key}`);
  }
  assert.equal(cacheFiles().length, 0, "no file may be written under a foreign key");
  // The legitimate path still works (the guard only blocks malformed keys).
  const key = ttsCacheKey({ ...BASE_KEY });
  cache.set(key, Buffer.from("ok"));
  assert.equal(cache.get(key)?.toString(), "ok");
});
