/**
 * Text normalization and word-level matching (features 001/105/116).
 *
 * Split out of `practice.ts` by feature 117: everything that turns two
 * strings into comparable tokens and a lexical score. No LLM, no I/O — these
 * are the functions the aligners (align-words, align-text) build on.
 *
 * The `WordMatch` contract is declared FIRST on purpose: `npm run check` runs
 * `node --check` on every file, and Node only strips types when it detects the
 * module as ESM — that detection must see an export BEFORE any TS-only syntax,
 * otherwise the very first type annotation is reported as a syntax error.
 */

/** Result of comparing a target fragment with what the learner actually said. */
export interface WordMatch {
  /** 0-100: (target words said − non-filler added words) over the target length. */
  score: number;
  matched: string[];
  missing: string[];
  extra: string[];
}

/** Cardinal words for 0-19 (index = value). */
const CARDINAL_ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];

/** Tens words for 20, 30 … 90 (index = tens digit, 0 and 1 unused). */
const CARDINAL_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** Multiplier words per group of three digits (index = group, 10^(3·index)). */
const SCALES = ["", "thousand", "million", "billion", "trillion"];

/** Ordinal form of every word an integer expansion can end on, so
 * `integerToWords(n, ordinal)` can ordinate the last word
 * ("twenty one" → "twenty first", "one thousand" → "one thousandth"). */
const ORDINAL_BY_WORD: Record<string, string> = {
  zero: "zeroth", one: "first", two: "second", three: "third", four: "fourth",
  five: "fifth", six: "sixth", seven: "seventh", eight: "eighth", nine: "ninth",
  ten: "tenth", eleven: "eleventh", twelve: "twelfth", thirteen: "thirteenth",
  fourteen: "fourteenth", fifteen: "fifteenth", sixteenth: "sixteenth",
  seventeen: "seventeenth", eighteenth: "eighteenth", nineteenth: "nineteenth",
  twenty: "twentieth", thirty: "thirtieth", forty: "fortieth", fifty: "fiftieth",
  sixty: "sixtieth", seventy: "seventieth", eighty: "eightieth", ninety: "ninetieth",
  hundred: "hundredth", thousand: "thousandth", million: "millionth",
  billion: "billionth", trillion: "trillionth",
};

/** Digits long enough that we keep them verbatim instead of guessing words
 * (e.g. ids or timestamps: both sides of the comparison keep the literal). */
const MAX_EXPAND_DIGITS = 15;

/**
 * Spell out an integer 0-999 in English.
 *
 * @param n value in [0, 999]
 */
function underThousandToWords(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) {
    parts.push(CARDINAL_ONES[hundreds], "hundred");
  }
  if (rest > 0 || hundreds === 0) {
    if (rest < 20) {
      parts.push(CARDINAL_ONES[rest]);
    } else {
      const tens = Math.floor(rest / 10);
      const ones = rest % 10;
      parts.push(ones === 0 ? CARDINAL_TENS[tens] : `${CARDINAL_TENS[tens]} ${CARDINAL_ONES[ones]}`);
    }
  }
  return parts.join(" ");
}

/**
 * Spell out a non-negative integer in English (up to 999,999,999,999,999).
 *
 * @param n value
 * @param ordinal when true the least significant word becomes an ordinal
 *   ("21" → "twenty first", "1000" → "one thousandth")
 */
function integerToWords(n: number, ordinal: boolean): string {
  if (n === 0) return ordinal ? "zeroth" : "zero";
  const groups: number[] = [];
  let rest = n;
  while (rest > 0) {
    groups.push(rest % 1000);
    rest = Math.floor(rest / 1000);
  }
  if (groups.length > SCALES.length) return "";
  const words: string[] = [];
  for (let g = groups.length - 1; g >= 0; g--) {
    const value = groups[g];
    if (value === 0) continue;
    words.push(underThousandToWords(value));
    if (SCALES[g]) words.push(SCALES[g]);
  }
  if (!ordinal) return words.join(" ");
  // Ordinate the final WORD of the phrase ("twenty one" → "twenty first",
  // "one thousand" → "one thousandth"): the last part may hold several words.
  const lastWords = words[words.length - 1].split(" ");
  const last = lastWords[lastWords.length - 1];
  lastWords[lastWords.length - 1] = ORDINAL_BY_WORD[last] ?? last;
  words[words.length - 1] = lastWords.join(" ");
  return words.join(" ");
}

/**
 * Convert one numeric token to its English words, or null when the token is
 * not a number we can spell out (kept verbatim so both sides still match).
 *
 * Accepts ordinals (`21st`, `2nd`), integers with thousands separators
 * (`2,000`) and decimals (`3.5` → "three point five").
 */
function numberTokenToWords(token: string): string | null {
  const ordinal = /^(\d{1,3}(?:,\d{3})+|\d+)(st|nd|rd|th)$/.exec(token);
  if (ordinal) {
    const digits = ordinal[1].replace(/,/g, "");
    if (digits.length > MAX_EXPAND_DIGITS) return null;
    const words = integerToWords(Number(digits), true);
    return words.length > 0 ? words : null;
  }
  const plain = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/.exec(token);
  if (!plain) return null;
  const digits = plain[1].replace(/,/g, "");
  if (digits.length > MAX_EXPAND_DIGITS) return null;
  const whole = integerToWords(Number(digits), false);
  if (!whole) return null;
  const fraction = plain[2];
  if (!fraction) return whole;
  const fractionWords = [...fraction].map((d) => CARDINAL_ONES[Number(d)]).join(" ");
  return `${whole} point ${fractionWords}`;
}

/** Numeric token: ordinal (with optional thousands separators), integer with
 * thousands separators, integer or decimal — bounded so digits glued to
 * letters (`covid19`) never match. */
const NUMBER_TOKEN_RE =
  /(?<![\p{L}\p{N}_])(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:st|nd|rd|th)|(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?![\p{L}\p{N}_])/gu;

/** Currency word per symbol: [plural, singular] (`$1` → "one dollar"). */
const CURRENCY_BY_SYMBOL: Record<string, readonly [plural: string, singular: string]> = {
  $: ["dollars", "dollar"],
  "€": ["euros", "euro"],
  "£": ["pounds", "pound"],
};

/** Value symbol → the words a reader would say, so a symbol written by the
 * LLM/whisper compares equal to the spoken form:
 *   `40%` ≡ `forty percent`, `$50` ≡ `fifty dollars`, `R&D` ≡ `r and d`.
 * Runs BEFORE `expandNumbers` so the digits a symbol carries are still there
 * to be spelled out. */
function canonicalizeSymbols(text: string): string {
  const currencyWord = (symbol: string, amount: string): string => {
    const words = CURRENCY_BY_SYMBOL[symbol];
    if (!words) return symbol;
    const isSingular = Number(amount.replace(/[.,]/g, "")) === 1;
    return isSingular ? words[1] : words[0];
  };
  return text
    .replace(/([$€£])(\d+(?:[.,]\d+)?)/g, (_m, symbol: string, amount: string) => `${amount} ${currencyWord(symbol, amount)}`)
    .replace(/(\d+(?:[.,]\d+)?)([$€£])/g, (_m, amount: string, symbol: string) => `${amount} ${currencyWord(symbol, amount)}`)
    .replace(/&/g, " and ")
    .replace(/%/g, " percent ");
}

/**
 * Rewrite numeric tokens as English words so digits and spelled-out numbers
 * compare equal: whisper transcribes "two hundred" as `200`, while the LLM
 * fragment says it in words — without this both sides tokenized differently
 * and the attempt scored the words as missing plus `200` as extra.
 *
 * Non-numeric tokens are untouched (`covid19`, `3D` keep their digits because
 * the match must start at a word boundary), and tokens too long to spell out
 * safely (ids) are kept verbatim — the same literal on both sides still
 * matches.
 */
export function expandNumbers(text: string): string {
  return text.replace(NUMBER_TOKEN_RE, (token) => numberTokenToWords(token) ?? token);
}

/** Normalize text for word-level comparison.
 * Hyphens become separators so "end-to-end" ≡ "end to end" ≡ "end - to - end"
 * (whisper and the LLM disagree on hyphenation), and lone "-" tokens drop out.
 * Bracketed whisper annotations ([BLANK_AUDIO], [MUSIC], …) are not speech
 * and are removed entirely. Value symbols and numbers become English words
 * (see `canonicalizeSymbols` / `expandNumbers`) before punctuation is
 * stripped, so decimals keep their `point` and `40%` keeps its `percent`. */
export function normalize(text: string): string {
  return expandNumbers(
    canonicalizeSymbols(
      text
        .replace(/\[[^\]]*\]/g, " ")
        .toLowerCase(),
    ),
  )
    .replace(/\bwon't\b/g, "will not")
    .replace(/\bcan't\b/g, "cannot")
    .replace(/\b[a-z]+'ve\b/g, (m) => m.replace("'ve", " have"))
    .replace(/\b[a-z]+'re\b/g, (m) => m.replace("'re", " are"))
    .replace(/\b[a-z]+'ll\b/g, (m) => m.replace("'ll", " will"))
    .replace(/\b[a-z]+'d\b/g, (m) => m.replace("'d", " would"))
    .replace(/\b[a-z]+'m\b/g, (m) => m.replace("'m", " am"))
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text: string): string[] {
  return normalize(text).split(" ").filter(Boolean);
}

/** True when a transcription carries no intelligible speech: empty text or
 * only whisper annotations such as [BLANK_AUDIO] (silence submitted as audio). */
export function isBlankTranscript(text: string): boolean {
  return tokenize(text).length === 0;
}

/** Hesitation/filler tokens that never penalize an attempt score. */
const FILLER_WORDS = new Set(["uh", "uhh", "um", "umm", "er", "erm", "ah", "eh", "hm", "hmm", "mmm", "mhm"]);

/** True when a normalized token is a pure hesitation/filler word. */
export function isFiller(token: string): boolean {
  return FILLER_WORDS.has(token);
}

/** Number of spoken tokens that count against the score (fillers excluded). */
export function countExtraWords(extras: string[]): number {
  return extras.filter((w) => !isFiller(w)).length;
}

/**
 * Score an attempt against its target fragment (0-100).
 *
 * Missing target words and words added outside the fragment both lower the
 * score: every counted extra subtracts one matched word, so merely containing
 * the target never yields 100 (a user padding the fragment with their own
 * content is not a correct repetition). Natural fillers (uh/um/...) are
 * excluded from `extras` by the caller and never penalize.
 *
 * @param targetCount number of words in the target fragment
 * @param matched target words the user actually said
 * @param extras spoken words outside the target (fillers already removed)
 */
export function penalizedScore(targetCount: number, matched: number, extras: number): number {
  if (targetCount === 0) return 0;
  const value = Math.round((100 * (matched - extras)) / targetCount);
  return Math.max(0, Math.min(100, value));
}

/** Longest common subsequence of word tokens (computed naively on token ids). */
export function wordMatch(target: string, user: string): WordMatch {
  const t = tokenize(target);
  const u = tokenize(user);
  const key = (w: string, i: number) => `${w}#${i}`;
  const tIds = t.map(key);
  const uIds = u.map(key);
  const n = t.length;
  const m = u.length;
  const dp: Uint16Array = new Uint16Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => dp[i * (m + 1) + j + 1] ?? 0;
  const set = (i: number, j: number, v: number) => (dp[i * (m + 1) + j + 1] = v);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (t[i - 1] === u[j - 1]) set(i, j, at(i - 1, j - 1) + 1);
      else set(i, j, Math.max(at(i - 1, j), at(i, j - 1)));
    }
  }
  // backtrack to find matched positions (target index + the spoken index it consumed)
  const matchedIdxs: number[] = [];
  const usedSpoken = new Set<number>();
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (t[i - 1] === u[j - 1]) {
      matchedIdxs.push(i - 1);
      usedSpoken.add(j - 1);
      i--;
      j--;
    } else if (at(i - 1, j) >= at(i, j - 1)) {
      i--;
    } else {
      j--;
    }
  }
  const matchedSet = new Set(matchedIdxs);
  const matched = t.filter((_, idx) => matchedSet.has(idx));
  const missing = t.filter((_, idx) => !matchedSet.has(idx));
  // Extras are the spoken tokens the LCS did not consume (by index, so a
  // repeated target word still surfaces as an extra instead of vanishing
  // because its value matches a consumed one).
  const extra = u.filter((_, idx) => !usedSpoken.has(idx));
  const lcs = matched.length;
  return { score: penalizedScore(n, lcs, countExtraWords(extra)), matched, missing, extra };
}
