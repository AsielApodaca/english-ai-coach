import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createApp, type AppDeps } from "../src/lib/app.ts";
import { createStorage } from "../src/lib/storage.ts";
import { createTtsCache } from "../src/lib/tts-cache.ts";
import { createRefinementRegistry } from "../src/lib/refinement.ts";
import { createLookupCache } from "../src/lib/lookup.ts";
import { CHAT_MAX_CHARS } from "../src/lib/routes/chat.ts";
import type { Provider } from "../src/lib/providers/types.ts";

// ---------------------------------------------------------------------------
// Feature 117 — behaviour tests over the REAL app factory. The whole HTTP
// surface (createApp) is exercised on an ephemeral port with fake singletons
// and no new dependencies: `app.listen(0)` + global fetch. Every LLM is a
// non-configured double (`available() → false`), so no test here can reach
// the network; routes that would call an LLM fail fast into their documented
// offline/error branch instead.
// ---------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Provider double: the registry exists, no provider is ever reachable. */
const offlineProvider: Provider = {
  id: "mock",
  name: "Offline test double",
  async available() {
    return false;
  },
  async complete() {
    throw new Error("network must not be used in these tests");
  },
};

let tmpDir: string;
let storage: ReturnType<typeof createStorage>;
let server: Server;
let base = "";

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "coach-app-http-"));
  storage = createStorage(tmpDir);
  const deps: AppDeps = {
    storage,
    providers: [offlineProvider],
    primaryProviderId: "mock",
    ttsCache: createTtsCache({ dir: join(tmpDir, "tts-cache") }),
    refinements: createRefinementRegistry(),
    lookupCache: createLookupCache(),
    rootDir: repoRoot,
    // OLLAMA_WARM=0: registering the routes must NOT fire the boot warm here.
    env: { OLLAMA_WARM: "0" },
  };
  const app = createApp(deps);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  rmSync(tmpDir, { recursive: true, force: true });
});

/** POST a JSON body and return the response plus its parsed body. */
async function postJson(path: string, body: unknown): Promise<{ res: Response; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { res, json };
}

test("importing app.ts opens no port and keeps no handle alive", () => {
  // The entrypoint contract (app.ts JSDoc): importing the module has NO side
  // effects — no listen, no timers. A child process that imports it and prints
  // must EXIT on its own; a leaked listening socket (or warmup timer) would
  // keep the event loop alive and the spawn would die by timeout (status null).
  const appUrl = pathToFileURL(join(repoRoot, "src", "lib", "app.ts")).href;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(appUrl)}); console.log("IMPORT_OK");`],
    { cwd: repoRoot, encoding: "utf8", timeout: 15_000 },
  );
  assert.equal(child.status, 0, `import child did not exit cleanly:\n${child.stderr}`);
  assert.match(child.stdout, /IMPORT_OK/);
});

test("GET /api/health → 200 { ok: true } with every subsystem probed", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    primary: string;
    providers: Record<string, boolean>;
    dataDir: string;
  };
  assert.equal(body.ok, true);
  assert.equal(body.primary, "mock");
  // available() is the double's (no network probe possible in these tests).
  assert.deepEqual(body.providers, { mock: false });
  assert.equal(body.dataDir, storage.dataDir);
});

test("POST /api/session/save: a client-supplied id never overwrites an existing session", async () => {
  const first = await postJson("/api/session/save", { question: "What is your biggest strength?", fragments: [] });
  assert.equal(first.res.status, 200);
  const firstId = first.json.id;
  assert.equal(typeof firstId, "string");

  // The client tries to aim the save at the first session's file.
  const second = await postJson("/api/session/save", {
    id: firstId,
    question: "Describe a recent project.",
    fragments: [],
  });
  assert.equal(second.res.status, 200);
  assert.equal(typeof second.json.id, "string");
  assert.notEqual(second.json.id, firstId, "the id is always server-generated");

  // The first session is untouched: same question, still loadable.
  const firstSession = storage.loadSession(String(firstId));
  assert.ok(firstSession);
  assert.equal(firstSession.questions[0].q, "What is your biggest strength?");
  const secondSession = storage.loadSession(String(second.json.id));
  assert.ok(secondSession);
  assert.equal(secondSession.questions[0].q, "Describe a recent project.");
});

test("malformed JSON body → JSON { error }, never HTML (real createApp wiring)", async () => {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"message": ',
  });
  // Documented contract (http-errors.ts): an exception that reaches the global
  // handler — including express.json()'s parse failure — is a 500 { error }.
  assert.equal(res.status, 500);
  assert.match(String(res.headers.get("content-type")), /application\/json/);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(typeof body.error, "string");
});

test("unknown /api/* route → 404 { error } as JSON", async () => {
  const res = await fetch(`${base}/api/desconocida`);
  assert.equal(res.status, 404);
  assert.match(String(res.headers.get("content-type")), /application\/json/);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.match(String(body.error), /Unknown API route/);
});

test(`POST /api/chat: message longer than ${CHAT_MAX_CHARS} chars → 400 before any LLM call`, async () => {
  const { res, json } = await postJson("/api/chat", { message: "x".repeat(CHAT_MAX_CHARS + 1) });
  assert.equal(res.status, 400);
  assert.match(String(json.error), /exceeds 4000 characters/);
});

test("POST /api/session/checkpoint: invalid eval → 400 before anything is persisted", async () => {
  // The id below does not exist: were the shape check to run after the lookup
  // (or not at all), this would answer 404/200 instead of 400.
  const { res, json } = await postJson("/api/session/checkpoint", {
    id: "never-persisted-session",
    eval: { score: 10 },
  });
  assert.equal(res.status, 400);
  assert.match(String(json.error), /SessionEval/);
});
