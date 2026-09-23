import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, crc32 } from "node:zlib";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDocumentContext,
  CONTEXT_BUDGET,
  DEFAULT_CONTEXT_BUCKET,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_CHARS,
  detectKind,
  detectLanguage,
  ExtractError,
  extractFile,
  extractText,
  handleExtractRequest,
  sanitizeText,
  summarizeContext,
  trimToBudget,
  type ContextStorage,
  type ExtractedFile,
  type SummarizeFn,
} from "../src/lib/extract.ts";
import { createStorage } from "../src/lib/storage.ts";

// ---------------------------------------------------------------------------
// Minimal fixtures generated programmatically (no binaries committed)
// ---------------------------------------------------------------------------

/** Build a minimal single-page PDF with one text line (valid xref table). */
function makePdf(text: string): Buffer {
  const esc = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${(44 + esc.length).toString()} >>\nstream\nBT /F1 24 Tf 100 700 Td (${esc}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/** Minimal ZIP writer (deflate entries) using only node:zlib. */
function zipEntries(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data) >>> 0;
    const comp = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(comp.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}

/** Build a minimal DOCX with a single paragraph of text. */
function makeDocx(text: string): Buffer {
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    "</Types>";
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    "<w:body><w:p><w:r><w:t>" +
    text +
    "</w:t></w:r></w:p></w:body></w:document>";
  return zipEntries([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "word/document.xml", data: Buffer.from(document, "utf8") },
  ]);
}

// ---------------------------------------------------------------------------
// Kind detection
// ---------------------------------------------------------------------------

test("detectKind: maps supported extensions case-insensitively", () => {
  assert.equal(detectKind("resume.pdf"), "pdf");
  assert.equal(detectKind("RESUME.PDF"), "pdf");
  assert.equal(detectKind("notes.docx"), "docx");
  assert.equal(detectKind("notes.txt"), "txt");
  assert.equal(detectKind("ARCHITECTURE.MD"), "md");
});

test("detectKind: rejects unsupported and extension-less names", () => {
  assert.equal(detectKind("image.png"), undefined);
  assert.equal(detectKind("archive.zip"), undefined);
  assert.equal(detectKind("noextension"), undefined);
  assert.equal(detectKind(""), undefined);
});

// ---------------------------------------------------------------------------
// Direct TXT/MD extraction
// ---------------------------------------------------------------------------

test("extractText: TXT reads UTF-8 directly", async () => {
  const text = await extractText("txt", Buffer.from("Hello plain text file", "utf8"));
  assert.equal(text, "Hello plain text file");
});

test("extractText: MD reads UTF-8 directly", async () => {
  const text = await extractText("md", Buffer.from("# Title\n\nSome **markdown** body.", "utf8"));
  assert.equal(text, "# Title\n\nSome **markdown** body.");
});

test("extractText: TXT with invalid UTF-8 is rejected as binary", async () => {
  await assert.rejects(() => extractText("txt", Buffer.from([0x48, 0x69, 0xff, 0xfe, 0x00])), ExtractError);
});

// ---------------------------------------------------------------------------
// PDF + DOCX extraction with generated fixtures
// ---------------------------------------------------------------------------

test("extractText: PDF extracts text via pdf-parse", async () => {
  const text = await extractText("pdf", makePdf("Hello PDF World"));
  assert.ok(text.includes("Hello PDF World"), `got: ${JSON.stringify(text)}`);
});

test("extractText: DOCX extracts text via mammoth", async () => {
  const text = await extractText("docx", makeDocx("Hello DOCX World"));
  assert.ok(text.includes("Hello DOCX World"), `got: ${JSON.stringify(text)}`);
});

test("extractText: DOCX with a corrupt zip throws ExtractError", async () => {
  await assert.rejects(() => extractText("docx", Buffer.from("not a zip at all")), ExtractError);
});

// ---------------------------------------------------------------------------
// extractFile orchestration
// ---------------------------------------------------------------------------

test("extractFile: returns metadata + sanitized text", async () => {
  const file = await extractFile("notes.txt", Buffer.from("line one\nline two", "utf8"));
  assert.equal(file.name, "notes.txt");
  assert.equal(file.kind, "txt");
  assert.equal(file.size, 17);
  assert.equal(file.text, "line one\nline two");
  assert.equal(file.truncated, false);
});

test("extractFile: rejects unsupported extensions", async () => {
  await assert.rejects(() => extractFile("photo.png", Buffer.from("x")), /Unsupported file type/);
});

test("extractFile: rejects files over the size limit", async () => {
  const big = Buffer.alloc(DEFAULT_MAX_BYTES + 1, 0x61);
  await assert.rejects(() => extractFile("big.txt", big), /size limit/);
});

test("extractFile: honors a custom size limit", async () => {
  await assert.rejects(() => extractFile("big.txt", Buffer.alloc(1025, 0x61), { maxBytes: 1024 }), /size limit/);
  const ok = await extractFile("ok.txt", Buffer.alloc(1024, 0x61), { maxBytes: 1024 });
  assert.equal(ok.size, 1024);
});

test("extractFile: trims to the per-file char budget and flags truncated", async () => {
  const long = "word ".repeat(10_000); // 50k chars
  const file = await extractFile("long.txt", Buffer.from(long, "utf8"), { maxChars: 1000 });
  assert.equal(file.truncated, true);
  assert.ok(file.text.length <= 1000);
  assert.ok(file.text.endsWith("word"), "trims at a word boundary");
});

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

test("sanitizeText: strips NUL and control/escape sequences, keeps whitespace", () => {
  assert.equal(sanitizeText("a\u0000b\u001bc\u0007d"), "abcd");
  assert.equal(sanitizeText("keep\ttab\nnewline\rreturn"), "keep\ttab\nnewline\rreturn");
  assert.equal(sanitizeText("\u001b[31mred\u001b[0m"), "red"); // ANSI escape
  assert.equal(sanitizeText("del\u007fchar"), "delchar");
});

// ---------------------------------------------------------------------------
// trimToBudget
// ---------------------------------------------------------------------------

test("trimToBudget: returns text unchanged when within budget", () => {
  assert.equal(trimToBudget("short", 100), "short");
  assert.equal(trimToBudget("short"), "short");
});

test("trimToBudget: cuts at a word boundary when over budget", () => {
  const text = "one two three four five";
  assert.equal(trimToBudget(text, 10), "one two"); // "one two thr" -> cut at last space
  assert.equal(trimToBudget(text, 3), "one");
});

test("trimToBudget: falls back to a hard cut when no space exists", () => {
  assert.equal(trimToBudget("abcdefghij", 5), "abcde");
});

// ---------------------------------------------------------------------------
// buildDocumentContext (prompt injection wrapper)
// ---------------------------------------------------------------------------

function fileOf(name: string, text: string): ExtractedFile {
  const kind = detectKind(name) ?? "txt";
  return { name, size: text.length, kind, text, textRef: "", truncated: false };
}

test("buildDocumentContext: wraps raw file text in the DOCUMENT CONTEXT block", () => {
  const block = buildDocumentContext([fileOf("a.txt", "alpha"), fileOf("b.md", "beta")]);
  assert.ok(block.startsWith("DOCUMENT CONTEXT\n"));
  assert.ok(block.includes("--- a.txt (txt) ---\nalpha"));
  assert.ok(block.includes("--- b.md (md) ---\nbeta"));
});

test("buildDocumentContext: returns empty string for no files", () => {
  assert.equal(buildDocumentContext([]), "");
});

test("buildDocumentContext: respects the budget across files", () => {
  const big = "x".repeat(10_000);
  const block = buildDocumentContext([fileOf("big.txt", big)], 100);
  assert.ok(block.length <= 100 + 64, `block too long: ${block.length}`);
  assert.ok(block.includes("--- big.txt (txt) ---"));
});

// ---------------------------------------------------------------------------
// summarizeContext
// ---------------------------------------------------------------------------

test("summarizeContext: skips the LLM when within budget", async () => {
  let called = false;
  const llm: SummarizeFn = async () => {
    called = true;
    return "unused";
  };
  const out = await summarizeContext([fileOf("a.txt", "small doc")], llm, 1000);
  assert.equal(called, false);
  assert.ok(out.startsWith("DOCUMENT CONTEXT\n"));
});

test("summarizeContext: calls the LLM when over budget", async () => {
  const llm: SummarizeFn = async (text, budget) => `SUMMARY(${text.length},${budget})`;
  const out = await summarizeContext([fileOf("big.txt", "y".repeat(5000))], llm, 100);
  assert.ok(out.startsWith("DOCUMENT CONTEXT (summarized)\n"));
  assert.match(out, /SUMMARY\(\d+,100\)/);
});

test("summarizeContext: falls back to truncation when the LLM fails", async () => {
  const llm: SummarizeFn = async () => {
    throw new Error("provider down");
  };
  const out = await summarizeContext([fileOf("big.txt", "y".repeat(5000))], llm, 100);
  assert.ok(out.startsWith("DOCUMENT CONTEXT\n"));
  assert.ok(out.length <= 100 + 64);
});

// ---------------------------------------------------------------------------
// Soft language detection
// ---------------------------------------------------------------------------

test("detectLanguage: distinguishes English and Spanish by stopwords", () => {
  assert.equal(detectLanguage("the quick brown fox and the lazy dog with a plan"), "en");
  assert.equal(detectLanguage("el perro y el gato de la casa con un plan"), "es");
  assert.equal(detectLanguage("abc"), "unknown");
});

// ---------------------------------------------------------------------------
// Endpoint handler (handleExtractRequest)
// ---------------------------------------------------------------------------

function mockStorage(): { storage: ContextStorage; saved: Array<{ bucket: string; text: string }> } {
  const saved: Array<{ bucket: string; text: string }> = [];
  return {
    saved,
    storage: {
      saveContextText(bucket, file, text) {
        saved.push({ bucket, text });
        return `${file.kind}-1.txt`;
      },
    },
  };
}

test("handleExtractRequest: happy path extracts, persists and returns metadata", async () => {
  const { storage, saved } = mockStorage();
  const res = await handleExtractRequest(storage, {
    name: "notes.txt",
    data: Buffer.from("hello context", "utf8").toString("base64"),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.file.name, "notes.txt");
  assert.equal(res.json.file.kind, "txt");
  assert.equal(res.json.file.textRef, "txt-1.txt");
  assert.equal(res.json.text, "hello context");
  assert.equal(res.json.chars, 13);
  assert.equal(res.json.truncated, false);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].bucket, DEFAULT_CONTEXT_BUCKET);
  assert.equal(saved[0].text, "hello context");
});

test("handleExtractRequest: uses sessionId as the persistence bucket", async () => {
  const { storage, saved } = mockStorage();
  const res = await handleExtractRequest(storage, {
    name: "notes.txt",
    data: Buffer.from("hi", "utf8").toString("base64"),
    sessionId: "abc-123",
  });
  assert.equal(res.status, 200);
  assert.equal(saved[0].bucket, "abc-123");
});

test("handleExtractRequest: missing name → 400", async () => {
  const { storage } = mockStorage();
  const res = await handleExtractRequest(storage, { data: "aGk=" });
  assert.equal(res.status, 400);
  assert.match(res.json.error as string, /name is required/);
});

test("handleExtractRequest: missing/empty data → 400", async () => {
  const { storage } = mockStorage();
  const noData = await handleExtractRequest(storage, { name: "a.txt" });
  assert.equal(noData.status, 400);
  assert.match(noData.json.error as string, /data/);
  const empty = await handleExtractRequest(storage, { name: "a.txt", data: "" });
  assert.equal(empty.status, 400);
});

test("handleExtractRequest: unsupported extension → 400 with friendly error", async () => {
  const { storage } = mockStorage();
  const res = await handleExtractRequest(storage, {
    name: "evil.exe",
    data: Buffer.from("MZ").toString("base64"),
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error as string, /Unsupported file type/);
});

test("handleExtractRequest: oversized file → 400", async () => {
  const { storage } = mockStorage();
  const res = await handleExtractRequest(storage, {
    name: "big.txt",
    data: Buffer.alloc(DEFAULT_MAX_BYTES + 1, 0x61).toString("base64"),
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error as string, /size limit/);
});

test("handleExtractRequest: unparseable PDF → 400 with friendly error", async () => {
  const { storage } = mockStorage();
  const res = await handleExtractRequest(storage, {
    name: "broken.pdf",
    data: Buffer.from("this is not a pdf").toString("base64"),
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error as string, /Could not parse/);
});

// ---------------------------------------------------------------------------
// Persistence round-trip (storage.saveContextText / loadContextText)
// ---------------------------------------------------------------------------

test("storage: context text round-trips under data/tmp/context/<bucket>/", () => {
  const dir = mkdtempSync(join(tmpdir(), "engcoach-extract-"));
  try {
    const s = createStorage(dir);
    const textRef = s.saveContextText("abc-123", { name: "a.txt", size: 5, kind: "txt" }, "hello");
    assert.match(textRef, /^txt-[a-f0-9-]+\.txt$/);
    assert.equal(s.loadContextText("abc-123", textRef), "hello");
    // persisted under data/tmp/context/<bucket>/
    const onDisk = readFileSync(join(dir, "data", "tmp", "context", "abc-123", textRef), "utf8");
    assert.equal(onDisk, "hello");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: loadContextText falls back to the draft bucket", () => {
  const dir = mkdtempSync(join(tmpdir(), "engcoach-extract-"));
  try {
    const s = createStorage(dir);
    const textRef = s.saveContextText(DEFAULT_CONTEXT_BUCKET, { name: "a.txt", size: 5, kind: "txt" }, "draft text");
    assert.equal(s.loadContextText("session-1", textRef), "draft text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: loadContextText rejects unsafe buckets and refs", () => {
  const dir = mkdtempSync(join(tmpdir(), "engcoach-extract-"));
  try {
    const s = createStorage(dir);
    assert.equal(s.loadContextText("../../etc", "x.txt"), undefined);
    assert.equal(s.loadContextText("ok", "../../x.txt"), undefined);
    assert.throws(() => s.saveContextText("../escape", { name: "a.txt", size: 1, kind: "txt" }, "x"), /unsafe context bucket/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage: loadContextText returns undefined for missing files", () => {
  const dir = mkdtempSync(join(tmpdir(), "engcoach-extract-"));
  try {
    const s = createStorage(dir);
    assert.equal(s.loadContextText("abc", "txt-missing.txt"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Constants sanity
// ---------------------------------------------------------------------------

test("defaults: 10 MB size limit, 40k char budget, 16k context budget", () => {
  assert.equal(DEFAULT_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_CHARS, 40_000);
  assert.equal(CONTEXT_BUDGET, 16_000);
});