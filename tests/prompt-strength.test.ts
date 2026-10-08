import { test } from "node:test";
import assert from "node:assert/strict";

import type { Candidate } from "../src/lib/practice/practice.ts";
import { ANSWER_RULES, generatePracticeSet, generateFirstQuestion } from "../src/lib/practice/practice-generate.ts";
import { generateNextQuestion } from "../src/lib/practice/continuous-generate.ts";
import { evaluateFragment } from "../src/lib/practice/practice-eval.ts";
import { buildNextStep } from "../src/lib/practice/learner.ts";
import type { Profile } from "../src/lib/session/storage.ts";

// ---------------------------------------------------------------------------
// Recruiter-lens prompt rules (branch feat/prompt-model-answer-strength): the
// three generation prompts must carry the shared ANSWER_RULES block, the
// level-based word ranges (the old flat "60 to 140 words" is gone) and the
// interviewer-style question rule. If any of these drift, the model answers
// regress to vague, filler-first, one-size-fits-all replies.
// ---------------------------------------------------------------------------

/** Fake candidate that records every system prompt it is asked to complete. */
function capturingCandidate(systems: string[], reply: string): Candidate {
  return {
    id: "amber" as never,
    async available() {
      return true;
    },
    async complete(messages: unknown[]) {
      const list = messages as Array<{ role: string; content: string }>;
      systems.push(list.find((m) => m.role === "system")?.content ?? "");
      return reply;
    },
  };
}

const VALID_SET = `{"question":"Tell me about a time you improved a process.","context":"Use STAR.","fragments":[{"id":"f1","stage":"Situation","text":"Our deploy process took a full afternoon."},{"id":"f2","stage":"Action","text":"I automated it with a single script."}]}`;

const VALID_QUESTION = `{"question":"Tell me about a challenge you overcame.","fragments":[{"id":"f1","stage":"Opening","text":"We hit a blocker in week one."},{"id":"f2","stage":"Main point","text":"I split the work and we shipped early."},{"id":"f3","stage":"Closing","text":"That cut our cycle time by 20%."}]}`;

function assertAnswerRules(system: string, label: string): void {
  assert.ok(system.includes("ANSWER RULES"), `${label} must carry the shared answer rules`);
  assert.ok(system.includes("BLUF"), `${label} must require a direct first sentence`);
  assert.ok(system.includes("concrete numbers"), `${label} must require quantitative evidence`);
  assert.ok(system.includes("never \"perfectionist\""), `${label} must ban interview clichés`);
  assert.ok(!system.includes("60 to 140"), `${label} must not use the old flat word range`);
}

test("practice-set prompt: answer rules, level ranges and interviewer-style question", async () => {
  const systems: string[] = [];
  const candidate = capturingCandidate(systems, VALID_SET);
  await generatePracticeSet([candidate], { category: "interviews", level: "B2", learnerMemory: "" });

  assert.equal(systems.length, 1);
  const system = systems[0];
  assertAnswerRules(system, "practice-set prompt");
  assert.ok(system.includes("A1-A2: 40-70 words"), "level-based word range must be explicit");
  assert.ok(system.includes("B1-B2: 60-90 words"), "level-based word range must be explicit");
  assert.ok(system.includes("C1-C2: 80-120 words"), "level-based word range must be explicit");
  assert.ok(system.includes("Tell me about a time"), "questions must be behavioral, not hypothetical");
  assert.ok(system.includes("You create interview/practice answers"), "MOCK_LLM key phrase must survive");
});

test("first-question prompt: answer rules, updated example and interviewer-style question", async () => {
  const systems: string[] = [];
  const candidate = capturingCandidate(systems, VALID_QUESTION);
  await generateFirstQuestion([candidate], { topicPrompt: "Act as a hiring manager", level: "B2", learnerMemory: "" });

  assert.equal(systems.length, 1);
  const system = systems[0];
  assertAnswerRules(system, "first-question prompt");
  assert.ok(system.includes("A1-A2: 40-70 words"), "level-based word range must be explicit");
  assert.ok(system.includes("ROLE INSTRUCTION"), "the role persona must stay in the system prompt");
  assert.ok(system.includes("Ask like a real interviewer"), "the question rule must be present");
  // The few-shot example must model the rules: hard numbers + a fit close.
  assert.ok(system.includes("3% to 0.5%"), "the example must show a measurable outcome");
  assert.ok(system.includes("what this role needs"), "the example must close with a fit line");
  assert.ok(!system.includes("our releases became stable again"), "the vague old example must be gone");
});

test("next-question prompt: answer rules and interviewer-style question", async () => {
  const systems: string[] = [];
  const candidate = capturingCandidate(systems, VALID_QUESTION);
  await generateNextQuestion([candidate], {
    topicPrompt: "Act as a hiring manager",
    level: "B2",
    rigor: "Balanceado",
    learnerMemory: "",
    contextSummary: "Topic: interview\nQ: Tell me about yourself\nA: I am a backend engineer.",
  });

  assert.equal(systems.length, 1);
  const system = systems[0];
  assertAnswerRules(system, "next-question prompt");
  assert.ok(system.includes("A1-A2: 40-70 words"), "level-based word range must be explicit");
  assert.ok(system.includes("Ask like a real interviewer"), "the question rule must be present");
  assert.ok(system.includes("ROLE INSTRUCTION"), "the role persona must stay in the system prompt");
});

test("ANSWER_RULES block: BLUF, quantified evidence, fit close and no clichés", () => {
  assertAnswerRules(ANSWER_RULES, "ANSWER_RULES");
  assert.ok(ANSWER_RULES.includes("last sentence connects"), "the fit close must be required");
  assert.ok(ANSWER_RULES.includes("never a fake strength"), "weakness answers must be real");
});

// --- Profession-neutral prompts --------------------------------------------
// The coach serves any working professional, not only software engineers:
// no system prompt may hardcode a profession (it would bias every generated
// question, evaluation and next step toward one discipline).

const VALID_EVAL = `{"issues":[],"tips":["Keep the same steady pace."],"naturalness":90}`;
const VALID_NEXT_STEP = `{"focus":"past-tense narrative fluency","topic":"Tell me about a project you are proud of.","why":"Recent answers avoid past tense.","targetLevel":"B2"}`;

const PROFILE_NEUTRAL: Profile = {
  level: "B2",
  categories: {},
  weakErrors: {},
  vocabGaps: [],
  recentTopics: [],
};

test("evaluation prompt: no hardcoded profession", async () => {
  const systems: string[] = [];
  const candidate = capturingCandidate(systems, VALID_EVAL);
  await evaluateFragment([candidate], { target: "We shipped two days early.", userText: "We shipped two days early", question: "q", level: "B2" });

  assert.equal(systems.length, 1);
  assert.ok(!systems[0].includes("software engineer"), "the evaluation prompt must not assume a profession");
  assert.ok(systems[0].includes("Spanish-speaking professional"), "the evaluation prompt addresses any professional");
});

test("next-step prompt: no hardcoded profession", async () => {
  const systems: string[] = [];
  const candidate = capturingCandidate(systems, VALID_NEXT_STEP);
  await buildNextStep([candidate], PROFILE_NEUTRAL, []);

  assert.equal(systems.length, 1);
  assert.ok(!systems[0].includes("software engineer"), "the next-step prompt must not assume a profession");
  assert.ok(systems[0].includes("professional life"), "the next-step prompt addresses any profession");
  assert.ok(!systems[0].includes("standup concision"), "examples must stay profession-neutral");
});

test("generation prompts: no hardcoded profession", async () => {
  const systems: string[] = [];
  const setCandidate = capturingCandidate(systems, VALID_SET);
  await generatePracticeSet([setCandidate], { category: "interviews", level: "B2", learnerMemory: "" });
  const firstCandidate = capturingCandidate(systems, VALID_QUESTION);
  await generateFirstQuestion([firstCandidate], { topicPrompt: "Act as a hiring manager", level: "B2", learnerMemory: "" });
  const nextCandidate = capturingCandidate(systems, VALID_QUESTION);
  await generateNextQuestion([nextCandidate], {
    topicPrompt: "Act as a hiring manager",
    level: "B2",
    rigor: "Balanceado",
    learnerMemory: "",
    contextSummary: "Topic: interview\nQ: Tell me about yourself\nA: I am a project manager.",
  });

  assert.equal(systems.length, 3);
  for (const [i, system] of systems.entries()) {
    assert.ok(!system.includes("software engineer"), `prompt ${i + 1} must not assume a profession`);
    assert.ok(system.includes("working professionals"), `prompt ${i + 1} must address any profession`);
  }
});
