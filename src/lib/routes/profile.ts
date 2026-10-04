/**
 * Profile, settings, storage-report and export routes (features 108/CU3).
 *
 * Route contracts (JSDoc blocks moved verbatim from server.ts in feature 117):
 *   GET  /api/profile         — profile + computed stats
 *   POST /api/profile/settings — persist profile-persisted settings
 *   GET  /api/storage         — local storage usage report
 *   GET  /api/export          — full local data export
 */

import type { Express } from "express";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { computeStats } from "../learner.ts";
import { applyProfileSettings, parseProfileSettings } from "../settings.ts";
import type { AppDeps } from "../app.ts";

/**
 * Register the profile/settings/export routes.
 *
 * @param app - Express instance under construction (createApp)
 * @param deps - injected dependencies (storage, …)
 */
export function registerProfileRoutes(app: Express, deps: AppDeps): void {
  /**
   * GET /api/profile — learner profile plus computed stats (features 108 / CU3).
   *
   * No input. 200 → { profile: Profile, stats }
   *   stats = { sessions, avg, byCategory, weakErrorsTop, vocabGaps,
   *             recentTopics, trend }
   *   trend — last 30 fragment scores across all sessions, oldest→newest, for
   *   the progress chart. Read-only: nothing is persisted here.
   * Errors: unexpected storage failure → 500 { error } (global middleware).
   */
  app.get("/api/profile", async (_req, res) => {
    const profile = deps.storage.loadProfile();
    const sessions = deps.storage.loadAllSessions();
    const stats = computeStats(profile, sessions);
    res.json({
      profile,
      stats: {
        sessions: stats.sessions,
        avg: stats.avg,
        byCategory: stats.byCategory,
        weakErrorsTop: stats.weakErrorsTop,
        vocabGaps: stats.vocabGaps,
        recentTopics: stats.recentTopics,
        trend: sessions.flatMap((s) => s.questions.flatMap((q) => q.fragments.flatMap((f) => f.attempts.map((a) => a.score)))).slice(-30),
      },
    });
  });

  /**
   * POST /api/profile/settings — persist the profile-persisted settings
   * (feature 108): rigor, fillers, adaptive, provider, personaName,
   * targetLevel, bio, prompt, focusPhonemes. Device prefs stay in localStorage
   * and never reach this endpoint. Idempotent: missing fields keep their
   * previous profile values. Returns the updated profile.
   */
  app.post("/api/profile/settings", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseProfileSettings(body);
    const profile = deps.storage.loadProfile();
    const updated = applyProfileSettings(profile, parsed);
    deps.storage.saveProfile(updated);
    res.json({ profile: updated });
  });

  /**
   * GET /api/storage — local storage usage report (feature 108 settings panel):
   * profile size, session count and total bytes under `data/`.
   */
  app.get("/api/storage", (_req, res) => {
    let sessionsCount = 0;
    let sessionsBytes = 0;
    try {
      for (const f of readdirSync(deps.storage.sessionsDir)) {
        if (!f.endsWith(".json")) continue;
        sessionsCount++;
        sessionsBytes += statSync(join(deps.storage.sessionsDir, f)).size;
      }
    } catch {
      // sessions dir may not exist yet — report zeros
    }
    let profileBytes = 0;
    try {
      profileBytes = statSync(deps.storage.profilePath).size;
    } catch {
      // no profile yet
    }
    res.json({
      dataDir: deps.storage.dataDir,
      profileBytes,
      sessionsCount,
      sessionsBytes,
      totalBytes: profileBytes + sessionsBytes,
    });
  });

  /**
   * GET /api/export — full local data export (feature 108): profile + all
   * sessions as JSON, stamped with the export time.
   */
  app.get("/api/export", (_req, res) => {
    res.json({
      exportedAt: new Date().toISOString(),
      profile: deps.storage.loadProfile(),
      sessions: deps.storage.loadAllSessions(),
    });
  });
}
