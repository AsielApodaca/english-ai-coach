/**
 * Server-side synthesis cache (feature 114).
 *
 * The same coach line used to be re-synthesized on every retry/loop and each
 * render could differ slightly — the repetitions "crunched" or skipped. This
 * cache keys a synthesis by WHAT produced it (engine | voice | rate |
 * segments | pauses) and stores the final bytes under `data/tmp/tts-cache/`
 * (disposable, git-ignored, never in the repo).
 *
 * Design (spec 114):
 *   - LRU with both an entry cap and a byte cap (100 entries / 50 MB),
 *   - 24 h TTL based on the file mtime (survives restarts),
 *   - expired files are purged when the cache is built (server boot),
 *   - errors are never cached — only successful syntheses are stored,
 *   - a missing/corrupt cache is always safe: the caller just re-synthesizes.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Entries older than this are dropped (spec: TTL ~24 h). */
export const TTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** LRU entry cap (spec: ~100 entries). */
export const TTS_CACHE_MAX_ENTRIES = 100;

/** LRU byte cap (spec: ~50 MB). */
export const TTS_CACHE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Keys are sha1 hex digests ({@link ttsCacheKey}) and become file names
 * under the cache dir — anything else is rejected in `get`/`set` so a future
 * caller can never smuggle a path separator past `join()` (defense in depth
 * against path traversal, review fix #7).
 */
const KEY_RE = /^[a-f0-9]{40}$/;

/** True when `key` is a sha1 hex digest the cache will ever produce. */
const isValidKey = (key: string): boolean => KEY_RE.test(key);

/** Inputs that uniquely identify one synthesis result (feature 114). */
export interface TtsCacheKeyParts {
  /** Engine that produced the audio (`piper` | `edge-tts`). */
  engine: string;
  /** Effective voice id (Piper voice or edge voice). */
  voice: string;
  /** Speed factor (0.5–2), as sent by the client. */
  rate: number;
  /** The exact segments synthesized, in order. */
  segments: string[];
  /** Silence after each segment (ms), same length as `segments`. */
  pauses: number[];
}

/**
 * Build the cache key: `sha1(engine|voice|rate|segments|pauses)`.
 *
 * Deterministic and collision-resistant for local use; the NUL separator
 * inside the joined segments keeps `["a|b"]` and `["a", "b"]` apart.
 */
export function ttsCacheKey(parts: TtsCacheKeyParts): string {
  const payload = [
    parts.engine,
    parts.voice,
    String(parts.rate),
    parts.segments.join("\u0000"),
    parts.pauses.join(","),
  ].join("|");
  return createHash("sha1").update(payload).digest("hex");
}

export interface TtsCacheOptions {
  /** Directory holding the cached files (created on demand). */
  dir: string;
  /** TTL in ms (default {@link TTS_CACHE_TTL_MS}). */
  ttlMs?: number;
  /** LRU entry cap (default {@link TTS_CACHE_MAX_ENTRIES}). */
  maxEntries?: number;
  /** LRU byte cap (default {@link TTS_CACHE_MAX_BYTES}). */
  maxBytes?: number;
}

export interface TtsCache {
  /** Read a cached buffer; refreshes recency. `null` on miss/expiry. */
  get(key: string): Buffer | null;
  /** Store a successful synthesis and evict the LRU entries beyond the caps. */
  set(key: string, audio: Buffer): void;
  /** Delete every expired entry; returns how many files were removed. */
  purgeExpired(): number;
  /** Drop every entry (used by tests). */
  clear(): void;
  /** Number of live entries. */
  readonly size: number;
  /** Total bytes of the live entries. */
  readonly totalBytes: number;
}

/** One index row: enough to serve/evict without touching the disk. */
interface CacheEntry {
  bytes: number;
  /** File mtime (ms) — the TTL source of truth, survives restarts. */
  mtimeMs: number;
}

/**
 * Create the file-backed LRU cache under `dir`.
 *
 * The index is rebuilt from the directory at construction time, so entries
 * written by a previous run are reused (until their TTL expires) while
 * expired ones are purged right away — the spec's "purge en arranque".
 *
 * @param opts - directory + caps (see {@link TtsCacheOptions}).
 */
export function createTtsCache(opts: TtsCacheOptions): TtsCache {
  const dir = opts.dir;
  const ttlMs = opts.ttlMs ?? TTS_CACHE_TTL_MS;
  const maxEntries = Math.max(1, Math.floor(opts.maxEntries ?? TTS_CACHE_MAX_ENTRIES));
  const maxBytes = Math.max(1, Math.floor(opts.maxBytes ?? TTS_CACHE_MAX_BYTES));

  /** Insertion order = LRU order (oldest first; refreshed on `get`). */
  const index = new Map<string, CacheEntry>();
  let bytes = 0;

  const filePath = (key: string): string => join(dir, `${key}.bin`);

  const drop = (key: string): void => {
    const entry = index.get(key);
    if (!entry) return;
    index.delete(key);
    bytes -= entry.bytes;
    rmSync(filePath(key), { force: true });
  };

  const isExpired = (mtimeMs: number): boolean => Date.now() - mtimeMs > ttlMs;

  const evict = (): void => {
    while (index.size > maxEntries || bytes > maxBytes) {
      const oldest = index.keys().next();
      if (oldest.done) break;
      drop(oldest.value);
    }
  };

  // --- rebuild from disk (boot purge of expired entries) ---
  try {
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".tmp")) {
        rmSync(join(dir, name), { force: true }); // leftover from a crashed write
        continue;
      }
      if (!name.endsWith(".bin")) continue;
      const key = name.slice(0, -4);
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (isExpired(st.mtimeMs)) {
          rmSync(path, { force: true });
          continue;
        }
        index.set(key, { bytes: st.size, mtimeMs: st.mtimeMs });
        bytes += st.size;
      } catch {
        // raced with another process — skip this file
      }
    }
    evict();
  } catch {
    // No cache dir yet (fresh checkout / read-only tmp) — start empty.
  }

  return {
    get(key: string): Buffer | null {
      if (!isValidKey(key)) return null; // never touch the fs with a foreign key
      const entry = index.get(key);
      if (!entry) return null;
      let audio: Buffer;
      try {
        const st = statSync(filePath(key));
        if (isExpired(st.mtimeMs)) {
          drop(key);
          return null;
        }
        audio = readFileSync(filePath(key));
      } catch {
        drop(key); // vanished/corrupt file: treat as a miss, keep the index honest
        return null;
      }
      // Refresh recency only: re-insert at the tail so it becomes the newest
      // (the TTL keeps counting from the write time — see `isExpired`).
      index.delete(key);
      index.set(key, entry);
      return audio;
    },

    set(key: string, audio: Buffer): void {
      if (!isValidKey(key)) return; // no write outside the cache dir, ever
      try {
        mkdirSync(dir, { recursive: true });
        const path = filePath(key);
        // Write via a temp name + rename so a reader never sees a half file.
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, audio);
        renameSync(tmp, path);
      } catch {
        return; // a full/read-only tmp must never fail the request
      }
      const prev = index.get(key);
      if (prev) bytes -= prev.bytes;
      index.set(key, { bytes: audio.length, mtimeMs: Date.now() });
      bytes += audio.length;
      // Refresh recency + enforce both caps (the new entry is never evicted
      // unless it alone breaks the byte cap, in which case it is dropped too).
      evict();
    },

    purgeExpired(): number {
      let removed = 0;
      for (const key of [...index.keys()]) {
        // The file mtime is the TTL source of truth (restart-safe).
        let expired = true;
        try {
          expired = isExpired(statSync(filePath(key)).mtimeMs);
        } catch {
          expired = true; // vanished file → drop the index row
        }
        if (!expired) continue;
        drop(key);
        removed++;
      }
      return removed;
    },

    clear(): void {
      for (const key of [...index.keys()]) drop(key);
    },

    get size(): number {
      return index.size;
    },

    get totalBytes(): number {
      return bytes;
    },
  };
}

/**
 * Run `synth` behind the cache: a hit returns the stored bytes without
 * synthesizing; a miss synthesizes once and stores the result.
 *
 * Failures are NOT cached — the error propagates and the next call retries
 * (spec: "nunca cachea errores"). A failing `set` is swallowed by the cache
 * itself, so a disk problem can never turn a good synthesis into a 500.
 *
 * @param cache - the shared cache (see {@link createTtsCache}).
 * @param key - key built by {@link ttsCacheKey}.
 * @param synth - the synthesis to run on a miss.
 * @returns `{ audio, cacheHit }` for the endpoint to serve + report.
 */
export async function withTtsCache(
  cache: TtsCache,
  key: string,
  synth: () => Promise<Buffer>,
): Promise<{ audio: Buffer; cacheHit: boolean }> {
  const cached = cache.get(key);
  if (cached) return { audio: cached, cacheHit: true };
  const audio = await synth();
  cache.set(key, audio);
  return { audio, cacheHit: false };
}
