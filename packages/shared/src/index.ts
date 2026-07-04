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
