/**
 * Provider-chain resolution shared by the route modules (feature 117).
 *
 * Several endpoints (`practice/new`, `evaluate`, `attempt`, `session/save`,
 * `session/start`, `next-step`, `chat`, `lookup`) need the ordered LLM
 * candidate list; it lives here so the routes stay declarative and the chain
 * logic has ONE home instead of a copy per file (and no import cycle between
 * `app.ts` and the route modules).
 *
 * Contracts:
 *   candidates(chain, providerRequested?)      : Candidate[] — primary first
 *   lookupCandidates(chain)                    : Candidate[] — popup chain
 *
 * `ProviderChain` is the subset of `AppDeps` (app.ts) these functions read;
 * AppDeps satisfies it structurally.
 */

import { providerById } from "../providers/index.ts";
import type { Provider, ProviderId } from "../providers/types.ts";
import { isProviderId } from "../providers/types.ts";
import type { Candidate } from "../practice.ts";

/** Provider registry + configured primary (structurally satisfied by AppDeps). */
export interface ProviderChain {
  providers: Provider[];
  primaryProviderId: ProviderId;
}

/**
 * Ordered LLM candidates, primary first for fallback (feature 117).
 *
 * `providerRequested` comes from the client body and is untrusted: an unknown
 * id (or a non-string) falls back to `primaryProviderId` — the old code cast
 * it `as ProviderId` blindly, which made `providerById` miss and reordered the
 * chain to the registry default.
 */
export function candidates(chain: ProviderChain, providerRequested?: string): Candidate[] {
  const primary: ProviderId = isProviderId(providerRequested) ? providerRequested : chain.primaryProviderId;
  const viaId = providerById(chain.providers, primary);
  // Mock LLM (MOCK_LLM=1) always leads the chain so every practice call
  // short-circuits instantly, regardless of any requested provider.
  const mock = chain.providers.filter((p) => p.id === "mock");
  if (mock.length > 0) return [...mock, ...chain.providers.filter((p) => p.id !== "mock")];
  return [...(viaId ? [viaId] : []), ...chain.providers.filter((p) => p.id !== primary)];
}

/** Lookup chain: mock excluded (popup must use real LLM), fast local model first. */
export function lookupCandidates(chain: ProviderChain): Candidate[] {
  const cands = candidates(chain).filter((c) => c.id !== "mock");
  const fast = cands.filter((c) => c.id === "ollama-fast");
  return [...fast, ...cands.filter((c) => c.id !== "ollama-fast")];
}
