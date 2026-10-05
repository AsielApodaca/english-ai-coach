/**
 * `POST /api/files/extract` handler (feature 104) — split out of
 * `extract.ts` by feature 117 so it can be unit-tested without HTTP.
 *
 * Multipart decision: Express 5 ships no multipart parser and adding one would
 * violate the zero-dependency rule (only pdf-parse + mammoth are allowed), so
 * the endpoint accepts a JSON body with the file content base64-encoded.
 */

import {
  DEFAULT_CONTEXT_BUCKET,
  extractFile,
  type ContextStorage,
  type ExtractLimits,
} from "./extract-parse.ts";

// ---------------------------------------------------------------------------
// Endpoint handler (testable without HTTP)
// ---------------------------------------------------------------------------

export interface ExtractResponse {
  status: number;
  json: Record<string, unknown>;
}

/**
 * Handle a `POST /api/files/extract` request body and return the HTTP response.
 *
 * Multipart decision: Express 5 ships no multipart parser and adding one would
 * violate the zero-dependency rule (only pdf-parse + mammoth are allowed), so
 * the endpoint accepts a JSON body with the file content base64-encoded:
 *   { name: string, data: string (base64), sessionId?: string }
 * The frontend reads the dropped file with FileReader.readAsDataURL() and sends
 * the base64 payload; the server decodes, validates extension + size, extracts
 * text, sanitizes it and persists the text under
 * `data/tmp/context/<sessionId|draft>/`. Errors are returned as `{ error }`.
 */
export async function handleExtractRequest(
  storage: ContextStorage,
  body: unknown,
  limits?: Partial<ExtractLimits>,
): Promise<ExtractResponse> {
  const { name, data, sessionId } = (body ?? {}) as Record<string, unknown>;
  if (typeof name !== "string" || name.trim().length === 0) {
    return { status: 400, json: { error: "name is required." } };
  }
  if (typeof data !== "string" || data.length === 0) {
    return { status: 400, json: { error: "data (base64-encoded file content) is required." } };
  }
  const buffer = Buffer.from(data, "base64");
  if (buffer.length === 0) {
    return { status: 400, json: { error: "File is empty." } };
  }
  try {
    const file = await extractFile(name, buffer, limits);
    const bucket = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : DEFAULT_CONTEXT_BUCKET;
    const textRef = storage.saveContextText(bucket, file, file.text);
    return {
      status: 200,
      json: {
        file: { name: file.name, size: file.size, kind: file.kind, textRef },
        text: file.text,
        chars: file.text.length,
        truncated: file.truncated,
      },
    };
  } catch (err) {
    return { status: 400, json: { error: (err as Error).message } };
  }
}
