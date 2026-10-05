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
import { createStorage } from "../src/lib/session/storage.ts";
import { createTtsCache } from "../src/lib/audio/tts-cache.ts";
import { createRefinementRegistry } from "../src/lib/practice/refinement.ts";
import { createLookupCache } from "../src/lib/lookup/lookup.ts";
import { CHAT_MAX_CHARS } from "../src/lib/routes/chat.ts";
import { evaluateFragmentDeterministic } from "../src/lib/practice/practice-eval.ts";
import type { Provider } from "../src/lib/providers/types.ts";
import type { OllamaLauncher } from "../src/lib/providers/ollama-launch.ts";

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
let deps: AppDeps;
let server: Server;
let base = "";

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "coach-app-http-"));
  storage = createStorage(tmpDir);
  deps = {
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

test("POST /api/session/save: a storage failure answers 500 { error } JSON, never HTML", async () => {
  // The persistence try must sit INSIDE the route (feature 117, spec
  // criterion "saveSession roto → 500 { error }"): before it, the exception
  // escaped to Express' default handler and the client got an HTML page.
  const brokenDeps: AppDeps = {
    ...deps,
    storage: { ...deps.storage, saveSession() { throw new Error("disk full (test double)"); } },
  };
  const brokenServer: Server = await new Promise((resolve) => {
    const s = createApp(brokenDeps).listen(0, () => resolve(s));
  });
  try {
    const brokenBase = `http://127.0.0.1:${(brokenServer.address() as AddressInfo).port}`;
    const res = await fetch(`${brokenBase}/api/session/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Will this ever hit the disk?" }),
    });
    assert.equal(res.status, 500);
    assert.match(String(res.headers.get("content-type")), /application\/json/);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ["error"]);
    assert.match(String(body.error), /disk full/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      brokenServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test("POST /api/evaluate: invalid sessionId/fragmentId → 400 before any evaluation", async () => {
  const badSession = await postJson("/api/evaluate", {
    target: "hello there",
    userText: "hello",
    sessionId: "../../escape",
  });
  assert.equal(badSession.res.status, 400);
  assert.match(String(badSession.json.error), /sessionId/);

  const badFragment = await postJson("/api/evaluate", {
    target: "hello there",
    userText: "hello",
    fragmentId: "../../escape",
  });
  assert.equal(badFragment.res.status, 400);
  assert.match(String(badFragment.json.error), /fragmentId/);
});

test("POST /api/attempt: invalid sessionId → 400 before whisper or persistence", async () => {
  // The guards run before the mode/body checks (routes/attempt.ts), so an
  // empty JSON body still reaches them: no whisper, no temp file, no storage.
  const { res, json } = await postJson("/api/attempt?target=hello&sessionId=..%2Fescape", {});
  assert.equal(res.status, 400);
  assert.match(String(json.error), /sessionId/);
});

test("POST /api/evaluate: verdict/next follow the session's passThreshold, not the default 70", async () => {
  // A partial answer scores 57 on this pair (deterministic, no LLM): below the
  // default threshold (70 → next:false) but above the custom one we install on
  // the session (52 → next:true). If the route ignored the snapshot, both calls
  // would agree.
  const target = "I led the migration of our billing service to the new platform last quarter";
  const userText = "I led the migration of our billing service";
  const { evaluation: baseline } = evaluateFragmentDeterministic({ target, userText });
  const score = baseline.score;
  assert.ok(score > 5 && score < 70, `crafted pair must land in (5, 70), got ${score}`);

  const saved = await postJson("/api/session/save", { question: target });
  assert.equal(saved.res.status, 200);
  const sessionId = String(saved.json.id);
  const session = storage.loadSession(sessionId);
  assert.ok(session);
  session.config.settingsSnapshot = {
    ...session.config.settingsSnapshot,
    overrides: { ...session.config.settingsSnapshot.overrides, passThreshold: score - 5 },
  };
  storage.saveSession(session);

  interface EvalBody { evaluation: { score: number; next: boolean; verdict: string } }
  const withSession = await postJson("/api/evaluate", { target, userText, sessionId });
  assert.equal(withSession.res.status, 200);
  const sessionEval = (withSession.json as unknown as EvalBody).evaluation;
  assert.equal(sessionEval.score, score, "the offline path is fully deterministic");
  assert.equal(sessionEval.next, true, "session threshold (score-5) must be applied");
  assert.equal(sessionEval.verdict, "great");

  const withoutSession = await postJson("/api/evaluate", { target, userText });
  assert.equal(withoutSession.res.status, 200);
  const defaultEval = (withoutSession.json as unknown as EvalBody).evaluation;
  assert.equal(defaultEval.next, false, "no session → the documented 70 fallback applies");
  assert.equal(defaultEval.verdict, "almost");
});

test("POST /api/warmup: warm failure with the server down consults the injected launcher and re-warms (119)", async () => {
  // Local double: the FIRST warm fails (server down), the re-warm succeeds.
  let warmCalls = 0;
  const ollamaProvider: Provider = {
    id: "ollama",
    name: "Ollama test double",
    async available() {
      return true;
    },
    async complete() {
      warmCalls++;
      if (warmCalls === 1) throw new Error("server down");
      return "ok";
    },
  };
  // Launcher double: registers what health.ts consulted, never spawns anything.
  const launcherCalls = { isUp: 0, ensure: 0 };
  const launcher: OllamaLauncher = {
    async isUp() {
      launcherCalls.isUp++;
      return false;
    },
    async ensureRunning() {
      launcherCalls.ensure++;
      return true;
    },
  };

  // Warm enabled (no OLLAMA_WARM=0): createApp fires the boot warm through the
  // injected launcher, so no real `ollama serve` can be spawned here.
  const warmDeps: AppDeps = { ...deps, providers: [ollamaProvider], ollamaLauncher: launcher, env: {} };
  const warmServer: Server = await new Promise((resolve) => {
    const s = createApp(warmDeps).listen(0, () => resolve(s));
  });
  try {
    const warmBase = `http://127.0.0.1:${(warmServer.address() as AddressInfo).port}`;
    const res = await fetch(`${warmBase}/api/warmup`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; warmed: Record<string, boolean> };
    assert.equal(body.ok, true, "the re-warm after the launch must succeed");
    assert.deepEqual(body.warmed, { ollama: true });
    // Whether the endpoint joined the boot warm or ran its own, the launcher
    // was consulted exactly once for this one down-server failure.
    assert.deepEqual(launcherCalls, { isUp: 1, ensure: 1 });
    assert.ok(warmCalls >= 2, "failure → launch → re-warm");
  } finally {
    await new Promise<void>((resolve, reject) => {
      warmServer.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
