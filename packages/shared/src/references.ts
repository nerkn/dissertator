// ---------------------------------------------------------------------------
// Citations & references (P2 Track 3)
// ---------------------------------------------------------------------------

/** A bibliographic author. CSL shape (`{ family, given }`). */
export interface Author {
  family?: string;
  given?: string;
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
