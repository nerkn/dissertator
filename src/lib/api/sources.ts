import type {
  EmbeddingStatus,
  Reference,
  SearchResponse,
  SourceFile,
  SourcesResponse,
} from "@dissertator/shared";
import { req, sidecarBase } from "./_client";

export const sourcesApi = {
  // --- Ingest surface (Track G+H) -------------------------------------------

  /** All source files + live counts. */
  getSources: () => req<SourcesResponse>("/sources"),

  /** Raw file-byte URL for PDF/image viewing (sidecar streams bytes). */
  fileUrl: (id: string) => `${sidecarBase()}/files/${encodeURIComponent(id)}`,

  /** Concatenated page-tagged extracted text for a single source. */
  getSourceText: (id: string) =>
    req<{ filename: string; text: string; pageCount: number }>(
      `/sources/${encodeURIComponent(id)}/text`,
    ),

  /** Raw markdown body of a .md source (read straight from disk; no page
   *  markers). The manuscript editor loads this so .md files become editable
   *  manuscripts. Only valid for sources whose `mimeType === "text/markdown"` */
  getSourceMarkdown: (id: string) =>
    req<{
      id: string;
      filename: string;
      title: string;
      bodyMd: string;
    }>(`/sources/${encodeURIComponent(id)}/markdown`),

  /** Write the markdown body of a .md source back to disk; the sidecar
   *  re-ingests the file so chunks/embeddings/content_hash stay fresh. */
  updateSourceMarkdown: (id: string, bodyMd: string) =>
    req<{ ok: true; id: string }>(
      `/sources/${encodeURIComponent(id)}/markdown`,
      { method: "PUT", body: JSON.stringify({ bodyMd }) },
    ),

  /** Force a rescan of the project root; returns count of newly enqueued files. */
  rescan: () => req<{ enqueued: number }>("/ingest", { method: "POST" }),

  /** Files needing manual attention (failed / pending-OCR / needs_ocr). */
  getAttention: () => req<{ items: SourceFile[] }>("/attention"),

  /**
   * Run OCR on a single source file. `engine` selects the backend:
   *   - "tesseract" → local, free, no key
   *   - "vision"    → provider LLM vision API; `apiKey` is passed as a
   *                   Bearer token in the Authorization header. The sidecar
   *                   reads it from the header and never persists it.
   */
  ocrSource: (
    id: string,
    engine: "tesseract" | "vision",
    apiKey?: string,
  ) =>
    req<{ ok: true; id: string }>(`/sources/${id}/ocr`, {
      method: "POST",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      body: JSON.stringify({ engine }),
    }),

  /** Transcribe an audio source via a Whisper-compatible endpoint. `apiKey`
   *  is the chat-provider key (same one OCR-vision uses); passed as a Bearer
   *  header, never persisted. */
  transcribeSource: (id: string, apiKey?: string) =>
    req<{ ok: true; id: string }>(`/sources/${id}/transcribe`, {
      method: "POST",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      body: JSON.stringify({}),
    }),

  /** Describe a standalone image (vision_image function): understand the
   *  image and store a textual description as its text. Bearer header. */
  describeImage: (id: string, apiKey?: string) =>
    req<{ ok: true; id: string }>(`/sources/${id}/describe-image`, {
      method: "POST",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      body: JSON.stringify({}),
    }),

  /** Auto-detect a reference for a source via a layered pipeline (DOI scan
   *  → Crossref; PDF /info metadata; LLM extract from the title page). First
   *  stage that yields a title or authors wins. A linked placeholder (no
   *  authors + no doi) is enriched in place rather than skipped. `chatKey`
   *  enables the LLM stage (Bearer header, never persisted); without it the
   *  LLM stage is silently skipped. `source` reports the winning stage
   *  ("doi" | "pdf-meta" | "llm" | "none"). */
  detectReference: (id: string, chatKey?: string) =>
    req<{
      found: boolean;
      reference: Reference | null;
      doi: string | null;
      alreadyLinked: boolean;
      source: "doi" | "pdf-meta" | "llm" | "none";
    }>(`/sources/${encodeURIComponent(id)}/detect-reference`, {
      method: "POST",
      headers: chatKey ? { Authorization: `Bearer ${chatKey}` } : undefined,
    }),

  // --- Semantic search (P2 Track 2) ----------------------------------------

  /** Semantic search over the embedded corpus. `apiKey` is the embedding key
   *  (required once the corpus is embedded); passed as a Bearer header. */
  search: (
    q: string,
    opts?: { limit?: number; sourceId?: string; apiKey?: string },
  ) =>
    req<SearchResponse>(
      `/search?q=${encodeURIComponent(q)}` +
        (opts?.limit ? `&limit=${opts.limit}` : "") +
        (opts?.sourceId ? `&sourceId=${encodeURIComponent(opts.sourceId)}` : ""),
      {
        headers: opts?.apiKey
          ? { Authorization: `Bearer ${opts.apiKey}` }
          : undefined,
      },
    ),

  // --- Embeddings (P2 Track 1) ---------------------------------------------

  /** Locked embedding dimensionality + per-status counts. */
  embedStatus: () => req<EmbeddingStatus>("/embed/status"),

  /** Kick off a background drain of ALL pending chunks (fire-and-forget).
   *  `apiKey` is the embedding key (Bearer header). Returns immediately;
   *  progress is observable via embedStatus().running + pending/done. */
  embed: (apiKey?: string) =>
    req<{ started: boolean; running: boolean }>("/embed", {
      method: "POST",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    }),
};
