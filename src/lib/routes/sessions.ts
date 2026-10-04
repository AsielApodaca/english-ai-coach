/**
 * Session listing, deletion, export and history routes (features 109/CU3).
 *
 * Route contracts (JSDoc blocks moved verbatim from server.ts in feature 117):
 *   GET    /api/sessions           — listing (+ ?group=recency sidebar payload)
 *   DELETE /api/sessions/:id       — delete one session
 *   DELETE /api/sessions           — wipe the whole history
 *   GET    /api/sessions/:id/export — full JSON of one session
 *   GET    /api/history            — flat list for the history view
 *
 * Split out of `routes/session.ts` (feature 117): the lifecycle endpoints
 * (save/start/checkpoint/…) and the collection endpoints are different
 * domains, together they would exceed the 300-line module limit.
 */

import type { Express } from "express";

import { groupSessionsByRecency, sessionScore } from "../storage.ts";
import type { AppDeps } from "../app.ts";

/**
 * Register the session collection + history routes.
 *
 * @param app - Express instance under construction (createApp)
 * @param deps - injected dependencies (storage, …)
 */
export function registerSessionListRoutes(app: Express, deps: AppDeps): void {
  /**
   * GET /api/sessions — session history listing (feature 109).
   *
   * `?group=recency` returns the sidebar payload:
   *   { groups: [{ label: "Today"|"Yesterday"|"Previous 7 Days"|"Older", items: SessionSummary[] }] }
   * grouped by `updatedAt` (local calendar days) with empty groups omitted.
   * Without the query param it returns the flat summary list. Summaries are
   * light: title/level/provider/status/updatedAt/score/progress — never the
   * topicPrompt or question bodies (NFR: cheap listing).
   */
  app.get("/api/sessions", (req, res) => {
    const summaries = deps.storage.listSessionSummaries();
    if (req.query.group === "recency") {
      const groups = groupSessionsByRecency(summaries)
        .map((g) => ({ label: g.label, items: g.sessions }))
        .filter((g) => g.items.length > 0);
      return res.json({ groups });
    }
    res.json({ sessions: summaries });
  });

  /**
   * DELETE /api/sessions/:id — delete a session file (feature 109).
   * Also removes the session's extracted-context bucket. 404 when missing.
   */
  app.delete("/api/sessions/:id", (req, res) => {
    const deleted = deps.storage.deleteSession(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Session not found." });
    res.json({ ok: true });
  });

  /**
   * DELETE /api/sessions — wipe the whole session history (settings "Borrar
   * historial"). Deletes every session file plus its extracted-context bucket.
   * The learner profile is left untouched. Returns { ok, deleted }.
   */
  app.delete("/api/sessions", (_req, res) => {
    const ids = deps.storage.listSessionSummaries().map((s) => s.id);
    let deleted = 0;
    for (const id of ids) {
      if (deps.storage.deleteSession(id)) deleted++;
    }
    res.json({ ok: true, deleted });
  });

  /**
   * GET /api/sessions/:id/export — full JSON of a single session (feature 109,
   * low-profile export next to the profile export of 108). 404 when missing.
   */
  app.get("/api/sessions/:id/export", (req, res) => {
    const session = deps.storage.loadSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found." });
    res.json(session);
  });

  /**
   * GET /api/history — flat session list for the history view (CU3).
   *
   * No input. 200 → { sessions: [{ id, date, category, level, question, title,
   *   status, avgScore, nextStep }] }
   *   date      — session updatedAt; question — first question (title fallback);
   *   avgScore  — rounded mean of the session's fragment scores, null when the
   *               session has no attempts (same formula as sessionScore);
   *   nextStep  — the profile's current suggestion (same value on every row).
   * Bodies stay light: no topicPrompt, no fragments (cheap listing NFR).
   * Errors: none in the happy path; unexpected storage failures → 500 { error }.
   */
  app.get("/api/history", (_req, res) => {
    const sessions = deps.storage.loadAllSessions();
    const profile = deps.storage.loadProfile();
    res.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        date: s.updatedAt,
        category: s.config.category,
        level: s.config.level,
        question: s.questions[0]?.q ?? s.title,
        title: s.title,
        status: s.status,
        avgScore: sessionScore(s),
        nextStep: profile.nextStep,
      })),
    });
  });
}
