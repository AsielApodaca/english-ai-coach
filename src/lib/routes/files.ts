/**
 * Context-file extraction route (feature 104).
 *
 * Route contract (JSDoc block moved verbatim from server.ts in feature 117):
 *   POST /api/files/extract — extract text from a dropped context file.
 */

import type { Express } from "express";

import { handleExtractRequest } from "../ingest/extract.ts";
import type { AppDeps } from "../app.ts";

/**
 * Register `POST /api/files/extract`.
 *
 * @param app - Express instance under construction (createApp)
 * @param deps - injected dependencies (storage, rootDir, env, …)
 */
export function registerFilesRoutes(app: Express, deps: AppDeps): void {
  /**
   * POST /api/files/extract — extract text from a context file (feature 104).
   *
   * Multipart decision: Express 5 ships no multipart parser and adding one would
   * violate the zero-dependency rule (only pdf-parse + mammoth are allowed), so
   * this endpoint accepts a JSON body with the file content base64-encoded:
   *   { name: string, data: string (base64), sessionId?: string }
   * The frontend reads the dropped file with FileReader.readAsDataURL() and sends
   * the base64 payload. The server decodes, validates extension + size, extracts
   * text (TXT/MD direct, PDF via pdf-parse, DOCX via mammoth), sanitizes it and
   * persists the text under data/tmp/context/<sessionId|draft>/. The original
   * file is never sent anywhere external. Errors are returned as { error }.
   */
  app.post("/api/files/extract", async (req, res) => {
    const { status, json } = await handleExtractRequest(deps.storage, req.body);
    res.status(status).json(json);
  });
}
