/**
 * Practice-set and first-question generation (features 001/103/107).
 *
 * Split out of `practice.ts` by feature 117: the two LLM prompts, their
 * builders and the two `chatJSON` calls behind `generatePracticeSet` and
 * `generateFirstQuestion`. Pure text/LLM work — no scoring here.
 */

import type { CompleteOptions } from "./providers/types.ts";
import { chatJSON } from "./providers/index.ts";
import type { Candidate, Category, Level, PracticeFragment, PracticeSet } from "./practice.ts";

export const CATEGORY_STAGES: Record<Category, string> = {
  interviews: "Opening, Situation, Task, Action, Result, Closing",
  star: "Situation, Task, Action, Result, Closing",
  daily: "Greeting, Status update, Blockers, Next steps",
  free: "Part 1, Part 2, Part 3, Part 4, Part 5",
};

const SYSTEM_GENERATE = `You are an expert English speaking coach for software engineers, using the call-and-repeat (shadowing) method.
You create interview/practice answers split into short spoken fragments. Each fragment must be a natural, short chunk (5 to 12 words). The complete answer must be 60 to 140 words total.
The user is a Spanish speaker; level tells you the target difficulty (A1 = very simple vocabulary and short sentences, C2 = near-native, rich and technical).
LANGUAGE RULE: every word you output — the question, the fragments and the context — MUST be in English. Never produce Spanish, even if the user's topic/role is described in Spanish.
Use the learner memory block to personalize the answer: reuse words the user struggles with, reference recent topics if useful, and keep difficulty around the user's level.
Respond ONLY with strict JSON matching this schema (no markdown, no commentary):
{"question": string, "context": string, "fragments": [{"id": string, "stage": string, "text": string}]}
- question: the question the coach asks aloud, exactly ONE question, in English.
- context: a short coaching note (what to focus on while repeating this answer), in English.
- fragments: consecutive chunks that assemble into the full spoken answer (the LEARNER's model reply, first person — never the coach's or interviewer's lines), ordered. Use exactly these allowed stages: {stages}.
- id: sequential like "f1", "f2"...`.replace(/\n\s+/g, "\n");

function generatePrompt(category: Category, level: Level, learnerMemory: string, personalized: boolean): { system: string; user: string } {
  const system = SYSTEM_GENERATE.replace("{stages}", CATEGORY_STAGES[category]);
  const memoryLine = learnerMemory ? `\n\nLEARNER MEMORY:\n${learnerMemory}` : "";
  const personalizeLine = personalized
    ? "\nPersonalize the answer to reinforce the user's weak points listed in the learner memory (use those structures/words naturally, don't over-strong them)."
    : "";
  const user = `Generate a practice set. Category: ${category}. Level: ${level}.${memoryLine}${personalizeLine}`;
  return { system, user };
}

export async function generatePracticeSet(
  candidates: Candidate[],
  params: { category: Category; level: Level; learnerMemory: string; personalized?: boolean },
): Promise<{ set: PracticeSet; provider: string }> {
  const { system, user } = generatePrompt(params.category, params.level, params.learnerMemory, params.personalized ?? false);
  const options: CompleteOptions = { temperature: 0.7, maxTokens: 4096 };
  const res = await chatJSON<PracticeSet>(candidates, { system, user, options });
  const fragments = res.data.fragments ?? [];
  return {
    provider: res.provider,
    set: {
      question: res.data.question,
      context: res.data.context,
      fragments: fragments.map((f, i) => ({ id: f.id || `f${i + 1}`, stage: f.stage, text: f.text })),
    },
  };
}

// ---------------------------------------------------------------------------
// First question generation (feature 103 / CU1)
// ---------------------------------------------------------------------------

const SYSTEM_FIRST_QUESTION = `You are an expert English speaking coach for software engineers, using the call-and-repeat (shadowing) method.
The user defines the ROLE you must adopt for this practice session (see ROLE INSTRUCTION below). Adopt that role fully and run the session as that character.
You create the FIRST question of the session plus a model answer split into short spoken fragments. Each fragment must be a natural, short chunk (5 to 12 words). The complete answer must be 60 to 140 words total.
VOICES: the "question" is spoken by the ROLE character; the "fragments" are THE LEARNER's model answer — what a good student/interviewee would reply, in first person (I, my, we). Never put the role character's lines in the fragments: no greetings, no follow-up questions, no thanking or sign-off, no stage directions.
The user is a Spanish speaker; level tells you the target difficulty (A1 = very simple vocabulary and short sentences, C2 = near-native, rich and technical).
LANGUAGE RULE: every word you output — the question, the fragments and the context — MUST be in English. Never produce Spanish, even if the user's topic/role is described in Spanish.
Use the learner memory block to personalize the answer: reuse words the user struggles with, reference recent topics if useful, and keep difficulty around the user's level.
Respond ONLY with strict JSON matching this schema (no markdown, no commentary):
{"question": string, "fragments": [{"id": string, "stage": string, "text": string}]}
- question: exactly ONE question from the role character (1-3 sentences), in English. Not a script: no greetings, no multiple questions, no closing remarks.
- fragments: the learner's own reply to that question, assembled in order, first person, directly answering it. Use exactly these allowed stages: Opening, Main point, Detail, Example, Closing.
- id: sequential like "f1", "f2"...
Example of a valid reply:
{"question":"Tell me about a challenge you overcame in your last project.","fragments":[{"id":"f1","stage":"Opening","text":"In my last project we hit a problem with flaky tests."},{"id":"f2","stage":"Main point","text":"CI failed almost every night for a week."},{"id":"f3","stage":"Detail","text":"I found an outdated fixture that broke the suite."},{"id":"f4","stage":"Example","text":"After the fix, our releases became stable again."},{"id":"f5","stage":"Closing","text":"That lesson taught me to keep test data up to date."}]}`;

/** The first question of a session: the coach's question + the model answer. */
export interface FirstQuestion {
  q: string;
  answer: string;
  fragments: PracticeFragment[];
}

/**
 * Generate the first question of a session from the user's role instruction
 * (feature 103). The role instruction becomes the system persona; the topic
 * prompt, level, learner memory and optional DOCUMENT CONTEXT block drive the
 * generation. The model answer is assembled from the spoken fragments.
 */
export async function generateFirstQuestion(
  candidates: Candidate[],
  params: { topicPrompt: string; level: Level; learnerMemory: string; documentContext?: string },
): Promise<{ question: FirstQuestion; provider: string }> {
  const system = `${SYSTEM_FIRST_QUESTION}\n\nROLE INSTRUCTION:\n${params.topicPrompt}`;
  const memoryLine = params.learnerMemory ? `\n\nLEARNER MEMORY:\n${params.learnerMemory}` : "";
  const docLine = params.documentContext ? `\n\n${params.documentContext}` : "";
  const user = `Generate the first question of the session. Level: ${params.level}.${memoryLine}${docLine}`;
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
