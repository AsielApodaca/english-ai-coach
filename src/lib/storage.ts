import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface SessionAttempt {
  text: string;
  score: number;
  missing: string[];
  extra: string[];
  issues: FeedbackIssue[];
  verdict: "great" | "almost" | "retry";
}

export interface FeedbackIssue {
  category: "grammar" | "word-choice" | "fluency" | "pronunciation" | "other";
  message: string;
  fix?: string;
}

export interface SessionFragment {
  id: string;
  stage: string;
  text: string;
  attempts: SessionAttempt[];
  passed: boolean;
}

/** One spoken/text turn of a free conversation, as persisted in a session. */
export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

export interface Session {
  id: string;
  date: string;
  category: string;
  level: string;
  provider: string;
  question: string;
  context: string;
  fragments: SessionFragment[];
  turns?: ConversationTurn[];
  fullAnswer?: {
    text: string;
    score?: number;
    feedback?: string;
  };
  nextStep?: NextStep;
}

export interface NextStep {
  focus: string;
  topic: string;
  why: string;
  targetLevel: string;
  generatedAt: string;
}

export interface Profile {
  level: string;
  categories: Record<string, CategoryStats>;
  weakErrors: Record<string, number>;
  vocabGaps: string[];
  recentTopics: string[];
  lastSessionAt?: string;
  nextStep?: NextStep;
}

export interface CategoryStats {
  sessions: number;
  avgScore: number;
  lastScore?: number;
  trend: number[];
}

interface Storage {
  dataDir: string;
  profilePath: string;
  sessionsDir: string;
  tmpDir: string;
}

function mkdirp(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Write file atomically: temp file + rename. */
function writeJSONAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, file);
}

export function createStorage(baseDir: string): Storage & {
  loadProfile(): Profile;
  saveProfile(profile: Profile): void;
  listSessions(): Session[];
  loadSession(id: string): Session | undefined;
  saveSession(session: Session): void;
  loadAllSessions(): Session[];
} {
  const dataDir = join(baseDir, "data");
  const profilePath = join(dataDir, "profile.json");
  const sessionsDir = join(dataDir, "sessions");
  const tmpDir = join(dataDir, "tmp");
  mkdirp(sessionsDir);
  mkdirp(tmpDir);

  const storage: Storage = { dataDir, profilePath, sessionsDir, tmpDir };

  return {
    ...storage,
    loadProfile(): Profile {
      try {
        if (existsSync(profilePath)) {
          return JSON.parse(readFileSync(profilePath, "utf8")) as Profile;
        }
      } catch {
        // corrupt profile -> start fresh
      }
      return { level: "B1", categories: {}, weakErrors: {}, vocabGaps: [], recentTopics: [] };
    },
    saveProfile(profile: Profile): void {
      writeJSONAtomic(profilePath, profile);
    },
    listSessions(): Session[] {
      if (!existsSync(sessionsDir)) return [];
      return readdirSync(sessionsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          try {
            return JSON.parse(readFileSync(join(sessionsDir, f), "utf8")) as Session;
          } catch {
            return null;
          }
        })
        .filter((s): s is Session => s !== null)
        .sort((a, b) => a.date.localeCompare(b.date));
    },
    loadSession(id: string): Session | undefined {
      const file = join(sessionsDir, `${id}.json`);
      if (!existsSync(file)) return undefined;
      try {
        return JSON.parse(readFileSync(file, "utf8")) as Session;
      } catch {
        return undefined;
      }
    },
    saveSession(session: Session): void {
      writeJSONAtomic(join(sessionsDir, `${session.id}.json`), session);
    },
    loadAllSessions(): Session[] {
      return this.listSessions();
    },
  };
}