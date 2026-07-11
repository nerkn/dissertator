/** User's global OCR engine preference (overridable per file from the UI). */
export type OcrStrategy = "tesseract" | "vision" | "skip";

/** Text-extraction lifecycle for a source file. */
export type TextStatus =
  | "new"
  | "extracting"
  | "done"
  | "needs_ocr"
  | "ocr_tesseract"
  | "pending_vision"
  | "needs_transcription"
  | "pending_transcription"
  | "failed";

/** A source file row, as exposed by the sidecar to the frontend. */
export interface SourceFile {
  id: string;
  relPath: string;
  filename: string;
  ext: string;
  kind: string;
  contentHash: string | null;
  fileSize: number | null;
  mimeType: string | null;
  textStatus: TextStatus;
  ocrMethod: string | null;
  pageCount: number | null;
  error: string | null;
  needsOcrReason: string | null;
  addedAt: number;
}

export interface SourceCounts {
  total: number;
  done: number;
  needsOcr: number;
  failed: number;
  extracting: number;
}

export interface SourcesResponse {
  items: SourceFile[];
  counts: SourceCounts;
}

export type AttentionItem = SourceFile;

// ---------------------------------------------------------------------------
// Semantic search (P2 Track 2)
// ---------------------------------------------------------------------------

/** A single ranked search hit: one chunk + its source metadata + a score. */
export interface SearchHit {
  chunkId: string;
  sourceId: string;
  relPath: string;
  filename: string;
  physicalPage: number | null;
  printedPage: string | null;
  /** The chunk text, truncated to a snippet (~500 chars). */
  text: string;
  /** Similarity score in [0,1] (1 = nearest match). See `searchCorpus`. */
  score: number;
}

/** Response from `GET /search`. Empty + `embedded:false` when unembedded. */
export interface SearchResponse {
  hits: SearchHit[];
  total: number;
  /** Locked embedding dimensionality, or 0 if the corpus isn't embedded yet. */
  dimensions: number;
  /** false = corpus not yet embedded (empty result, UI shows "embed first"). */
  embedded: boolean;
}

/** Embedding lifecycle counts + lock info, surfaced at `GET /embed/status`. */
export interface EmbeddingStatus {
  pending: number;
  done: number;
  failed: number;
  /** Chunks mid-flight (`embedding_status='embedding'`). */
  embedding: number;
  total: number;
  /** Locked dimensionality (0 = not yet locked / vec0 table not created). */
  dimensions: number;
  /** Configured embedding model id. */
  model: string;
  /** sqlite-vec extension loaded? False → embeddings disabled. */
  vecLoaded: boolean;
}
