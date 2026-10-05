/**
 * Free-form coach chat route (feature 003).
 *
 * Route contract (JSDoc block moved verbatim from server.ts in feature 117):
 *   POST /api/chat — LLM chat with the learner memory always injected.
 */

import type { Express } from "express";

import { completeWithFallback } from "../providers/index.ts";
import { PROVIDER_IDS, isProviderId, type ChatMessage } from "../providers/types.ts";
import { buildLearnerMemory } from "../practice/learner.ts";
import { candidates } from "./chain.ts";
import type { AppDeps } from "../app.ts";

/** Hard cap on a chat message (feature 117): the JSON body limit is 25 MB. */
export const CHAT_MAX_CHARS = 4000;

/**
 * Register `POST /api/chat`.
 *
 * @param app - Express instance under construction (createApp)
 * @param deps - injected dependencies (storage, providers, …)
 */
export function registerChatRoutes(app: Express, deps: AppDeps): void {
  /**
   * POST /api/chat — free-form coach chat over the LLM (feature 003).
   *
   * Body: { message: string, provider? }
   *   message — non-empty user text, at most CHAT_MAX_CHARS (4000) characters;
   *   provider — preferred LLM id; absent/null keeps the default chain, any
   *   other unknown value is rejected (feature 117).
   * The learner memory (profile + sessions) is always injected as the system
   *   context — the chat never runs without it (AGENTS.md rule).
   * 200 → { reply: string, provider: ProviderId }.
   * 200 → { reply: string, provider: "local", offline: true } when every provider
   *   failed: a canned fallback (email-phrasing aware) keeps the conversation
   *   usable offline — deliberately a 200, the client renders it as-is.
   * 400 { error } → message missing/empty, message longer than CHAT_MAX_CHARS,
   *   or an unknown provider id.
   */
  app.post("/api/chat", async (req, res) => {
    const { message, provider: providerReq } = req.body ?? {};
    if (typeof message !== "string" || message.trim().length === 0) {
      return res.status(400).json({ error: "message is required." });
    }
    if (message.length > CHAT_MAX_CHARS) {
      return res.status(400).json({ error: `message exceeds ${CHAT_MAX_CHARS} characters.` });
    }
    if (providerReq !== undefined && providerReq !== null && !isProviderId(providerReq)) {
      return res.status(400).json({ error: `Unknown provider. Expected one of: ${PROVIDER_IDS.join(", ")}.` });
    }
    const profile = deps.storage.loadProfile();
    const sessions = deps.storage.loadAllSessions();
    const memory = buildLearnerMemory(profile, sessions);
    const messages: ChatMessage[] = [
      { role: "system", content: `You are a friendly English speaking coach. Answer in plain English. Keep it helpful and concise.\nLearner memory: ${memory}` },
      { role: "user", content: message },
    ];
    try {
      const result = await completeWithFallback(candidates(deps, providerReq), messages, { maxTokens: 4096 });
      res.json({ reply: result.text, provider: result.provider });
    } catch (err) {
      const mail = /^\S+@\S+\.\S+$/.test(message.trim());
      const fallback = mail
        ? "Got it. Try: \"I'm writing to ask about…\" or \"Would it be possible to…?\" — phrase requests as questions for a more professional tone."
        : "Here's a cleaner way to say it. You can ask me to correct any specific phrase you're unsure about.";
      res.json({ reply: fallback, provider: "local", offline: true });
    }
  });
}
