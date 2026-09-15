import type { ChatMessage, CompleteOptions } from "./providers/types.ts";
import { chatJSON } from "./providers/index.ts";
import type { Candidate, Category, Level } from "./practice.ts";

const SYSTEM_TURN = `You are a friendly English speaking coach having a live spoken conversation with a Spanish-speaking software engineer.
Answer with CONTEXT: reference what the learner just said, and use follow-ups and clarifications like a human would.
Keep every reply short and speakable: 1-3 sentences, roughly 15-40 words. This is a turn of conversation, not an essay.
NEVER become a fragment evaluator unless the learner explicitly asks for feedback.
Only correct on the fly when there is a serious grammar or vocabulary error, and do it naturally and inline — e.g. "Just a note: we usually say ... instead of ...". Never list every mistake.
Learner memory: {learnerMemory}
Respond ONLY with strict JSON matching this schema (no markdown, no commentary):
{"reply": string, "correction": string|null}
- reply: what the coach actually speaks or prints.
- correction: a short inline fix phrase when a grave error was detected, otherwise null.`.replace(/\n\s+/g, "\n");

const SYSTEM_INTERVIEW_START = `You are a recruiter conducting a live mock {category} interview for a software engineer who is a Spanish speaker learning English at level {level}.
The interview is spoken, so keep the question natural and conversational, as a human recruiter would ask it.
Produce the FIRST question of a chained interview and decide the total number of questions (between 4 and 6).
Learner memory: {learnerMemory}
Respond ONLY with strict JSON matching this schema (no markdown, no commentary):
{"topic": string, "total": number, "question": string}
- topic: a short label for the interview topic.
- total: total number of questions in the interview (4-6).
- question: the first question, asked aloud.`.replace(/\n\s+/g, "\n");

const SYSTEM_INTERVIEW_TURN = `You are the interviewer in a live mock interview for a software engineer who is a Spanish speaker learning English at level {level}.
This is a spoken interview, so keep everything short and natural.
On this turn:
(a) Make a SHORT natural remark on the candidate's last answer (one sentence).
(b) If this is not the last question (index < total), ask the NEXT question, CHAINED from the previous answer — a follow-up that builds on what the candidate just said.
(c) If this is the last question (index >= total), give a brief wrap-up thanking the candidate and close the interview.
Learner memory: {learnerMemory}
Respond ONLY with strict JSON matching this schema (no markdown, no commentary):
{"reply": string, "nextQuestion": string|null, "done": boolean}
- reply: what the interviewer says aloud — the remark AND, when there is a next question, the follow-up question itself.
- nextQuestion: the follow-up question on its own (mirror of the question part of reply), or null when the interview is done.
- done: true only when this is the last question (index >= total).`.replace(/\n\s+/g, "\n");

const SYSTEM_INTERVIEW_SCORE = `You are an experienced English speaking coach evaluating a Spanish-speaking software engineer's performance in a live mock interview at level {level}.
Evaluate the overall spoken performance across the whole interview for fluency, grammar, vocabulary, and clarity.
Give a composite score and balanced feedback: what went well and what to improve.
Learner memory: {learnerMemory}
Respond ONLY with strict JSON matching this schema (no markdown, no commentary):
{"score": number, "strengths": [string], "improvements": [string]}
- score: 0-100 composite score.
- strengths: up to 3 short strengths.
- improvements: up to 3 short, actionable improvements.`.replace(/\n\s+/g, "\n");

/** Round and clamp a number to [min, max], falling back when it is not finite. */
function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Keep only string entries from an unknown array value, capped at `max`. */
function strings(value: unknown, max: number): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string").slice(0, max) : [];
}

/**
 * Serialize a conversation history into a single user prompt.
 *
 * `chatJSON` accepts one system prompt plus one user prompt, so the full
 * turn history (without any system message) is flattened into the user
 * message: `[{system}, {user: <serialized history>}]`.
 */
function serializeHistory(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.role === "user" ? "Learner" : "Coach"}: ${m.content}`).join("\n");
}

/**
 * One free-chat turn of the spoken conversation.
 *
 * The coach replies with context, follow-ups and inline corrections only for
 * grave errors. Falls back to a neutral local turn when the LLM chain fails.
 */
export async function conversationTurn(
  candidates: Candidate[],
  params: { messages: ChatMessage[]; learnerMemory: string },
): Promise<{ reply: string; correction: string | null; provider: string }> {
  const system = SYSTEM_TURN.replace("{learnerMemory}", params.learnerMemory);
  const options: CompleteOptions = { temperature: 0.7, maxTokens: 4096 };
  try {
    const res = await chatJSON<{ reply: string; correction: string | null }>(candidates, {
      system,
      user: serializeHistory(params.messages),
      options,
    });
    return {
      reply:
        typeof res.data.reply === "string" && res.data.reply.trim()
          ? res.data.reply
          : "Thanks — tell me a bit more about that so I can help you say it more naturally.",
      correction: typeof res.data.correction === "string" ? res.data.correction : null,
      provider: res.provider,
    };
  } catch {
    return {
      reply: "Thanks — tell me a bit more about that so I can help you say it more naturally.",
      correction: null,
      provider: "local",
    };
  }
}

/**
 * Start a chained mock interview: picks the topic, the total number of
 * questions (clamped to 4-6) and the first question. Falls back to a
 * deterministic opener when the LLM chain fails.
 */
export async function startInterview(
  candidates: Candidate[],
  params: { category: Category; level: Level; learnerMemory: string; topicHint?: string },
): Promise<{ topic: string; total: number; question: string; provider: string }> {
  const system = SYSTEM_INTERVIEW_START.replace("{category}", params.category)
    .replace("{level}", params.level)
    .replace("{learnerMemory}", params.learnerMemory);
  const hintLine = params.topicHint ? `\nTopic hint from the learner: ${params.topicHint}` : "";
  const user = `Start the interview. Category: ${params.category}. Level: ${params.level}.${hintLine}`;
  const options: CompleteOptions = { temperature: 0.7, maxTokens: 4096 };
  try {
    const res = await chatJSON<{ topic: string; total: number; question: string }>(candidates, {
      system,
      user,
      options,
    });
    return {
      topic: typeof res.data.topic === "string" ? res.data.topic : "",
      total: clampInt(res.data.total, 4, 6, 5),
      question: typeof res.data.question === "string" ? res.data.question : "",
      provider: res.provider,
    };
  } catch {
    return {
      topic: `Job interview — ${params.category}`,
      total: 5,
      question: "Tell me about yourself and your background as a software developer.",
      provider: "local",
    };
  }
}

/**
 * One interviewer turn: a short remark on the candidate's last answer plus
 * either the next chained question (done:false) or a wrap-up (done:true).
 * Falls back to a deterministic closing turn when the LLM chain fails.
 */
export async function interviewTurn(
  candidates: Candidate[],
  params: { messages: ChatMessage[]; learnerMemory: string; category: string; level: string; index: number; total: number },
): Promise<{ reply: string; nextQuestion: string | null; done: boolean; provider: string }> {
  const system = SYSTEM_INTERVIEW_TURN.replace("{level}", params.level).replace("{learnerMemory}", params.learnerMemory);
  const user = `Interview category: ${params.category}. Question ${params.index + 1} of ${params.total}.\nConversation so far:\n${serializeHistory(params.messages)}`;
  const options: CompleteOptions = { temperature: 0.7, maxTokens: 4096 };
  try {
    const res = await chatJSON<{ reply: string; nextQuestion: string | null; done: boolean }>(candidates, {
      system,
      user,
      options,
    });
    return {
      reply: typeof res.data.reply === "string" ? res.data.reply : "",
      nextQuestion: typeof res.data.nextQuestion === "string" ? res.data.nextQuestion : null,
      done: res.data.done === true,
      provider: res.provider,
    };
  } catch {
    return {
      reply: "Got it — good answer. Let's move to the next question.",
      nextQuestion: null,
      done: true,
      provider: "local",
    };
  }
}

/**
 * Score a whole interview transcript: composite 0-100 score plus balanced
 * strengths/improvements (max 3 each). Falls back to a deterministic score
 * when the LLM chain fails.
 */
export async function interviewScore(
  candidates: Candidate[],
  params: { transcript: string; learnerMemory: string; level: string },
): Promise<{ score: number; strengths: string[]; improvements: string[]; provider: string }> {
  const system = SYSTEM_INTERVIEW_SCORE.replace("{level}", params.level).replace("{learnerMemory}", params.learnerMemory);
  const user = `Interview transcript:\n${params.transcript}`;
  const options: CompleteOptions = { temperature: 0.3, maxTokens: 4096 };
  try {
    const res = await chatJSON<{ score: number; strengths: string[]; improvements: string[] }>(candidates, {
      system,
      user,
      options,
    });
    return {
      score: clampInt(res.data.score, 0, 100, 70),
      strengths: strings(res.data.strengths, 3),
      improvements: strings(res.data.improvements, 3),
      provider: res.provider,
    };
  } catch {
    return {
      score: 70,
      strengths: ["You completed the interview and kept the conversation going."],
      improvements: ["Expanding your answers with one more reason or example would strengthen them."],
      provider: "local",
    };
  }
}