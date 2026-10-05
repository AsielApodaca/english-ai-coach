/**
 * Next-question generation (spec 107) — split out of `continuous.ts` by
 * feature 117: the LLM prompt, its builder and the conversation context
 * summary that drives it. Mirrors `practice-generate.ts` for the first
 * question.
 */

import type { CompleteOptions } from "./providers/types.ts";
import { chatJSON } from "./providers/index.ts";
import type { Candidate, FirstQuestion } from "./practice.ts";
import type { Level, SessionV2 } from "./session/storage.ts";
import type { RigorLevel } from "./settings.ts";

// ---------------------------------------------------------------------------
// Conversation context summary
// ---------------------------------------------------------------------------

/**
 * Compact summary of the ongoing conversation passed to the LLM on every
 * `next-question` call (spec 107): the topic plus the last `maxExchanges`
 * question/answer pairs. The user's side of each exchange is the full-answer
 * attempt when present, otherwise the last fragment attempt.
 */
export function buildContextSummary(session: SessionV2, maxExchanges = 3): string {
  const lines: string[] = [`Topic: ${session.config.topicPrompt}`];
  for (const q of session.questions.slice(-maxExchanges)) {
    const userText =
      q.fullAttempt?.text ?? q.fragments.flatMap((f) => f.attempts).at(-1)?.text ?? "";
    lines.push(`Q: ${q.q}`);
    if (userText) lines.push(`A: ${userText}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Next-question generation
// ---------------------------------------------------------------------------

const SYSTEM_NEXT_QUESTION = `You are an expert English speaking coach for software engineers, using the call-and-repeat (shadowing) method.
The user defines the ROLE you must adopt for this practice session (see ROLE INSTRUCTION below). Adopt that role fully and run the session as that character.
You create the NEXT question of an ongoing practice session plus a model answer split into short spoken fragments. Each fragment must be a natural, short chunk (5 to 12 words). The complete answer must be 60 to 140 words total.
VOICES: the "question" is spoken by the ROLE character; the "fragments" are THE LEARNER's model answer — what a good student/interviewee would reply, in first person (I, my, we). Never put the role character's lines in the fragments: no greetings, no follow-up questions, no thanking or sign-off, no stage directions.
The user is a Spanish speaker; level tells you the target difficulty (A1 = very simple vocabulary and short sentences, C2 = near-native, rich and technical).
LANGUAGE RULE: every word you output — the question, the fragments and the context — MUST be in English. Never produce Spanish, even if the user's topic/role is described in Spanish. Vary the subtopic within the same topic in English and do NOT repeat a question already asked.
Use the learner memory block to personalize the answer: reuse words the user struggles with, reference recent topics if useful, and keep difficulty around the user's level.
Respond ONLY with strict JSON matching this schema (no markdown, no commentary):
{"question": string, "fragments": [{"id": string, "stage": string, "text": string}]}
- question: exactly ONE question from the role character (1-3 sentences), in English. Not a script: no greetings, no multiple questions, no closing remarks.
- fragments: the learner's own reply to that question, assembled in order, first person, directly answering it. Use exactly these allowed stages: Opening, Main point, Detail, Example, Closing.
- id: sequential like "f1", "f2"...`;

export interface NextQuestionParams {
  topicPrompt: string;
  level: Level;
  rigor: RigorLevel;
  learnerMemory: string;
  contextSummary: string;
}

/**
 * Generate the next question of a continuous session (spec 107). Mirrors
 * `generateFirstQuestion` (practice.ts): the role instruction becomes the
 * system persona, the conversation context + learner memory drive the prompt,
 * and the model answer is assembled from the spoken fragments.
 */
export async function generateNextQuestion(
  candidates: Candidate[],
  params: NextQuestionParams,
): Promise<{ question: FirstQuestion; provider: string }> {
  const system = `${SYSTEM_NEXT_QUESTION}\n\nROLE INSTRUCTION:\n${params.topicPrompt}`;
  const memoryLine = params.learnerMemory ? `\n\nLEARNER MEMORY:\n${params.learnerMemory}` : "";
  const contextLine = params.contextSummary ? `\n\nCONVERSATION CONTEXT:\n${params.contextSummary}` : "";
  const user = `Generate the next question of the session. Level: ${params.level}. Rigor: ${params.rigor}.${memoryLine}${contextLine}`;
  const options: CompleteOptions = { temperature: 0.7, maxTokens: 4096 };
  const res = await chatJSON<{ question?: unknown; fragments?: Array<{ id?: string; stage?: string; text?: string }> }>(
    candidates,
    { system, user, options },
  );
  const fragments = (res.data.fragments ?? [])
    .map((f, i) => ({ id: f.id || `f${i + 1}`, stage: f.stage ?? "", text: f.text ?? "" }))
    .filter((f) => f.text.trim().length > 0);
  const q = typeof res.data.question === "string" ? res.data.question.trim() : "";
  return {
    provider: res.provider,
    question: {
      q,
      answer: fragments.map((f) => f.text).join(" "),
      fragments,
    },
  };
}
