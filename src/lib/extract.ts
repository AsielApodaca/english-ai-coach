// ---------------------------------------------------------------------------
// Context file ingestion (feature 104)
//
// Feature 117 split; this file recomposes the module, so every existing
// `from "./extract.ts"` import keeps resolving unchanged:
//   - extract-parse.ts   — limits/constants, ExtractError, the extractors
//                          (extractText / extractFile), the DOCUMENT CONTEXT
//                          block, the soft language detector and the LLM
//                          summarizer (createLLMSummarizer)
//   - extract-handler.ts — handleExtractRequest + its response shape
// ---------------------------------------------------------------------------

export * from "./extract-parse.ts";
export * from "./extract-handler.ts";
