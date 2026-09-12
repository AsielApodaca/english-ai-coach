import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJSON } from "../src/lib/providers/index.ts";

test("extractJSON: plain JSON object", () => {
  const out = extractJSON<{ q: string }>('{"q": "hello"}');
  assert.equal(out.q, "hello");
});

test("extractJSON: JSON wrapped in markdown fences", () => {
  const out = extractJSON<{ a: number }>('```json\n{"a": 42}\n```');
  assert.equal(out.a, 42);
});

test("extractJSON: JSON embedded in prose", () => {
  const out = extractJSON<{ ok: boolean }>('Sure, here you go: {"ok": true}. Hope it helps.');
  assert.equal(out.ok, true);
});

test("extractJSON: nested object with braces in strings", () => {
  const out = extractJSON<{ s: string }>('{"s": "use {} carefully"}');
  assert.equal(out.s, "use {} carefully");
});

test("extractJSON: array value", () => {
  const out = extractJSON<string[]>('["a", "b"]');
  assert.deepEqual(out, ["a", "b"]);
});

test("extractJSON: throws when no JSON found", () => {
  assert.throws(() => extractJSON("no json here at all"));
});