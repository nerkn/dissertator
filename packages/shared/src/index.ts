// Shared contract between the React frontend and the Bun sidecar.
// Imported directly as TypeScript by both (no build step needed in dev).

/** Port the Bun sidecar HTTP server listens on (127.0.0.1). */
export const SIDECAR_PORT = 4319;

export type Provider = "openai" | "claude" | "zai" | "openrouter" | "custom";

export interface ProviderDefaults {
  label: string;
  apiUrl: string;
  models: string[];
  defaultModel: string;
  /** key under which the API key is stored in the OS keychain */
  keyUser: string;
}

export const PROVIDER_DEFAULTS: Record<Provider, ProviderDefaults> = {
  openai: {
    label: "OpenAI",
    apiUrl: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "o1-mini"],
    defaultModel: "gpt-4o-mini",
    keyUser: "openai_api_key",
  },
  claude: {
    label: "Anthropic Claude",
    apiUrl: "https://api.anthropic.com/v1",
    models: ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"],
    defaultModel: "claude-3-5-sonnet-latest",
    keyUser: "claude_api_key",
  },
  zai: {
    label: "Z.ai",
    apiUrl: "https://api.z.ai/api/paas/v4",
    models: ["glm-4.6", "glm-4.5"],
    defaultModel: "glm-4.6",
    keyUser: "zai_api_key",
  },
  openrouter: {
    label: "OpenRouter",
    apiUrl: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet"],
    defaultModel: "openai/gpt-4o-mini",
    keyUser: "openrouter_api_key",
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    apiUrl: "",
    models: [],
    defaultModel: "",
    keyUser: "custom_api_key",
  },
};

// ---------------------------------------------------------------------------
// Embeddings (P2) — DECOUPLED from the chat `provider`.
// A DeepSeek/Claude chat user may embed via OpenAI; the embedding key lives
// in its OWN keychain slot and travels ONLY as a request header at call time.
// ---------------------------------------------------------------------------

/** Embedding backends. `adapter` selects the wire format (see EMBEDDING_DEFAULTS). */
export type EmbeddingProvider = "openai" | "zai" | "google" | "custom";

/** Static defaults for an embedding provider (label, endpoint, models, dims). */
export interface EmbeddingDefaults {
  label: string;
  apiUrl: string; // base, no trailing slash
  models: string[]; // supported embedding model ids
  defaultModel: string;
  dimensions: number; // dimensionality of defaultModel
  /** Wire format: "openai" = OpenAI-compatible /embeddings; "google" = Generative Language API. */
  adapter: "openai" | "google";
  /** OS keychain slot for the embedding key (separate from the chat key). */
  keyUser: string;
}

export const EMBEDDING_DEFAULTS: Record<EmbeddingProvider, EmbeddingDefaults> = {
  openai: {
    label: "OpenAI",
    apiUrl: "https://api.openai.com/v1",
    models: ["text-embedding-3-small", "text-embedding-3-large"],
    defaultModel: "text-embedding-3-small",
    dimensions: 1536,
    adapter: "openai",
    keyUser: "openai_embedding_key",
  },
  zai: {
    label: "Z.ai",
    apiUrl: "https://api.z.ai/api/paas/v4",
    models: ["embedding-3"],
    defaultModel: "embedding-3",
    dimensions: 2048,
    adapter: "openai",
    keyUser: "zai_embedding_key",
  },
  google: {
    label: "Google",
    apiUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: ["text-embedding-004"],
    defaultModel: "text-embedding-004",
    dimensions: 768,
    adapter: "google",
    keyUser: "google_embedding_key",
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    apiUrl: "",
    models: [],
    defaultModel: "",
    dimensions: 0,
    adapter: "openai",
    keyUser: "custom_embedding_key",
  },
};

/**
 * Embedding configuration stored in the project DB (decoupled from chat).
 * `dimensions` is 0 until locked on the first successful embed (P2). The API
 * key is NOT stored here — it lives in the OS keychain under the provider's
 * `keyUser` slot.
 */
export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  apiUrl: string;
  model: string;
  dimensions: number; // 0 = not yet locked
}

/** User's global OCR engine preference (overridable per file from the UI). */
export type OcrStrategy = "tesseract" | "vision" | "skip";

/**
 * Provider configuration stored in the project DB (Dissertator/dissertator.db).
 * NOTE: the API key is NOT stored here — it lives in the OS keychain.
 */
export interface Settings {
  provider: Provider;
  apiUrl: string;
  model: string;
  ocrStrategy: OcrStrategy;
  /** Embedding config (P2). Independent of `provider`/`apiUrl`/`model` above. */
  embedding: EmbeddingConfig;
  /**
   * Contact email for Crossref's polite pool (P2 Track 3). Optional; when set
   * it is sent in the `User-Agent` so Crossref routes us through the faster
   * shared-rate-limit pool. Stored in the project DB (NOT a keychain slot):
   * this is a public contact address, not a secret. Defaults to `""`.
   */
  contactEmail: string;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
}

export interface ProjectCounts {
  sourceFiles: number;
  documents: number;
  references: number;
}

export interface ProjectStatus {
  initialized: boolean;
  projectPath: string | null;
  dissertatorDir: string | null;
  createdAt: string | null;
  counts: ProjectCounts;
}

export interface InitProjectResponse {
  projectPath: string;
  dissertatorDir: string;
  dbPath: string;
  createdAt: string;
  created: boolean; // false if project already existed
}

/** Agent authoring modes. */
export type AgentMode = "accept_all" | "confirm_edits";

/** Text-extraction lifecycle for a source file. */
export type TextStatus =
  | "new"
  | "extracting"
  | "done"
  | "needs_ocr"
  | "ocr_tesseract"
  | "pending_vision"
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
