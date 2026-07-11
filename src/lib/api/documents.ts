import type { DocType, Document } from "@dissertator/shared";
import { base, req } from "./_client";

export const documentsApi = {
  /** Render a manuscript (as HTML) to PDF / DOCX / DOC via headless
   *  LibreOffice on the sidecar. Returns the converted file as a Blob.
   *  (Browser fallback path — Tauri webviews swallow blob-URL downloads, so
   *  prefer {@link exportDocumentToPath} there.) */
  exportDocument: (
    html: string,
    format: "pdf" | "docx" | "doc",
    title?: string,
  ) =>
    fetch(`${base()}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html, format, title }),
    }).then(async (r) => {
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error ?? `export failed (${r.status})`);
      }
      return r.blob();
    }),

  /** Same conversion, but write the result to an absolute `outPath` (chosen
   *  via a Tauri Save dialog). Returns the path written. Reliable in the
   *  Tauri webview, unlike the blob-download path. */
  exportDocumentToPath: (
    html: string,
    format: "pdf" | "docx" | "doc",
    outPath: string,
    title?: string,
  ) =>
    fetch(`${base()}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html, format, title, outPath }),
    }).then(async (r) => {
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error ?? `export failed (${r.status})`);
      }
      return (await r.json()) as { ok: true; path: string };
    }),

  /** Import a dropped/picked file (sourcePath) or pasted image bytes
   *  (dataUrl) into the project's images/ audio/ (or root). The sidecar does
   *  the copy/move/write and returns the project-relative path + kind. */
  importAsset: (input: {
    sourcePath?: string;
    dataUrl?: string;
    filename: string;
    dest: "images" | "audio" | "root";
    mode?: "copy" | "move";
  }) =>
    req<{ ok: true; relPath: string; absPath: string; kind: string }>(
      "/assets/import",
      { method: "POST", body: JSON.stringify(input) },
    ),

  // --- Documents (P3 editor) -----------------------------------------------
  // The manuscript editor loads a document (with bodyMd) and autosaves the body
  // via PUT /documents/:id { bodyMd }. A document is a single body — markdown
  // headers are just lines in it, not separate rows.

  /** List all documents (each with bodyMd). */
  listDocuments: () => req<Document[]>("/documents"),

  /** Create a document with an empty body. `title` required. */
  createDocument: (input: {
    title: string;
    docType?: DocType;
    thesis?: string;
    researchQuestions?: string[];
    focusPrompt?: string;
  }) =>
    req<Document>("/documents", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** Full document (including bodyMd). */
  getDocument: (id: string) =>
    req<Document>(`/documents/${encodeURIComponent(id)}`),

  /** Partial patch. Omit a field to keep it; pass null to clear. `bodyMd` may
   *  be set to "" explicitly (empty body) — omit to keep the current body. */
  updateDocument: (
    id: string,
    patch: Partial<{
      title: string;
      docType: DocType | null;
      thesis: string | null;
      researchQuestions: string[];
      focusPrompt: string | null;
      bodyMd: string;
    }>,
  ) =>
    req<Document>(`/documents/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  deleteDocument: (id: string) =>
    req<{ ok: true }>(`/documents/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
};
