import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { apiErrorHandler, apiNotFound } from "../src/lib/http-errors.ts";

// ---------------------------------------------------------------------------
// Feature 117 — global /api error contracts. The acceptance criterion is
// "never HTML": a malformed JSON body, an uncaught exception and an unknown
// /api route must all answer `{ error: string }` with a status. The app is a
// minimal express instance wired exactly like server.ts wires it (routes,
// THEN apiNotFound, THEN apiErrorHandler) so the middleware is exercised over
// real HTTP without importing server.ts (which opens a port at import time).
// ---------------------------------------------------------------------------

let server: Server;
let base = "";

before(async () => {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post("/api/echo", (req, res) => {
    res.json({ echo: req.body });
  });
  app.post("/api/boom", () => {
    throw new Error("boom");
  });
  app.use("/api", apiNotFound);
  app.use("/api", apiErrorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

test("unknown /api/* route → 404 { error } as JSON", async () => {
  const res = await fetch(`${base}/api/does-not-exist`);
  assert.equal(res.status, 404);
  assert.match(String(res.headers.get("content-type")), /application\/json/);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(typeof body.error, "string");
});

test("uncaught exception in a route → 500 { error } as JSON", async () => {
  const res = await fetch(`${base}/api/boom`, { method: "POST" });
  assert.equal(res.status, 500);
  assert.match(String(res.headers.get("content-type")), /application\/json/);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.match(String(body.error), /boom/);
});

test("malformed JSON body → 500 { error } as JSON, never HTML", async () => {
  const res = await fetch(`${base}/api/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"broken": ',
  });
  assert.equal(res.status, 500);
  assert.match(String(res.headers.get("content-type")), /application\/json/);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(typeof body.error, "string");
});

test("success responses are untouched by the error middleware", async () => {
  const res = await fetch(`${base}/api/echo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { echo: { hello: "world" } });
});

test("non-/api routes keep Express' default handling (middleware is scoped)", async () => {
  const res = await fetch(`${base}/not-an-api-route`);
  assert.equal(res.status, 404);
  // Express' own HTML 404 — the JSON contract only covers /api/*.
  assert.match(String(res.headers.get("content-type")), /text\/html/);
});
