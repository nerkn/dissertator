// ---------------------------------------------------------------------------
// Documents (editor) (P3)
// ---------------------------------------------------------------------------

/** The structural template a document is authored against. */
export type DocType = "paper" | "thesis" | "lit_review" | "chapters" | "free";

/**
 * A manuscript document (paper / thesis / lit review / chapters).
 *
 * A Document is ONE body, not a tree of sections: markdown headers (`## intro`)
 * are just lines in {@link bodyMd}. "Stats" (line count, header positions)
 * are computed by the frontend by parsing the body; nothing structural is
 * stored beyond the body itself.
 */
export interface Document {
  id: string;
  title: string;
  docType: DocType | null;
  thesis: string | null;
  /** Parsed from the JSON `research_questions` column. */
  researchQuestions: string[];
  focusPrompt: string | null;
  /**
   * The manuscript body — a single markdown blob. Holds `[@citekey:page]`
   * tokens; always at least `""` (the app never stores null).
   */
  bodyMd: string;
  /** Unix epoch ms (INTEGER column). */
  createdAt: number;
}

/** Selection bbox stored on a note, normalized to page-space percent so it
 *  survives zoom (the highlight overlay is rendered later). */
export interface NoteRect {
  /** Left, as % of page width (0-100). */
  x: number;
  /** Top, as % of page height (0-100). */
  y: number;
  /** Width, as % of page width. */
  w: number;
  /** Height, as % of page height. */
  h: number;
}

/**
 * A note captured while reading: a (possibly empty) passage on a page of a
 * source, saved into a {@link List}. `excerpt` = the selected text;
 * `body` = the user's own note; both optional. `citekey` is COMPUTED at read
 * time (note.source → its linked reference) — never stored.
 */
export interface Note {
  id: string;
  sourceId: string;
  /** 1-based physical page. */
  page: number;
  /** The selected passage (optional). */
  excerpt: string | null;
  /** The user's own note (optional). */
  body: string | null;
  listId: number;
 /** Selection bbox in page-space %, or null when none was captured. */
  rect: NoteRect | null;
  /** Unix epoch ms. */
  createdAt: number;
  /** Computed: citekey of the note's source's linked reference, or null. */
  citekey?: string | null;
}
