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

test("check syntax-checks src and public through a find sweep", () => {
  // The frontend is plain JS (outside tsconfig), so `node --check` is its ONLY
  // gate: a file the script does not reach ships unchecked (review finding,
  // feature 117). Feature 118 replaced the ~60 explicit `node --check <path>`
  // entries — a list that had to be re-edited on every file move and silently
  // fell behind — with a `find` sweep over `src` + `public`. This test pins
  // that sweep: it fails if the sweep is removed, narrowed to a single root
  // (leaving the other tree unchecked) or dropped from `node --check`.
  const check = pkg.scripts.check;
  assert.match(
    check,
    /find src public/,
    "`check` must sweep both `src` and `public` (`find src public`)",
  );
  assert.match(
    check,
    /-name '\*\.ts'/,
    "`find` must include `*.ts` so backend sources are syntax-checked",
  );
  assert.match(
    check,
    /-name '\*\.js'/,
    "`find` must include `*.js` so frontend files are syntax-checked",
  );
  assert.match(
    check,
    /\\\( -name '\*\.ts' -o -name '\*\.js' \\\)/,
    "the two `-name` patterns must be grouped (`\\( … \\)`) so `-o` precedence " +
      "cannot silently drop one of the trees from the sweep",
  );
  assert.match(
    check,
    /-print0 \| xargs -0 .*node --check/,
    "the sweep must pipe into `node --check` (NUL-separated, one file per run)",
  );
});
