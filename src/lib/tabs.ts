// Tab model for the CenterPane document viewer.
//
// Each open document is a Tab keyed by `sourceId` (one tab per source —
// re-opening an already-open source just activates its existing tab rather
// than duplicating). `kind` selects which viewer renders the tab:
//   - "pdf"   → PdfViewer (pdf.js canvas render)
//   - "image" → plain <img> from the sidecar byte endpoint
//   - "text"  → TextViewer (extracted, page-tagged text)
//   - "doc"   → ManuscriptEditor (a writable document, NOT a source file)
//
// NOTE on the `sourceId` field: despite the name it is really the tab's entity
// id. For source tabs it is a SourceFile id; for `"doc"` tabs it is a Document
// id. The two id spaces are disjoint UUIDs, so reusing one field/key is safe.
//
// The mapping from a SourceFile's `kind` (the ingest-layer file kind: pdf,
// docx, xlsx, text, image, unsupported) to a TabKind is fixed in
// `kindForSource`: anything that isn't a PDF or image becomes a text view
// (docx/xlsx/text/markdown/unsupported all show their extracted text).

export type TabKind = "pdf" | "image" | "text" | "doc";

export interface Tab {
  sourceId: string;
  kind: TabKind;
  title: string;
}

/**
 * Map an ingest-layer file `kind` ("pdf" | "docx" | ...) to a viewer TabKind.
 * PDFs render via pdf.js; images via <img>; everything else (docx, xlsx,
 * text, markdown, even unsupported) renders its extracted text.
 */
export function kindForSource(kind: string): TabKind {
  if (kind === "pdf") return "pdf";
  if (kind === "image") return "image";
  return "text";
}
