import type { Reference } from "@dissertator/shared";
import { base, req } from "./_client";

export const referencesApi = {
  // --- References (P2 Track 3) ---------------------------------------------

  listReferences: (sourceFileId?: string) =>
    req<Reference[]>(
      "/references" +
        (sourceFileId
          ? `?source_file_id=${encodeURIComponent(sourceFileId)}`
          : ""),
    ),
  createReference: (ref: Partial<Reference>) =>
    req<Reference>("/references", {
      method: "POST",
      body: JSON.stringify(ref),
    }),
  /** Resolve a reference by id OR citekey. `GET /references/:idOrCitekey`
   *  accepts either, so a `[@citekey:page]` token resolves directly. Returns
   *  the full record incl. `source_file_id` (null for fileless refs). */
  getReference: (idOrCitekey: string) =>
    req<Reference>(`/references/${encodeURIComponent(idOrCitekey)}`),
  updateReference: (id: string, ref: Partial<Reference>) =>
    req<Reference>(`/references/${id}`, {
      method: "PUT",
      body: JSON.stringify(ref),
    }),
  deleteReference: (id: string) =>
    req<{ ok: true }>(`/references/${id}`, { method: "DELETE" }),
  /** Crossref DOI → reference. Polite-pool email read from settings server-side. */
  lookupDoi: (doi: string) =>
    req<Reference | null>("/references/lookup-doi", {
      method: "POST",
      body: JSON.stringify({ doi }),
    }),
  /** Crossref free-text search → candidate references. */
  lookupReference: (query: string) =>
    req<Reference[]>("/references/lookup", {
      method: "POST",
      body: JSON.stringify({ query }),
    }),
  /** Import a .bib string → parsed references (upserted). */
  importBibtex: (bibtex: string) =>
    req<Reference[]>("/references/import-bibtex", {
      method: "POST",
      body: JSON.stringify({ text: bibtex }),
    }),
  /** Export all references as a .bib string. */
  exportBibtex: () =>
    fetch(`${base()}/references/export.bibtex`).then((r) => r.text()),
};
