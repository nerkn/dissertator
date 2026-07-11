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

  /** Auto-detect a reference for a source from its extracted text (Option A:
   *  DOI scan → Crossref → create + link). Idempotent: if the source already
   *  has a linked reference, returns it without re-scanning. `found` is false
   *  (not an error) when no DOI resolves — e.g. books / preprints / scans. */
  detectReference: (id: string) =>
    req<{
      found: boolean;
      reference: Reference | null;
      doi: string | null;
      alreadyLinked: boolean;
    }>(`/sources/${encodeURIComponent(id)}/detect-reference`, {
      method: "POST",
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

  /** Embed all pending chunks. `apiKey` is the embedding key (Bearer header). */
  embed: (apiKey?: string) =>
    req<{ embedded: number; failed: number; remaining: number }>("/embed", {
      method: "POST",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    }),
};
