/**
 * Profile persistence (features 103/108) — split out of `storage.ts` by
 * feature 117. `data/profile.json` is read defensively (a corrupt file starts
 * fresh with the documented defaults) and written atomically.
 */

import { existsSync, readFileSync } from "node:fs";

import { writeJSONAtomic } from "./json-file.ts";
import { normalizeLevel, type Profile } from "./session-types.ts";

export function readProfileFile(profilePath: string): Profile {
  try {
    if (existsSync(profilePath)) {
      const parsed = JSON.parse(readFileSync(profilePath, "utf8")) as Partial<Profile>;
      return {
        level: normalizeLevel(parsed.level),
        categories: parsed.categories ?? {},
        weakErrors: parsed.weakErrors ?? {},
        vocabGaps: parsed.vocabGaps ?? [],
        recentTopics: parsed.recentTopics ?? [],
        ...(parsed.focusPhonemes ? { focusPhonemes: parsed.focusPhonemes } : {}),
        ...(parsed.lastSessionAt ? { lastSessionAt: parsed.lastSessionAt } : {}),
        ...(parsed.nextStep ? { nextStep: parsed.nextStep } : {}),
        ...(parsed.settings ? { settings: parsed.settings } : {}),
      };
    }
  } catch {
    // corrupt profile -> start fresh
  }
  return { level: "B1", categories: {}, weakErrors: {}, vocabGaps: [], recentTopics: [] };
}

export function writeProfileFile(profilePath: string, profile: Profile): void {
  writeJSONAtomic(profilePath, profile);
}
