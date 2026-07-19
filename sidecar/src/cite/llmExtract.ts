// LLM extraction of bibliographic metadata from the first page of a source —
// the high-recall fallback of the layered reference-detection pipeline
// (`POST /sources/:id/detect-reference`).
//
// Stages 1 (DOI → Crossref) and 2 (PDF info metadata) cover the
// cheap/authoritative cases; this stage catches everything they miss
// (scanned/OCR'd PDFs with no DOI, books, preprints, stripped-metadata PDFs,
// DOCX, transcripts). We send only the first ~3k chars (title page) — author
// / title / year / venue almost always live there — and ask for strict JSON.
//
// Reuses the streaming chat adapter so keys/fetch/error handling live on one
// path; we accumulate the stream and parse a JSON object out of the assembled
// text. The model is told to emit ONLY a JSON object; we additionally tolerate
// ```json fences and trailing prose by slicing to the outermost {...}.

import { type Author, type ChatEndpointConfig, type Reference, parseAuthors } from "@dissertator/shared";
import { streamOpenAIChat } from "../chat/openai.ts";

/** Cap input to the title page (keeps the call cheap and on-point). */
const MAX_INPUT_CHARS = 3000;

const SYSTEM_PROMPT =
  "You extract bibliographic metadata from the first page of a scholarly " +
  "document. Identify the document's OWN metadata (title, authors, year, " +
  "venue, DOI) — never metadata of cited works in its reference list. " +
  "Respond with ONLY a JSON object, no prose, in this exact shape:\n" +
  '{"title": string|null, "authors_text": string|null, ' +
  '"year": number|null, "venue": string|null, "doi": string|null}.\n' +
  "Use null for unknown fields. `authors_text` is the author byline copied " +
  "CHARACTER-FOR-CHARACTER from the document, in the ORIGINAL order as " +
  "printed (the first author listed drives citation sorting). Do not split, " +
  "abbreviate, reorder, or normalize names — copy verbatim. DOI must be the " +
  "bare `10.xxxx/...` form, lowercase, no URL prefix.";

export interface LlmExtractOpts {
  apiKey: string;
  config: ChatEndpointConfig;
  signal?: AbortSignal;
}

/**
 * Extract a partial {@link Reference} via a single chat completion. Returns
 * null on any failure (network/parse/empty) so the caller falls through
 * gracefully. Never throws — a failed extraction just means "no LLM data this
 * run" and the route reports `found: false`.
 */
export async function extractReferenceViaLLM(
  text: string,
  opts: LlmExtractOpts,
): Promise<Partial<Reference> | null> {
  const snippet = text.slice(0, MAX_INPUT_CHARS).trim();
  if (!snippet) return null;

  let buf = "";
  try {
    await streamOpenAIChat({
      apiKey: opts.apiKey,
      config: opts.config,
      maxTokens: 600,
      signal: opts.signal,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: snippet },
      ],
      onDelta: (d) => {
        buf += d;
      },
    });
  } catch (e) {
    console.error(`[llm-extract] stream failed:`, (e as Error)?.message ?? String(e));
    return null;
  }

  const parsed = parseLlmReferenceJson(buf);
  if (!parsed && buf.trim()) {
    console.error(`[llm-extract] parsed null from buf (len=${buf.length}):`, buf.slice(0, 300));
  }
  return parsed;
}

/**
 * Slice the outermost `{...}` block out of `raw` and parse it into a partial
 * {@link Reference}. Tolerates ```json fences and trailing prose. Returns null
 * on missing/invalid JSON or when neither a title nor any author survives
 * normalization. Exported for unit testing.
 */
export function parseLlmReferenceJson(raw: string): Partial<Reference> | null {
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }

  const out: Partial<Reference> = {};
  if (typeof obj.title === "string" && obj.title.trim()) {
    out.title = obj.title.trim();
  }
  if (typeof obj.authors_text === "string" && obj.authors_text.trim()) {
    const authors = parseAuthors(obj.authors_text);
    if (authors.length > 0) out.authors = authors;
  } else if (Array.isArray(obj.authors)) {
    // Legacy structured form — tolerated only if the model ignores the
    // `authors_text` instruction. Order is whatever the model emitted.
    const authors: Author[] = obj.authors
      .map((a): Author | null => {
        if (!a || typeof a !== "object") return null;
        const r = a as Record<string, unknown>;
        const family = typeof r.family === "string" ? r.family.trim() : "";
        const given = typeof r.given === "string" ? r.given.trim() : "";
        if (!family && !given) return null;
        return {
          family: family || undefined,
          given: given || undefined,
        };
      })
      .filter((a): a is Author => a !== null);
    if (authors.length > 0) out.authors = authors;
  }
  if (typeof obj.year === "number" && Number.isFinite(obj.year)) {
    out.year = obj.year;
  } else if (typeof obj.year === "string") {
    const m = /\d{4}/.exec(obj.year);
    if (m) out.year = Number(m[0]);
  }
  if (typeof obj.venue === "string" && obj.venue.trim()) {
    out.venue = obj.venue.trim();
  }
  if (typeof obj.doi === "string") {
    const doi = obj.doi.trim().toLowerCase();
    // Strip any URL prefix the model may have added despite instructions.
    const stripped = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
    if (stripped.startsWith("10.")) out.doi = stripped;
  }

  // Must have at least a title or authors to count as a hit — a venue/year
  // alone isn't enough to identify a reference.
  if (!out.title && !out.authors) return null;
  return out;
}
