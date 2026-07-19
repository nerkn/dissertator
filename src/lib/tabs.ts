// Tab model for the CenterPane document viewer.
//
// Each open document is a Tab keyed by `sourceId` (one tab per source —
// re-opening an already-open source just activates its existing tab rather
// than duplicating). `kind` selects which viewer renders the tab:
//   - "pdf"   → PdfViewer (pdf.js canvas render)
//   - "image" → plain <img> from the sidecar byte endpoint
//   - "text"  → TextViewer (extracted, page-tagged text)
//   - "pdf"        → PdfViewer (pdf.js canvas render)
//   - "image"      → plain <img> from the sidecar byte endpoint
//   - "text"       → TextViewer (extracted, page-tagged text)
//   - "doc"        → ManuscriptEditor (a writable document, NOT a source file)
//   - "references" → ReferencesView (bibliography manager; singleton tab)
//
// NOTE on the `sourceId` field: despite the name it is really the tab's entity
// id. For source tabs it is a SourceFile id; for `"doc"` tabs it is a Document
// id; for `"references"` it is the sentinel REFERENCES_TAB_ID (below). The
// spaces are disjoint (UUIDs vs a fixed sentinel), so reusing one field/key
// is safe.
//
// The mapping from a SourceFile's `kind` (the ingest-layer file kind: pdf,
// docx, xlsx, text, image, unsupported) to a TabKind is fixed in
// `kindForSource`: anything that isn't a PDF or image becomes a text view
// (docx/xlsx/text/markdown/unsupported all show their extracted text).

export type TabKind = "pdf" | "image" | "text" | "doc" | "md-source" | "references";

/** Sentinel id for the singleton References-manager tab (kind "references").
 *  Not a UUID, so it can never collide with a source/doc id. */
export const REFERENCES_TAB_ID = "__references__";

export interface Tab {
  sourceId: string;
  kind: TabKind;
  title: string;
  /** Source filename (e.g. `emo25.pdf`). Used as the tab tooltip so the
   *  visible title can show the reference title instead. Undefined for
   *  non-source tabs (doc / references). */
  filename?: string;
  /** Page to land a PDF viewer on (1-based). Set when navigating from a
   *  citation token `[@citekey:page]`; undefined otherwise. The viewer treats
   *  it as both the mount-time initial page and a live "go to page" command. */
  initialPage?: number;
}

/**
 * Map an ingest-layer file `kind` ("pdf" | "docx" | ...) to a viewer TabKind.
 * PDFs render via pdf.js; images via <img>; markdown files become editable
 * manuscripts (ManuscriptEditor in source mode); everything else (docx,
 * xlsx, text, even unsupported) renders its extracted text read-only.
 */
export function kindForSource(src: {
  kind: string;
  ext: string;
}): TabKind {
  if (src.kind === "pdf") return "pdf";
  if (src.kind === "image") return "image";
  const ext = src.ext.toLowerCase();
  if (ext === "md" || ext === "markdown") return "md-source";
  return "text";
}
