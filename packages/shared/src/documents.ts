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
