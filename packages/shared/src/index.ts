// Shared contract between the React frontend and the Bun sidecar.
// Imported directly as TypeScript by both (no build step needed in dev).

/** Preferred port the Bun sidecar HTTP server listens on (127.0.0.1). */
export const SIDECAR_PORT = 4319;

/**
 * How many consecutive ports above `SIDECAR_PORT` to probe before giving up.
 * The sidecar binds the first free one; the frontend scans the same range to
 * discover it, so a busy preferred port never blocks startup.
 */
export const SIDECAR_PORT_RANGE = 12;

export type Provider = "openai" | "claude" | "zai" | "openrouter" | "custom";

/**
 * A named, user-editable provider entry in the `providers` table. The user
 * builds a LIST of these (multiple OpenAI accounts, a work Claude, etc.);
 * the Functions tab assigns one chat-kind provider to `chat` and one
 * embedding-kind provider to `vectorizer`.
 *
 * `type` is the backend flavor: a {@link Provider} for `kind==="chat"`, an
 * {@link EmbeddingProvider} for `kind==="embedding"`. Both are string unions
 * (and overlap on openai/zai/custom), so the column is free-text at the DB
 * layer; the UI picks PROVIDER_DEFAULTS vs EMBEDDING_DEFAULTS by `kind`.
 *
 * `keyUser` is the OS keychain slot for this provider's API key. Seeded
 * defaults reuse the LEGACY slots (`openai_api_key`, …) so existing keys
 * survive the upgrade with no keychain migration; providers the user adds
 * get a fresh per-id slot via {@link providerKeyUser}.
 */
export type ProviderKind = "chat" | "embedding";

export interface ProviderConfig {
  id: string;
  /** User-given label, e.g. "Work OpenAI". Shown in the Functions dropdowns. */
  name: string;
  kind: ProviderKind;
  /** Backend flavor. `Provider` for chat, `EmbeddingProvider` for embedding. */
  type: Provider | EmbeddingProvider;
  apiUrl: string;
  model: string;
  /** OS keychain slot for this provider's API key. */
  keyUser: string;
  /** True for the default chat provider (the one new chats / vision use). */
  isDefault: boolean;
  createdAt: string;
}

/** Fresh per-provider keychain slot for a user-added provider. */
export function providerKeyUser(id: string): string {
  return `dissertator:provider:${id}`;
}

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
 * Optional CHAT provider override (P3). All three fields are OPTIONAL: when
 * `chatProvider` is unset, the chat endpoint falls back to the main
 * `provider`/`apiUrl`/`model` block (decision #1 — "default provider if not
 * specified"). When `chatProvider` IS set, empty `chatApiUrl`/`chatModel`
 * fall back to that provider's `PROVIDER_DEFAULTS`. The API key is NEVER
 * stored here — it lives in the OS keychain under the resolved provider's
 * `keyUser` slot.
 */
export interface ChatConfig {
  /** Override provider for chat only (e.g. "claude" while vision stays openai). */
  chatProvider?: Provider;
  /** Override base URL; empty → `PROVIDER_DEFAULTS[chatProvider].apiUrl`. */
  chatApiUrl?: string;
  /** Override model; empty → `PROVIDER_DEFAULTS[chatProvider].defaultModel`. */
  chatModel?: string;
}

/**
 * Resolved chat endpoint configuration (computed, never stored). When the
 * optional `ChatConfig` override is absent/incomplete, fields mirror the
 * main `provider`/`apiUrl`/`model` block.
 */
export interface ResolvedChatConfig {
  provider: Provider;
  apiUrl: string;
  model: string;
}

/**
 * Provider configuration stored in the project DB (Dissertator/dissertator.db).
 * NOTE: the API key is NOT stored here — it lives in the OS keychain.
 */
export interface Settings extends ChatConfig {
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
  /**
   * The chat-kind provider row assigned to the `chat` function (Functions
   * tab). When set, `provider`/`apiUrl`/`model` above are RESOLVED from that
   * row by `getSettings` (read-only on the wire). Absent on legacy DBs until
   * the providers-table migration runs.
   */
  chatProviderId?: string;
  /**
   * The embedding-kind provider row assigned to the `vectorizer` function.
   * When set, `embedding.{provider,apiUrl,model}` are RESOLVED from it.
   */
  embeddingProviderId?: string;
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

// ---------------------------------------------------------------------------
// Citations & references (P2 Track 3)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Chat (P3)
// ---------------------------------------------------------------------------

/**
 * A freeform, persisted chat thread (NOT bound to any document).
 *
 * The user picks which source files are in scope per chat (stored on
 * {@link contextSources} for UI persistence); messages belong to a chat via
 * {@link ChatMessage.chatId}. A chat may have an empty `contextSources`
 * (no pinned sources — the agent just answers from the system prompt).
 */
export interface Chat {
  id: string;
  title: string;
  /** source_file ids the user pinned to this chat (may be empty). */
  contextSources: string[];
  createdAt: number;
  updatedAt: number;
}

/** Persisted chat message row (`chat_messages` table). */
export interface ChatMessage {
  id: string;
  /** FK to the chat this message belongs to. */
  chatId: string;
  role: "user" | "assistant" | "system";
  content: string | null;
  /** Source-file ids the user had open when this message was sent. */
  openFiles: string[];
  /** LLM-reported token usage for this turn (assistant turns only). */
  costTokens: number | null;
  createdAt: number;
}

/** Body of `POST /chat`. The API key travels as the Authorization header. */
export interface ChatRequest {
  /** REQUIRED: the chat this turn belongs to. */
  chatId: string;
  message: string;
  /** Source-file ids to inject as context (their concatenated chunks). */
  openFiles?: string[];
  /**
   * The document the user is currently editing (transient UI state, not a
   * binding — chats stay document-unbound). P5: the agent uses this as the
   * default target for `p_read`/`p_write`/`p_insert` when the tool's `id` is
   * omitted, and mentions it in the system prompt so the model knows which
   * manuscript it is co-authoring.
   */
  activeDocumentId?: string;
}

/**
 * One option offered to the user mid-run via `gui_options`. Clicking it sends
 * {@link prompt} as the user's next message; {@link short} is the chip label.
 */
export interface GuiOption {
  short: string;
  prompt: string;
}

/**
 * A `gui_*` tool side-effect relayed to the frontend over the chat SSE stream
 * (event name `gui`). The frontend opens a viewer, shows option chips, or
 * surfaces a non-blocking narration beat. These never pause the run.
 */
export type GuiEvent =
  | { kind: "doc_open"; sourceId: string }
  | { kind: "p_open"; documentId: string }
  | { kind: "options"; options: GuiOption[] }
  | { kind: "action"; action: "warn" | "celebrate" | "info"; text: string };

/**
 * A predefined prompt loaded from the project's `Dissertator/prompts.md`.
 * `category` comes from a `## Heading` (applies to following bullets); `label`
 * comes from a `**Label**:` prefix, else a truncated prompt. Surfaced at
 * `GET /prompts` so the frontend can render a quick-pick menu.
 */
export interface Prompt {
  category?: string;
  label: string;
  prompt: string;
}

/**
 * Serialize a `Prompt[]` back into the `prompts.md` markdown shape that
 * {@link parsePrompts} (sidecar) reads: a `## Category` heading whenever the
 * category changes, then one `- **Label**: prompt` bullet per prompt. The
 * inverse of the sidecar parser — used by the Settings → Prompts tab to turn
 * the structured editor's rows back into the file. Empty rows are dropped so
 * a half-typed Add row never writes junk. Pure + exported for tests.
 */
export function serializePrompts(prompts: Prompt[]): string {
  const lines: string[] = ["# Prompts", ""];
  let lastCat: string | undefined;
  let emitted = false;
  for (const p of prompts) {
    const label = p.label.trim();
    const text = p.prompt.trim();
    // Skip a row that has neither label nor text (a half-typed Add row).
    if (!label && !text) continue;
    const cat = p.category?.trim() || undefined;
    if (cat !== lastCat) {
      if (emitted) lines.push("");
      lines.push(`## ${cat ?? "Prompts"}`);
      lastCat = cat;
      emitted = true;
    }
    lines.push(`- **${label || "Untitled"}**: ${text}`);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

/**
 * Focused settings patch (P6). Only scalar prefs + the function-selection
 * pointers + the embedding dimension lock are writable; provider/apiUrl/
 * model/embedding.* are derived from provider rows. PUT /settings accepts
 * this shape (unknown keys ignored).
 */
export interface SettingsPatch {
  ocrStrategy?: OcrStrategy;
  contactEmail?: string;
  chatProviderId?: string;
  embeddingProviderId?: string;
  embeddingDimensions?: number;
}

/**
 * Resolve the effective chat provider/model/url. Decision #1: if `chatProvider`
 * is unset, mirror the main `provider`/`apiUrl`/`model`. If set but incomplete,
 * fill gaps from `PROVIDER_DEFAULTS[chatProvider]`. Pure + exported so the
 * sidecar and tests share one resolution path.
 */
export function resolveChatConfig(s: Settings): ResolvedChatConfig {
  if (!s.chatProvider) {
    return { provider: s.provider, apiUrl: s.apiUrl, model: s.model };
  }
  const d = PROVIDER_DEFAULTS[s.chatProvider];
  return {
    provider: s.chatProvider,
    apiUrl: (s.chatApiUrl && s.chatApiUrl.trim()) || d.apiUrl,
    model: (s.chatModel && s.chatModel.trim()) || d.defaultModel,
  };
}

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
