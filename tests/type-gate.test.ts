import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
