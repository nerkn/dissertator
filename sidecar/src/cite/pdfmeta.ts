// PDF /info metadata → Partial<Reference> (free, deterministic stage of the
// layered reference-detection pipeline in `POST /sources/:id/detect-reference`).
//
// `unpdf.getMeta` (pdf.js under the hood) exposes the PDF info dictionary —
// Title / Author / Subject / CreationDate — which most born-digital academic
// PDFs populate (arXiv, journal PDFs) but scans and stripped/older PDFs do
// not. This stage is the cheapest of the pipeline, so it runs early: when it
// yields a clean title or author we skip both the DOI/Crossref network call
// and the LLM extraction call entirely ("only send the LLM the unables").
//
// CAVEATS: Author is a free-text string — formatting varies ("Family, Given"
// vs "Given Family" vs arXiv's "A; B; C"). We split heuristically and never
// claim precision; if a later stage runs it may overwrite. Tooling artifacts
// ("Microsoft Word", "untitled", "Adobe Acrobat") are filtered so a
// placeholder reference is never pinned to garbage.

import { getMeta } from "unpdf";
import { type Author, type Reference } from "@dissertator/shared";

/** Bare tokens / substrings that identify a tool, not a person. */
const JUNK_AUTHOR_SUBSTR = /(microsoft|adobe|acrobat|office|photoshop|indesign|\bpages\b|word\s*\d|excel|powerpoint|ghostscript|latex|pdftex|ctex|arxiv|openoffice|libreoffice|wkhtmltopdf|itext|pikepdf)/i;

const JUNK_AUTHOR_EXACT = new Set([
  "admin",
  "administrator",
  "user",
  "unknown",
  "untitled",
  "title",
  "test",
  "author",
  "n/a",
  "na",
]);

/** PDF info-dict shape returned by pdf.js (subset we care about). */
interface PdfInfo {
  Title?: string;
  Author?: string;
  Subject?: string;
  CreationDate?: string;
  Keywords?: string;
}

/** True if an author token is obviously a tool/artifact, not a person. */
export function isJunkAuthor(s: string): boolean {
  const v = s.trim().toLowerCase();
  if (!v) return true;
  if (JUNK_AUTHOR_EXACT.has(v)) return true;
  if (JUNK_AUTHOR_SUBSTR.test(s)) return true;
  return false;
}

/**
 * Parse a PDF info-dict `Author` string into CSL authors. Splits on `;`
 * (arXiv style "A; B; C"), then honors "Family, Given" when a part has a
 * comma; a multi-token comma-less part becomes `{family: last, given: rest}`;
 * a single token becomes family-only. Junk tokens are dropped.
 */
export function parseAuthors(raw: string): Author[] {
  return raw
    .split(/[;\n]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !isJunkAuthor(p))
    .map((p) => {
      const comma = p.indexOf(",");
      if (comma > 0) {
        const family = p.slice(0, comma).trim();
        const given = p.slice(comma + 1).trim();
        return { family, given: given || undefined };
      }
      const parts = p.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        return {
          family: parts.slice(-1)[0],
          given: parts.slice(0, -1).join(" "),
        };
      }
      return { family: p };
    });
}

/** Parse a PDF `CreationDate` ("D:YYYYMMDDHHmmSS...") → 4-digit year, or null. */
export function parseYear(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /(\d{4})/.exec(raw);
  return m ? Number(m[1]) : null;
}

/**
 * Extract bibliographic metadata from a PDF's info dictionary. Returns null
 * when nothing usable is present. Never throws — a pdf.js parse failure yields
 * null and the caller falls through to the next pipeline stage.
 *
 * @param data PDF bytes. `unpdf.getMeta` requires a plain `Uint8Array` and
 *   explicitly rejects Node `Buffer`, so callers' input (Buffer, ArrayBuffer,
 *   or Uint8Array) is normalized here.
 */
export async function extractPdfMetadata(
  data: Uint8Array | ArrayBuffer,
): Promise<Partial<Reference> | null> {
  let info: PdfInfo;
  try {
    // Coerce to a plain Uint8Array: unpdf rejects Node Buffers even though
    // they subclass Uint8Array, and accepts ArrayBuffer via a typed-array
    // view. `new Uint8Array(x)` does the right thing for all three inputs.
    const bytes = new Uint8Array(data);
    const meta = await getMeta(bytes);
    info = (meta.info ?? {}) as PdfInfo;
  } catch {
    return null;
  }

  const title = (info.Title ?? "").trim();
  const authorRaw = (info.Author ?? "").trim();
  const authors = authorRaw ? parseAuthors(authorRaw) : [];
  const year = parseYear(info.CreationDate);

  const cleanTitle =
    title && !/^(untitled|title|document|new document|www\.|https?:)/i.test(title)
      ? title
      : null;

  // Need at least a clean title or a non-junk author to consider this a hit.
  if (!cleanTitle && authors.length === 0) return null;

  const out: Partial<Reference> = {};
  if (cleanTitle) out.title = cleanTitle;
  if (authors.length > 0) out.authors = authors;
  if (year) out.year = year;
  return out;
}
