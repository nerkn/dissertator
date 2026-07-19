// ---------------------------------------------------------------------------
// Citations & references (P2 Track 3)
// ---------------------------------------------------------------------------

/** A bibliographic author. CSL shape (`{ family, given }`). */
export interface Author {
  family?: string;
  given?: string;
}

/** Parse a free-text author byline into Author[]. Single set of rules shared
 *  by every text-sourced path (GUI edit, PDF info-dict, LLM-byline). BibTeX
 *  import keeps its own parser (` and ` separator + LaTeX accents + braces)
 *  and Crossref returns structured JSON, so neither calls this.
 *
 *  Separator: `;` or newline if present (arXiv `A; B; C`, or BibTeX-style
 *  `Family, Given; ...`); otherwise comma — the common paper style
 *  (`Given Family, Given Family, ...`) that copy-paste from any PDF/journal
 *  yields. Per chunk: an internal comma means `Family, Given`; otherwise the
 *  last whitespace token is the family (`Given Family`). Empty chunks are
 *  dropped. Paper order is preserved — `result[0]` is the first-listed
 *  author and drives the citekey. */
export function parseAuthors(s: string): Author[] {
  if (!s) return [];
  const sep = /[;\n]/.test(s) ? /[;\n]/ : /,/;
  return s
    .split(sep)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^([^,]+),\s*(.+)$/);
      if (m) return { family: m[1].trim(), given: m[2].trim() };
      const i = p.lastIndexOf(" ");
      if (i === -1) return { family: p };
      return { given: p.slice(0, i).trim(), family: p.slice(i + 1).trim() };
    });
}

/**
 * A reference record. Matches the `references` table schema (DESIGN.md §3).
 * A reference may or may not have a backing `SourceFile` (`sourceFileId`
 * nullable — fileless refs produce valid APA entries via citeproc-js).
 */
export interface Reference {
  id: string;
  /** UNIQUE; frozen after first assignment (DESIGN.md §8 decision #9). */
  citekey: string;
  title: string | null;
  /** Parsed from the JSON `authors` column (`[{family, given}]`). */
  authors: Author[];
  year: number | null;
  doi: string | null;
  /** CSL type: `article-journal` | `book` | `chapter` | ... */
  type: string | null;
  venue: string | null;
  /** Full CSL record, stored verbatim for citeproc-js rendering. */
  csl_json: Record<string, unknown> | null;
  /** FK if linked to a source file; null for fileless references. */
  source_file_id: string | null;
}
