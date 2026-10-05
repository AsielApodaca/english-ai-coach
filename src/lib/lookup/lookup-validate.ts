/**
 * Query normalization, validation and the same-origin gate of
 * `GET /api/lookup` (feature 112) — split out of `lookup.ts` by feature 117.
 *
 * Everything here is pure: raw client input in, `{ ok: true, text }` or
 * `{ ok: false, error }` out, never touching the network.
 */

import { LOOKUP_MAX_CHARS } from "./lookup-types.ts";
import type { LookupFailure, LookupKind } from "./lookup-types.ts";

/**
 * Normalize a raw selection/word into the canonical lookup key: collapse all
 * whitespace (multi-line selections included), strip edge punctuation and
 * lowercase. Returns "" for non-strings or text with no letters/digits.
 *
 * Mirrored by `normalizeLookupText` in `public/ui/lookup-popover.js` (the
 * browser needs the same key for its client cache; no build step to share it).
 *
 * @param raw - raw text (selection `.toString()`, `data-word`, query param)
 * @returns the normalized text, or "" when there is nothing to look up
 */
export function normalizeLookupText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "")
    .toLowerCase();
}

export type LookupValidation = { ok: true; text: string } | LookupFailure;

/**
 * Validate a lookup query before any external call (spec 112 "Límites"):
 * required, ≤ 60 chars before and after normalization, and karaoke-ish —
 * letters/digits with internal apostrophes/hyphens/whitespace and the
 * separators a dragged selection can carry. Arbitrary text (URLs, symbols)
 * is rejected with `ok: false` and NO network traffic.
 *
 * @param raw - the `text` query param / selected text
 */
export function validateLookupText(raw: unknown): LookupValidation {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: "text is required." };
  }
  if (raw.trim().length > LOOKUP_MAX_CHARS) {
    return { ok: false, error: `text exceeds ${LOOKUP_MAX_CHARS} characters.` };
  }
  const text = normalizeLookupText(raw);
  if (!text) {
    return { ok: false, error: "text has no letters or numbers." };
  }
  if (text.length > LOOKUP_MAX_CHARS) {
    return { ok: false, error: `text exceeds ${LOOKUP_MAX_CHARS} characters.` };
  }
  const first = text.charAt(0);
  const last = text.charAt(text.length - 1);
  if (!/[\p{L}\p{N}]/u.test(first) || !/[\p{L}\p{N}]/u.test(last)) {
    return { ok: false, error: "text is not a karaoke token." };
  }
  if (!/^[\p{L}\p{N}\s'’.,!?;:\-]+$/u.test(text)) {
    return { ok: false, error: "text is not a karaoke token." };
  }
  return { ok: true, text };
}

/**
 * Number of whitespace-separated tokens of a normalized text.
 * @param text - normalized lookup text
 */
export function countLookupTokens(text: string): number {
  return text.split(" ").filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Same-origin gate for GET /api/lookup
// ---------------------------------------------------------------------------

/** Request headers the cross-origin decision needs (tests fake them). */
export interface LookupRequestHeaders {
  origin?: string | readonly string[] | undefined;
  host?: string | readonly string[] | undefined;
  secFetchSite?: string | readonly string[] | undefined;
}

/** First value of a possibly repeated header, trimmed; `undefined` if none. */
function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  const raw = typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

/**
 * Cheap cross-origin decision for `GET /api/lookup` (review fix #3): a GET is
 * a CORS "simple request" (no preflight), so any web page could otherwise use
 * this local server as a free MyMemory/LLM translation proxy — the charset
 * validation does not stop a well-formed English sentence.
 *
 * Rejects when:
 *   - `Sec-Fetch-Site` is present and is not `same-origin` (cross-site
 *     `<img>`/`fetch` from another page, direct navigation), or
 *   - `Origin` is present and its host differs from the request `Host`
 *     (also covers the opaque `"null"` origin and malformed values).
 *
 * Same-origin requests (the local app) and header-less clients (curl, the
 * smoke tests) pass: browsers omit `Origin` on same-origin GETs.
 *
 * @param headers - the request's `Origin`, `Host` and `Sec-Fetch-Site`
 */
export function isSameOriginLookupRequest(headers: LookupRequestHeaders): boolean {
  const secFetchSite = firstHeader(headers.secFetchSite);
  if (secFetchSite !== undefined && secFetchSite !== "same-origin") return false;
  const origin = firstHeader(headers.origin);
  if (origin === undefined) return true; // same-origin GET / non-browser client
  const host = firstHeader(headers.host);
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false; // opaque ("null") or malformed Origin
  }
}

/**
 * Pipeline kind from the token count (spec 112: the server decides `kind`,
 * one endpoint for both).
 * @param text - normalized lookup text
 */
export function lookupKind(text: string): LookupKind {
  return countLookupTokens(text) >= 2 ? "phrase" : "word";
}