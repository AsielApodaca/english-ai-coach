import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorage, type Session } from "../src/lib/storage.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engcoach-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("storage: empty profile defaults to level B1", () => {
  const s = createStorage(dir);
  const p = s.loadProfile();
  assert.equal(p.level, "B1");
});

test("storage: save and load session round-trips", () => {
  const s = createStorage(dir);
  const session: Session = {
    id: "abc",
    date: new Date().toISOString(),
    category: "star",
    level: "B2",
    provider: "zen",
    question: "Tell me about a difficult situation",
    context: "Focus on action verbs",
    fragments: [
      {
        id: "f1",
        stage: "Situation",
        text: "Once in this company I had a difficult situation.",
        attempts: [{ text: "Once in this company I had a difficult situation.", score: 100, missing: [], extra: [], issues: [], verdict: "great" }],
        passed: true,
      },
    ],
  };
  s.saveSession(session);
  assert.equal(s.listSessions().length, 1);
  const loaded = s.loadSession("abc");
  assert.equal(loaded?.question, session.question);
  assert.equal(loaded?.fragments[0].attempts[0].score, 100);
});

test("storage: sessions are sorted by date", () => {
  const s = createStorage(dir);
  s.saveSession({ id: "2", date: "2026-01-02", category: "free", level: "B1", provider: "zen", question: "q2", context: "", fragments: [] });
  s.saveSession({ id: "1", date: "2026-01-01", category: "free", level: "B1", provider: "zen", question: "q1", context: "", fragments: [] });
  const list = s.listSessions();
  assert.equal(list[0].id, "1");
  assert.equal(list[1].id, "2");
});

test("storage: corrupted profile falls back to defaults", () => {
  const s = createStorage(dir);
  writeFileSync(join(dir, "data", "profile.json"), "{broken", "utf8");
  const p = s.loadProfile();
  assert.equal(p.level, "B1");
});

test("storage: session turns round-trip through save and load", () => {
  const s = createStorage(dir);
  const session: Session = {
    id: "conv1",
    date: new Date().toISOString(),
    category: "free",
    level: "B2",
    provider: "zen",
    question: "",
    context: "",
    fragments: [],
    turns: [
      { role: "user", text: "I decided for this approach." },
      { role: "assistant", text: "Nice — why did you pick it?" },
    ],
  };
  s.saveSession(session);
  const loaded = s.loadSession("conv1");
  assert.deepEqual(loaded?.turns, session.turns);
});

test("storage: session without turns loads with turns undefined", () => {
  const s = createStorage(dir);
  s.saveSession({ id: "no-turns", date: "2026-01-01", category: "free", level: "B1", provider: "zen", question: "q", context: "", fragments: [] });
  const loaded = s.loadSession("no-turns");
  assert.equal(loaded?.turns, undefined);
});