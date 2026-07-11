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

/** Fresh per-provider keychain slot for a user-added provider. */
export function providerKeyUser(id: string): string {
  return `dissertator:provider:${id}`;
}

/**
 * Embedding wire format: "openai" = OpenAI-compatible `/embeddings`;
 * "google" = Generative Language API. Derived from a provider's `type` —
 * only `type==="google"` uses the google adapter; every other type
 * (openai/zai/deepseek/openrouter/custom/…) is OpenAI-compatible.
 */
export type EmbedEngine = "openai" | "google";

/** Pick the embedding wire format from a provider `type`. */
export function adapterFromType(type: string): EmbedEngine {
  return type === "google" ? "google" : "openai";
}

// ===========================================================================
// Multi-provider contract (P-multi): generic provider POOL + a FUNCTION ↔
// provider MODEL binding matrix.
//
//   provider   = a reusable OpenAI-compatible credential (name/type/apiUrl/key).
//                No `kind`, no `model` on the row. One key serves many functions.
//   function   = one of five addressable AI jobs (chat/stt/vision_doc/...).
//   binding    = function → {providerId, model}. `model` lives on the binding
//                because one key serves different models per function.
//
// Engine is OpenAI-style ONLY (/chat/completions, /audio/transcriptions,
// /embeddings, /models). `type` on a provider row is branding + a routing hint
// (e.g. "tesseract" selects local OCR); it does NOT branch the wire format.
//
// These types are ADDITIVE during the transition: the legacy Settings /
// PROVIDER_DEFAULTS / EmbeddingConfig machinery is removed once every layer
// migrates onto bindings.
// ===========================================================================

/** The five addressable AI functions. Each has exactly one binding. */
export type AiFunction =
  | "chat"
  | "stt"
  | "vision_doc"
  | "vision_image"
  | "embed";

/** UI matrix order. */
export const AI_FUNCTIONS: AiFunction[] = [
  "chat",
  "stt",
  "vision_doc",
  "vision_image",
  "embed",
];

/** Provider type that means "keyless local OCR" (the only non-LLM type). */
export const TESSERACT_TYPE = "tesseract";

/** Per-function UI metadata + behavior flags shared by frontend & sidecar. */
export const FUNCTION_META: Record<
  AiFunction,
  {
    label: string;
    sublabel: string;
    /** Whether the local-tesseract provider may be selected for this function. */
    allowsTesseract: boolean;
    /** Whether changing the binding has a destructive side effect (re-vectorize). */
    destructiveOnChange: boolean;
  }
> = {
  chat: {
    label: "Chat",
    sublabel: "Assistant chat",
    allowsTesseract: false,
    destructiveOnChange: false,
  },
  stt: {
    label: "STT",
    sublabel: "Audio → text (transcribe)",
    allowsTesseract: false,
    destructiveOnChange: false,
  },
  vision_doc: {
    label: "Vision · docs",
    sublabel: "OCR / understand PDF pages & scans",
    allowsTesseract: true,
    destructiveOnChange: false,
  },
  vision_image: {
    label: "Vision · image",
    sublabel: "Understand a standalone image (jpg/png/webp)",
    allowsTesseract: false,
    destructiveOnChange: false,
  },
  embed: {
    label: "Embed",
    sublabel: "Vectorize chunks",
    allowsTesseract: false,
    destructiveOnChange: true,
  },
};

/** True for keyless local providers (no API key, no remote call). */
export function isKeylessProviderType(type: string): boolean {
  return type === TESSERACT_TYPE;
}

/**
 * A generic provider credential row (the POOL). No `kind`, no `model`: a
 * provider is reusable across functions, and `model` lives on the binding.
 * The API key is NOT stored here — it lives in the OS keychain under `keyUser`.
 */
export interface ProviderRow {
  id: string;
  /** User-given label, e.g. "Work OpenAI". Shown in the Functions dropdowns. */
  name: string;
  /** Branding/routing hint ("openai"|"zai"|"deepseek"|...|"tesseract"). */
  type: string;
  /** Base URL (no trailing slash); "" for keyless local providers. */
  apiUrl: string;
  /** OS keychain slot for this provider's key; "" when keyless. */
  keyUser: string;
  /** True for the single highlighted default (e.g. seeded Z.ai). */
  isDefault: boolean;
  createdAt: string;
}

/** Input shape for POST/PUT /providers. `keyUser` assigned if omitted. */
export interface ProviderInput {
  name: string;
  type: string;
  apiUrl: string;
  /** Optional; defaults to a fresh per-id slot via {@link providerKeyUser}. */
  keyUser?: string;
}

/** The match: one row per function. `model` lives here (per-function). */
export interface FunctionBinding {
  fn: AiFunction;
  providerId: string;
  model: string;
  updatedAt: number;
}

/** All five bindings, keyed by function. */
export type Bindings = Record<AiFunction, FunctionBinding>;

/** A binding joined with its provider's apiUrl/type — what a route needs. */
export interface ResolvedFunction {
  fn: AiFunction;
  providerId: string;
  apiUrl: string;
  model: string;
  type: string;
}

/** All five resolved. */
export type ResolvedBindings = Record<AiFunction, ResolvedFunction>;

/** Body of `PUT /bindings/:fn`. */
export interface BindingPatch {
  providerId: string;
  model: string;
}

/** Result of setting a binding. `revectorized` is true only for embed changes. */
export interface BindingSetResult {
  binding: FunctionBinding;
  revectorized: boolean;
}

/** `GET /providers/:id/models` response (normalized model id list). */
export interface ModelsResponse {
  models: string[];
}

/** `POST /functions/:fn/test` response. */
export interface FunctionTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  /** Optional tiny sample output (e.g. embed dim, a chat token). */
  sample?: string;
}

/**
 * Catalog entry used ONLY by the Add-Provider form (prefill name/apiUrl/key
 * link). NOT a provider row, and NOT seeded into the pool. All entries are
 * OpenAI-compatible at the wire level (engine is OpenAI-style only).
 */
export interface ProviderDef {
  id: string;
  label: string;
  apiUrl: string;
  /** "Get an API key" link shown next to the key field. */
  keyUrl?: string;
  /** Suggested keychain slot (legacy-compat: reuse an existing key if present). */
  keyUser: string;
  /** Suggested default model per function, where known. */
  defaults?: Partial<Record<AiFunction, string>>;
}

/** Quick-start catalog for the Add-Provider modal. */
export const PROVIDER_DEFS: ProviderDef[] = [
  {
    id: "zai",
    label: "Z.ai",
    apiUrl: "https://api.z.ai/api/paas/v4",
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    keyUser: "zai_api_key",
    defaults: {
      chat: "glm-4.6",
      stt: "whisper-1",
      vision_doc: "glm-4v",
      vision_image: "glm-4v",
      embed: "embedding-3",
    },
  },
  {
    id: "openai",
    label: "OpenAI",
    apiUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    keyUser: "openai_api_key",
    defaults: {
      chat: "gpt-4o",
      stt: "whisper-1",
      vision_doc: "gpt-4o-mini",
      vision_image: "gpt-4o",
      embed: "text-embedding-3-small",
    },
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    apiUrl: "https://api.deepseek.com",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyUser: "deepseek_api_key",
    defaults: { chat: "deepseek-chat", stt: "whisper-1" },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    apiUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    keyUser: "openrouter_api_key",
  },
  {
    id: "groq",
    label: "Groq",
    apiUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    keyUser: "groq_api_key",
  },
  {
    id: "together",
    label: "Together",
    apiUrl: "https://api.together.xyz/v1",
    keyUrl: "https://api.together.ai/settings/api-keys",
    keyUser: "together_api_key",
  },
  {
    id: "mistral",
    label: "Mistral",
    apiUrl: "https://api.mistral.ai/v1",
    keyUrl: "https://console.mistral.ai/api-keys",
    keyUser: "mistral_api_key",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    apiUrl: "http://localhost:11434/v1",
    keyUser: "",
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    apiUrl: "",
    keyUser: "",
  },
];

/** Built-in keyless local OCR provider, seeded into the pool (vision_doc only). */
export const TESSERACT_PROVIDER: {
  id: string;
  name: string;
  type: string;
  apiUrl: string;
  keyUser: string;
  isDefault: boolean;
} = {
  id: "local-tesseract",
  name: "Local Tesseract",
  type: TESSERACT_TYPE,
  apiUrl: "",
  keyUser: "",
  isDefault: false,
};

/** User's global OCR engine preference (overridable per file from the UI). */
export type OcrStrategy = "tesseract" | "vision" | "skip";

/**
 * Minimal chat endpoint target: WHERE (`apiUrl`) and WHICH model. The engine
 * is OpenAI-style only, so there is no provider-flavor field — every bound
 * chat provider speaks `/chat/completions`. Built by the sidecar from the
 * resolved `chat` binding; the API key travels separately as a Bearer header.
 */
export interface ChatEndpointConfig {
  apiUrl: string;
  model: string;
}

/**
 * Project-level configuration stored in the project DB
 * (Dissertator/dissertator.db). NOTE: NO API keys live here — they stay in
 * the OS keychain and travel only as request headers at call time.
 *
 * The function ↔ provider MODEL bindings (`bindings` / `resolved`) are the
 * single source of truth for which backend each AI function uses. The flat
 * `chatProviderId` / `embeddingProviderId` pointers are kept for the legacy
 * save-settings path and mirror the bindings.
 */
export interface Settings {
  ocrStrategy: OcrStrategy;
  /**
   * Contact email for Crossref's polite pool. Optional; sent in the
   * `User-Agent` so Crossref routes us through the faster shared-rate-limit
   * pool. A public contact address (NOT a keychain secret). Defaults to `""`.
   */
  contactEmail: string;
  /** Provider row id bound to the `chat` function. */
  chatProviderId?: string;
  /** Provider row id bound to the `embed` function. */
  embeddingProviderId?: string;
  /** Locked embedding dimensionality (0 = vec0 table not created yet). */
  embeddingDimensions?: number;
  /** All five function bindings, populated by `getSettings` once seeded. */
  bindings?: Bindings;
  /** All five bindings resolved with their provider's apiUrl/type. */
  resolved?: ResolvedBindings;
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

// ---------------------------------------------------------------------------
// Lists & notes (collect-while-reading → cite-while-writing)
// ---------------------------------------------------------------------------
//
// While reading a source PDF, the user selects a passage and saves it as a
// Note into one of a small set of Lists. Both the selected text (excerpt)
// and the user's own note (body) are OPTIONAL. Later, when writing, the user
// turns a saved note into a citation `[@citekey:page]` (the citekey is the
// note's source's linked reference). `lists` is the ONE integer-PK table in
// the schema (1-4 seeded); every other id in the app is TEXT.

/** A user list a note can be saved into. Seeded defaults are non-deletable. */
export interface List {
  /** INTEGER primary key (1-4 seeded; auto-increment for user-added). */
  id: number;
  label: string;
  /** Phosphor icon name, rendered dynamically in the UI. */
  icon: string;
  /** Hex accent color for the dot/badge. */
  color: string;
  /** Display order, ascending. */
  ord: number;
  /** true = seeded built-in (non-deletable); false = user-added. */
  system: boolean;
}

/** The 4 predefined lists seeded at project init (ids 1-4, system=true). */
export const LIST_SEEDS: Array<
  Pick<List, "id" | "label" | "icon" | "color" | "ord">
> = [
  { id: 1, label: "Favorites", icon: "Star", color: "#f5a623", ord: 1 },
  { id: 2, label: "Saved", icon: "BookmarkSimple", color: "#4a90e2", ord: 2 },
  { id: 3, label: "Important", icon: "WarningCircle", color: "#e0584c", ord: 3 },
  { id: 4, label: "To revisit", icon: "ArrowUUpLeft", color: "#7b61ff", ord: 4 },
];

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
