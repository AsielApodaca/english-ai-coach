/**
 * Global error middleware for `/api/*` (feature 117).
 *
 * Contracts:
 *   apiNotFound     : RequestHandler     — any unmatched /api/* route
 *                                          → 404 `{ error: string }`
 *   apiErrorHandler : ErrorRequestHandler — any uncaught exception thrown by a
 *                                          route or by the JSON body parser
 *                                          (malformed body) → 500 `{ error: string }`
 *
 * Shape rule (applies to EVERY error body of the app): `{ error: string }` is
 * the BASE shape. Extra fields (`ok`, `code`, `hint`) are added only by the
 * endpoint whose spec defines them — `/api/lookup` answers `ok: false`
 * (spec 112), whisper/tts answer `code` (specs 002/007) and `tts-unavailable`
 * carries `hint` (spec 007). This module never invents fields beyond `error`:
 * an unexpected failure has nothing else to report. Success shapes are
 * untouched — it only fires when the response has not been written yet.
 *
 * Registration (server.ts, AFTER every /api route):
 *   app.use("/api", apiNotFound);
 *   app.use("/api", apiErrorHandler);
 *
 * Deliberate choices:
 *   - Uniform 500 for every uncaught exception, including the malformed-JSON
 *     SyntaxError that `express.json()` throws while parsing: the rule is
 *     "an exception that reached the global middleware is a server-side
 *     failure", and the body must always be JSON (never Express' HTML page).
 *   - The message is the `Error.message`, matching how every route already
 *     reports failures; the stack is never sent to the client and the module
 *     logs nothing (single-user local app, the message reaches the UI).
 */

import type { ErrorRequestHandler, RequestHandler } from "express";

/** 404 for `/api/*` routes no handler claimed — JSON instead of Express' HTML. */
export const apiNotFound: RequestHandler = (req, res) => {
  res.status(404).json({ error: `Unknown API route: ${req.method} ${req.originalUrl}` });
};

/**
 * Last-resort `/api` error handler: turns any uncaught exception into
 * `500 { error }`. Includes the malformed-JSON body-parse error of
 * `express.json()` (it bubbles to middleware as a rejected `next(err)`).
 *
 * When the response has already started (streamed TTS bytes), the error is
 * forwarded to Express' default handler — there is nothing left to write.
 */
export const apiErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: message });
};
