import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ipaToRespell, approxRespell, respellFor } from "../public/ui/ipa.js";

const ipaGlyphs = /[æɑɒɔəɛɜɪʃʊʌʒːθðŋɡ]/;

test("ipaToRespell: readable syllables with stress caps (approved format)", () => {
  assert.equal(ipaToRespell("/ˈwɜːrkɪŋ/"), "WUR·king");
  assert.equal(ipaToRespell("/ˈprɒdʒɛkt/"), "PRAH·jehkt");
  assert.equal(ipaToRespell("/ɪmˈpruːvz/"), "ihm·PROOVZ");
  assert.equal(ipaToRespell("/ˈjuːʒuəli/"), "YOO·zhuh·lee");
  assert.equal(ipaToRespell("/ˌɔːrɡənəˈzeɪʃənz/"), "or·guh·nuh·ZAY·shuhnz");
  // Function words stay lowercase and readable.
  assert.equal(ipaToRespell("/ðə/"), "thuh");
  assert.equal(ipaToRespell("/ənd/"), "uhnd");
  // Unstressed single-syllable words get no stress caps.
  assert.equal(ipaToRespell("/wɜːrk/"), "wurk");
});

test("respellFor: dictionary words resolve with accurate flag", () => {
  assert.deepEqual(respellFor("working"), { text: "WUR·king", approximate: false });
  assert.deepEqual(respellFor("project"), { text: "PRAH·jehkt", approximate: false });
  assert.deepEqual(respellFor("improves"), { text: "ihm·PROOVZ", approximate: false });
  // Normalization: case and surrounding punctuation still resolve to the dict.
  assert.deepEqual(respellFor("Working,"), { text: "WUR·king", approximate: false });
});

test("respellFor: out-of-dictionary words fall back to approximate (~-flagged)", () => {
  const r = respellFor("coverage");
  assert.ok(r);
  assert.equal(r.approximate, true);
  assert.match(r.text, /^[a-z·]+$/); // readable lowercase letters only, no IPA glyphs
  // Deterministic: same input, same output.
  assert.equal(respellFor("coverage")?.text, r.text);
});

test("respellFor: non-alphabetic input yields no annotation", () => {
  assert.equal(respellFor("123"), null);
  assert.equal(respellFor("..."), null);
});

test("approxRespell: deterministic letter→sound guesses", () => {
  assert.equal(approxRespell("coverage"), "kov·ehrij");
  assert.equal(approxRespell("sprint"), "sprihnt");
  assert.equal(approxRespell(""), null);
  assert.equal(approxRespell("123"), null);
});

test("ipaToRespell: covers the whole shipped dictionary without raw IPA leaks", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../public/ui/ipa.js"), "utf8");
  const values = [...src.matchAll(/\/([^/]{1,24})\//g)]
    .map((m) => m[1])
    .filter((v) => ipaGlyphs.test(v))
    .filter((v) => /^[ˌˈa-zæɑɒɔəɛɜɪʃʊʌʒθðŋɡː]+$/.test(v));
  assert.ok(values.length > 1000, "expected a populated dictionary");
  for (const ipa of values) {
    const out = ipaToRespell(ipa);
    assert.ok(out.length > 0, `empty respelling for ${ipa}`);
    assert.doesNotMatch(out, ipaGlyphs, `raw IPA leaked into respelling of ${ipa}`);
  }
});