/**
 * Practice-set and first-question generation (features 001/103/107).
 *
 * Split out of `practice.ts` by feature 117: the two LLM prompts, their
 * builders and the two `chatJSON` calls behind `generatePracticeSet` and
 * `generateFirstQuestion`. Pure text/LLM work — no scoring here.
 */

import type { CompleteOptions, JsonSchema } from "../providers/types.ts";
import { chatJSON } from "../providers/index.ts";
import type { Candidate, Category, Level, PracticeFragment, PracticeSet } from "./practice.ts";

export const CATEGORY_STAGES: Record<Category, string> = {
  interviews: "Opening, Situation, Task, Action, Result, Closing",
  star: "Situation, Task, Action, Result, Closing",
  daily: "Greeting, Status update, Blockers, Next steps",
  free: "Part 1, Part 2, Part 3, Part 4, Part 5",
};

/** Stages allowed in a generated model answer (first and next question). */
const QUESTION_STAGES = ["Opening", "Main point", "Detail", "Example", "Closing"];

/**
 * Fewest usable fragments a generated model answer may carry. The prompts ask
 * for five stages, so anything below this is a broken reply (typically the
 * collapsed-JSON symptom: every array item folded into one object) rather than
 * a legitimately short answer.
 */
export const MIN_QUESTION_FRAGMENTS = 3;

/** Fewest fragments a practice set may carry (`/api/practice/new`). */
export const MIN_PRACTICE_FRAGMENTS = 2;

/**
 * Quality bar every generated model answer must clear (recruiter-lens review).
 * Shared by the three generation prompts so they can never drift apart:
 * a direct first sentence (BLUF), one or two hard numbers when the answer
 * reports results, a last sentence tied to the role, and no interview
 * clichés — the pattern behind every strong interview answer.
 */
export const ANSWER_RULES = `ANSWER RULES:
- The first sentence is the direct answer (BLUF): never open with filler ("That's a great question", "Let me think").
- When the question involves results, impact or failure, include 1-2 concrete numbers (%, time, count): "cut release time by 20%", never "improved quality a lot".
- The last sentence connects the answer to what the role or team needs (skip it only for routine status questions).
- No interview clichés: never "perfectionist", "team player", "hard worker", "go-getter". For weakness questions give a real weakness, its mitigation and its evidence — never a fake strength.`;

const SYSTEM_GENERATE = `You are an expert English speaking coach for software engineers, using the call-and-repeat (shadowing) method.
You create interview/practice answers split into short spoken fragments. Each fragment must be a natural, short chunk (5 to 12 words); repeat a stage when the answer needs more than five chunks. The complete answer must be A1-A2: 40-70 words, B1-B2: 60-90 words, C1-C2: 80-120 words — take the low end of the range for short factual questions (definitions, status, preferences) and the high end for story or behavioral questions ("Tell me about a time...").
The user is a Spanish speaker; level tells you the target difficulty (A1 = very simple vocabulary and short sentences, C2 = near-native, rich and technical).
LANGUAGE RULE: every word you output — the question, the fragments and the context — MUST be in English. Never produce Spanish, even if the user's topic/role is described in Spanish.
Use the learner memory block to personalize the answer: reuse words the user struggles with, reference recent topics if useful, and keep difficulty around the user's level.
${ANSWER_RULES}
Respond ONLY with strict JSON matching this schema (no markdown, no commentary):
{"question": string, "context": string, "fragments": [{"id": string, "stage": string, "text": string}]}
- question: the question the coach asks aloud, exactly ONE question, in English. Ask like a real interviewer: a behavioral question asks for a specific past situation ("Tell me about a time..."), never a hypothetical or a compound question.
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
  const res = await chatJSON<PracticeSet>(candidates, {
    system,
    user,
    options,
    schema: practiceSetSchema(params.category),
    validate: validatePracticeSet,
  });
  const fragments = (res.data.fragments ?? []).map((f, i) => ({ id: f.id || `f${i + 1}`, stage: f.stage, text: f.text }));
  return {
    provider: res.provider,
    set: {
      question: res.data.question,
      context: res.data.context,
      fragments,
    },
  };
}

/**
 * JSON Schema of the practice-set reply sent to providers that support
 * structured outputs (Ollama). The `stage` enum is derived from the category,
 * so the model can only emit stages the practice flow understands.
 */
function practiceSetSchema(category: Category): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      question: { type: "string" },
      context: { type: "string" },
      fragments: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            stage: { type: "string", enum: CATEGORY_STAGES[category].split(", ") },
            text: { type: "string" },
          },
          required: ["id", "stage", "text"],
        },
      },
    },
    required: ["question", "context", "fragments"],
  };
}

/**
 * Reject a practice set that cannot be practiced: no question or too few
 * usable fragments. Thrown from `chatJSON`'s `validate`, so the call is
 * retried instead of returning a broken set to the UI.
 */
function validatePracticeSet(data: PracticeSet): void {
  if (typeof data.question !== "string" || data.question.trim().length === 0) {
    throw new Error("Practice set has an empty question.");
  }
  const usable = (Array.isArray(data.fragments) ? data.fragments : []).filter(
    (f) => f && typeof f.text === "string" && f.text.trim().length > 0,
  );
  if (usable.length < MIN_PRACTICE_FRAGMENTS) {
    throw new Error(`Practice set has ${usable.length} usable fragments (minimum ${MIN_PRACTICE_FRAGMENTS}).`);
  }
}

// ---------------------------------------------------------------------------
// First question generation (feature 103 / CU1)
// ---------------------------------------------------------------------------

const SYSTEM_FIRST_QUESTION = `You are an expert English speaking coach for software engineers, using the call-and-repeat (shadowing) method.
The user defines the ROLE you must adopt for this practice session (see ROLE INSTRUCTION below). Adopt that role fully and run the session as that character.
You create the FIRST question of the session plus a model answer split into short spoken fragments. Each fragment must be a natural, short chunk (5 to 12 words); repeat a stage when the answer needs more than five chunks. The complete answer must be A1-A2: 40-70 words, B1-B2: 60-90 words, C1-C2: 80-120 words — take the low end of the range for short factual questions (definitions, status, preferences) and the high end for story or behavioral questions ("Tell me about a time...").
VOICES: the "question" is spoken by the ROLE character; the "fragments" are THE LEARNER's model answer — what a good student/interviewee would reply, in first person (I, my, we). Never put the role character's lines in the fragments: no greetings, no follow-up questions, no thanking or sign-off, no stage directions.
The user is a Spanish speaker; level tells you the target difficulty (A1 = very simple vocabulary and short sentences, C2 = near-native, rich and technical).
LANGUAGE RULE: every word you output — the question, the fragments and the context — MUST be in English. Never produce Spanish, even if the user's topic/role is described in Spanish.
Use the learner memory block to personalize the answer: reuse words the user struggles with, reference recent topics if useful, and keep difficulty around the user's level.
${ANSWER_RULES}
Respond ONLY with strict JSON matching this schema (no markdown, no commentary):
{"question": string, "fragments": [{"id": string, "stage": string, "text": string}]}
- question: exactly ONE question from the role character (1-3 sentences), in English. Not a script: no greetings, no multiple questions, no closing remarks. Ask like a real interviewer: a behavioral question asks for a specific past situation ("Tell me about a time..."), never a hypothetical or a compound question.
- fragments: the learner's own reply to that question, assembled in order, first person, directly answering it. Use exactly these allowed stages: Opening, Main point, Detail, Example, Closing.
- id: sequential like "f1", "f2"...
Example of a valid reply:
{"question":"Tell me about a challenge you overcame in your last project.","fragments":[{"id":"f1","stage":"Opening","text":"I fixed a checkout bug that was failing 3% of our orders."},{"id":"f2","stage":"Main point","text":"We were losing about $4k a month to failed payments."},{"id":"f3","stage":"Detail","text":"I traced it to a race condition in our retry queue."},{"id":"f4","stage":"Detail","text":"The fix was a lock plus an idempotency key."},{"id":"f5","stage":"Example","text":"After the fix, failures dropped from 3% to 0.5% in two weeks."},{"id":"f6","stage":"Closing","text":"Reliable checkout is exactly what this role needs."}]}`;

/** The first question of a session: the coach's question + the model answer. */
export interface FirstQuestion {
  q: string;
  answer: string;
  fragments: PracticeFragment[];
}

/** Parsed (untrusted) shape of a question reply before normalization. */
export interface QuestionReply {
  question?: unknown;
  fragments?: Array<{ id?: unknown; stage?: unknown; text?: unknown }>;
}

/**
 * JSON Schema of the question reply, sent to providers that support
 * structured outputs (Ollama constrains sampling to it, so the reply is
 * guaranteed to be well-formed JSON with one object per fragment — the local
 * model otherwise drops the `}{` separator between array items and folds every
 * fragment into a single object).
 */
export const QUESTION_REPLY_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    question: { type: "string" },
    fragments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          stage: { type: "string", enum: QUESTION_STAGES },
          text: { type: "string" },
        },
        required: ["id", "stage", "text"],
      },
    },
  },
  required: ["question", "fragments"],
};

/**
 * Validate a parsed question reply and normalize it into a `FirstQuestion`.
 *
 * Throws when the reply is degenerate — an empty/absent question or fewer than
 * `MIN_QUESTION_FRAGMENTS` usable fragments — which is exactly what a
 * structurally broken reply looks like after parsing. Callers pass this as
 * `chatJSON`'s `validate`, so a bad reply is retried instead of persisted:
 * feature 103 promises that no session is created when generation fails.
 *
 * @param data - parsed, not yet trusted reply
 * @returns the question with its model answer assembled from the fragments
 */
export function toFirstQuestion(data: QuestionReply): FirstQuestion {
  const q = typeof data.question === "string" ? data.question.trim() : "";
  if (q.length === 0) throw new Error("Question reply has an empty question.");
  const fragments = (Array.isArray(data.fragments) ? data.fragments : [])
    .map((f, i) => ({
      id: (typeof f?.id === "string" && f.id) || `f${i + 1}`,
      stage: typeof f?.stage === "string" ? f.stage : "",
      text: typeof f?.text === "string" ? f.text : "",
    }))
    .filter((f) => f.text.trim().length > 0);
  if (fragments.length < MIN_QUESTION_FRAGMENTS) {
    throw new Error(`Question reply has ${fragments.length} usable fragments (minimum ${MIN_QUESTION_FRAGMENTS}).`);
  }
  return { q, answer: fragments.map((f) => f.text).join(" "), fragments };
}

/**
 * Generate the first question of a session from the user's role instruction
 * (feature 103). The role instruction becomes the system persona; the topic
 * prompt, level, learner memory and optional DOCUMENT CONTEXT block drive the
 * generation. The model answer is assembled from the spoken fragments.
 *
 * The reply is schema-constrained where supported and shape-checked before it
 * is returned; an unusable reply makes `chatJSON` retry and eventually throw,
 * so the caller creates no session from garbage (feature 104 regression: a
 * collapsed fragments array used to persist a one-fragment "answer").
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
  const res = await chatJSON<QuestionReply>(candidates, {
    system,
    user,
    options,
    schema: QUESTION_REPLY_SCHEMA,
    validate: (data) => {
      toFirstQuestion(data);
    },
  });
  return { provider: res.provider, question: toFirstQuestion(res.data) };
}
