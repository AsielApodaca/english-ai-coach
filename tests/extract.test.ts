import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJSON } from "../src/lib/providers/index.ts";
import { detectKind, trimToBudget } from "../src/lib/ingest/extract.ts";

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

// Strict parsing (regression: a collapsed fragments array persisted a
// one-fragment model answer). The local model drops the `}{` separator between
// array items, so every item folds into ONE object with repeated keys — which
// JSON.parse happily accepts, keeping only the last value of each key.

test("extractJSON: rejects array items that lost their `}{` separator", () => {
  const collapsed =
    `{"question":"Tell me about Zenda.","fragments":[{"id":"f1","stage":"Opening","text":"First line.",` +
    `"id":"f5","stage":"Closing","text":"Now our data is reliable."}]}`;
  assert.throws(() => extractJSON(collapsed), /Duplicate key "id"/);
});

test("extractJSON: a repeated key in a nested object is rejected too", () => {
  assert.throws(() => extractJSON('{"a":{"x":1,"x":2}}'), /Duplicate key "x"/);
});

test("extractJSON: keys repeated across sibling objects are fine", () => {
  const out = extractJSON<{ a: { id: string }; b: { id: string } }>('{"a":{"id":"f1"},"b":{"id":"f2"}}');
  assert.deepEqual(out, { a: { id: "f1" }, b: { id: "f2" } });
});

test("extractJSON: quotes and escapes inside values do not confuse the key scan", () => {
  const out = extractJSON<{ s: string; n: number }>('{"s":"quote \\" brace {} comma ,","n":1}');
  assert.equal(out.s, 'quote " brace {} comma ,');
  assert.equal(out.n, 1);
});

// Feature 104 additions: the existing extract.test.ts is extended with the
// pure helpers of src/lib/ingest/extract.ts (bulk coverage lives in extract-files.test.ts).

test("extract: detectKind resolves supported extensions", () => {
  assert.equal(detectKind("job-spec.pdf"), "pdf");
  assert.equal(detectKind("notes.DOCX"), "docx");
  assert.equal(detectKind("readme.md"), "md");
  assert.equal(detectKind("notes.txt"), "txt");
  assert.equal(detectKind("image.png"), undefined);
});

test("extract: trimToBudget cuts at a word boundary", () => {
  assert.equal(trimToBudget("one two three", 8), "one two");
  assert.equal(trimToBudget("short", 100), "short");
});