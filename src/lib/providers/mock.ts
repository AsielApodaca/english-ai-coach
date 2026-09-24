import type { ChatMessage, CompleteOptions, Provider } from "./types.ts";

// ---------------------------------------------------------------------------
// Mock LLM provider (MOCK_LLM=1)
//
// TEMPORARY testing aid: returns canned, deterministic JSON instantly so the
// practice audio pipeline (session/start → whisper capture → attempt) can be
// exercised end-to-end without waiting on a real model. The canned payload is
// chosen from the system prompt so every LLM call site gets a schema it can
// extract. Remove the provider (and the type union "mock") once testing is done.
// ---------------------------------------------------------------------------

interface MockFragment {
  id: string;
  stage: string;
  text: string;
}

const MOCK_FIRST_QUESTION = {
  question: "Tell me about a project you are currently working on.",
  fragments: [
    { id: "f1", stage: "Opening", text: "I am currently working on a project that improves our test coverage." },
    { id: "f2", stage: "Main point", text: "My main task is automating the end to end tests." },
    { id: "f3", stage: "Detail", text: "I use Playwright and the CI pipeline runs them daily." },
    { id: "f4", stage: "Example", text: "Last week I fixed a flaky test that failed randomly." },
    { id: "f5", stage: "Closing", text: "I am proud because the suite is now much more reliable." },
  ] satisfies MockFragment[],
};

const MOCK_PRACTICE_SET = {
  ...MOCK_FIRST_QUESTION,
  context: "Focus on linking words and keep a steady pace while repeating.",
};

const MOCK_TITLE = { title: "Mock practice session" };

const MOCK_EVALUATION = {
  issues: [],
  tips: ["Keep the same steady pace.", "Pause naturally between fragments."],
  naturalness: 95,
};

const MOCK_NEXT_STEP = {
  focus: "Keep repeating the fragment loop to build fluency.",
  topic: "Another question in the same category until you pass 3 fragments in a row.",
  why: "This is a deterministic mock reply used for offline testing.",
  targetLevel: "B2",
};

/** Pick a canned JSON payload matching the request's system prompt. */
function cannedFor(system: string): unknown {
  if (system.includes("Summarize the user's role instruction")) return MOCK_TITLE;
  if (system.includes("Evaluate only what was actually said")) return MOCK_EVALUATION;
  if (system.includes("next move to reach conversational fluency")) return MOCK_NEXT_STEP;
  if (system.includes("You create interview/practice answers")) return MOCK_PRACTICE_SET;
  // First- and next-question generation share the same schema.
  return MOCK_FIRST_QUESTION;
}

/** A provider that always succeeds and never touches the network. */
export function createMockProvider(): Provider {
  return {
    id: "mock",
    name: "Mock (offline, instant)",
    async available() {
      return true;
    },
    async complete(messages: ChatMessage[], _options?: CompleteOptions): Promise<string> {
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      return JSON.stringify(cannedFor(system));
    },
  };
}