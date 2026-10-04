import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Type gate (feature 117): `npm run check` is the project's quality gate
// (AGENTS.md: "el gate de calidad es npm run check + npm test"). Before 117
// it only ran `node --check` (syntax), so type errors accumulated silently
// (9 of them). This test pins the gate itself: it fails if `tsc --noEmit` is
// ever removed from (or demoted in) the `check` script of package.json.
// ---------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

test("check script runs the TypeScript type gate (tsc --noEmit)", () => {
  const check = pkg.scripts.check;
  assert.ok(typeof check === "string", "package.json must define a `check` script");
  assert.match(check, /tsc --noEmit/, "`check` must include `tsc --noEmit`");
});

test("check script runs tsc before the syntax checks", () => {
  const check = pkg.scripts.check;
  const tscAt = check.indexOf("tsc --noEmit");
  const syntaxAt = check.indexOf("node --check");
  assert.ok(tscAt >= 0, "`check` must include `tsc --noEmit`");
  assert.ok(syntaxAt >= 0, "`check` must keep the `node --check` syntax checks");
  assert.ok(
    tscAt < syntaxAt,
    "`tsc --noEmit` must run first so type errors surface before syntax checks",
  );
});

/** Every .js file under `public/`, as a repo-relative POSIX path. */
function listPublicJs(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listPublicJs(full);
    return entry.isFile() && entry.name.endsWith(".js")
      ? [relative(repoRoot, full).split("\\").join("/")]
      : [];
  });
}

test("check syntax-checks every frontend JS file (frontend has no tsc)", () => {
  // The frontend is plain JS (outside tsconfig), so `node --check` is its ONLY
  // gate: a file missing from the script ships unchecked (review finding,
  // feature 117). Backend TS is covered by tsc --noEmit above.
  const check = pkg.scripts.check;
  for (const file of listPublicJs(join(repoRoot, "public"))) {
    assert.ok(
      check.includes(`node --check ${file}`),
      `check must syntax-check ${file} — frontend JS has no other gate`,
    );
  }
});
