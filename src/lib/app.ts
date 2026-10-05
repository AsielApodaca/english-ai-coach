/**
 * Application factory (feature 117).
 *
 * `createApp(deps)` builds the whole HTTP surface from explicit dependencies,
 * so the real routes can be exercised over an ephemeral port with fake
 * singletons (tests) — the pattern the pure handlers already used
 * (`SessionStartDeps`), applied at app level. Importing this module has NO
 * side effects: no port, no warmup, no file writes — everything happens when
 * `createApp` is called (and the boot warm only when `warmupEnabled(env)`).
 *
 * Contracts:
 *   AppDeps            — { storage, providers, primaryProviderId, ttsCache,
 *                          refinements, lookupCache, rootDir, env }
 *   createApp(deps)    — Express app with JSON/static middleware, every /api
 *                        route registered, and the global error contracts
 *                        (apiNotFound → apiErrorHandler, registered LAST so
 *                        they only see unmatched routes and uncaught
 *                        exceptions — see lib/http-errors.ts).
 *
 * `src/server.ts` is the only caller in production: env → createApp → listen.
 */

import express, { type Express } from "express";
import { join } from "node:path";

import { apiErrorHandler, apiNotFound } from "./http-errors.ts";
import type { createStorage } from "./session/storage.ts";
import type { createTtsCache } from "./audio/tts-cache.ts";
import type { createRefinementRegistry } from "./practice/refinement.ts";
import type { createLookupCache } from "./lookup/lookup.ts";
import type { Provider, ProviderId } from "./providers/types.ts";

import { registerHealthRoutes } from "./routes/health.ts";
import { registerPracticeRoutes } from "./routes/practice.ts";
import { registerAttemptRoutes } from "./routes/attempt.ts";
import { registerSessionRoutes } from "./routes/session.ts";
import { registerSessionListRoutes } from "./routes/sessions.ts";
import { registerProfileRoutes } from "./routes/profile.ts";
import { registerAudioRoutes } from "./routes/audio.ts";
import { registerChatRoutes } from "./routes/chat.ts";
import { registerLookupRoutes } from "./routes/lookup.ts";
import { registerFilesRoutes } from "./routes/files.ts";

/** Dependencies `createApp` needs to build every route (feature 117). */
export interface AppDeps {
  /** JSON persistence for data/profile.json + data/sessions/*.json (storage.ts). */
  storage: ReturnType<typeof createStorage>;
  /** Provider registry, ordered as `buildProviders(env)` produced it. */
  providers: Provider[];
  /** Provider that leads the chain when the client does not request one. */
  primaryProviderId: ProviderId;
  /** Synthesis cache behind GET /api/tts (tts-cache.ts). */
  ttsCache: ReturnType<typeof createTtsCache>;
  /** In-memory registry of background refinements (refinement.ts). */
  refinements: ReturnType<typeof createRefinementRegistry>;
  /** LRU cache behind GET /api/lookup (lookup.ts). */
  lookupCache: ReturnType<typeof createLookupCache>;
  /** Project root: public/, models/ and data/ live under it. */
  rootDir: string;
  /** Process environment — read inside createApp/routes, never at module scope. */
  env: NodeJS.ProcessEnv;
}

/**
 * Build the Express application.
 *
 * Registration order matches the original server.ts layout (middleware first,
 * then routes, then the global /api error contracts). No route path is
 * registered twice and no pattern shadows another, so the file split cannot
 * change routing behaviour.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json({ limit: "25mb" }));
  app.use(express.static(join(deps.rootDir, "public")));

  registerHealthRoutes(app, deps);
  registerPracticeRoutes(app, deps);
  registerAttemptRoutes(app, deps);
  registerSessionRoutes(app, deps);
  registerSessionListRoutes(app, deps);
  registerProfileRoutes(app, deps);
  registerAudioRoutes(app, deps);
  registerChatRoutes(app, deps);
  registerLookupRoutes(app, deps);
  registerFilesRoutes(app, deps);

  // Global /api error contracts (feature 117): registered AFTER every /api
  // route, so `apiNotFound` only sees routes that fell through (404 { error })
  // and `apiErrorHandler` only sees exceptions nobody caught — including the
  // malformed-JSON body-parse error of express.json(). Both answer JSON, never
  // Express' HTML page. See src/lib/http-errors.ts for the shape rule.
  app.use("/api", apiNotFound);
  app.use("/api", apiErrorHandler);

  return app;
}
