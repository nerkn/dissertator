import type { AiFunction } from "./functions";

/**
 * Embedding wire format: "openai" = OpenAI-compatible `/embeddings`;
 * "google" = Generative Language API. Derived from a provider's `type` —
 * only `type==="google"` uses the google adapter; every other type
 * (openai/zai/deepseek/openrouter/custom/…) is OpenAI-compatible.
 */
export type EmbedEngine = "openai" | "google" | "local";

/** Pick the embedding wire format from a provider `type`. */
export function adapterFromType(type: string): EmbedEngine {
  if (type === "google") return "google";
  if (type === GRANITE_EMBED_TYPE) return "local";
  return "openai";
}

/** Provider type that means "keyless local OCR" (the only non-LLM type). */
export const TESSERACT_TYPE = "tesseract";

/** Provider type that means "keyless local embeddings" (granite ONNX). */
export const GRANITE_EMBED_TYPE = "local-granite";

/** Fixed model id recorded on the embed binding for the keyless local embedder
 *  (informational — `local.ts` loads a fixed ONNX file regardless, but the
 *  binding notes what produced the vectors). Centralized to avoid drift. */
export const GRANITE_EMBED_MODEL = "granite-embedding-97m-multilingual-r2";

/** True for keyless local providers (no API key, no remote call). */
export function isKeylessProviderType(type: string): boolean {
  return type === TESSERACT_TYPE || type === GRANITE_EMBED_TYPE;
}

/**
 * A generic provider credential row (the POOL). No `kind`, no `model`: a
 * provider is reusable across functions, and `model` lives on the binding.
 * The API key is NOT stored here — it lives in the sidecar's global app DB
 * under `keyUser`.
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

/**
 * Catalog entry used ONLY by the Add-Provider form (prefill name/apiUrl/key
 * link). NOT a provider row, and NOT seeded into the pool. All entries are
 * OpenAI-compatible at the wire level (engine is OpenAI-style only).
 */
export interface ProviderDef {
  id: string;
  label: string;
  apiUrl: string;
  /** "Get an API key" link shown next to the key field. Also marks the
   *  provider as a defined cloud endpoint (fixed apiUrl, key-only entry). */
  keyUrl?: string;
  /** Local/offline catalog entry (Ollama, …) — hidden from Add/Type pickers. */
  local?: boolean;
  /** Suggested keychain slot (legacy-compat: reuse an existing key if present). */
  keyUser: string;
  /** Suggested default model per function, where known. */
  defaults?: Partial<Record<AiFunction, string>>;
}

/** Quick-start catalog for the Add-Provider modal. */
export const PROVIDER_DEFS: ProviderDef[] = [
  // Managed Dissertator Cloud endpoint (OpenAI-compatible reseller). Users
  // only paste an API key — apiUrl + keychain slot are prefilled. Default
  // models use the `sici/<function>` alias scheme exposed by the proxy.
  {
    id: "sici",
    label: "Sici AI",
    apiUrl: "https://aiprovider.sici.dev/v1",
    keyUrl: "https://aiprovider.sici.dev/account",
    keyUser: "sici_api_key",
    defaults: {
      chat: "sici/chat",
      stt: "sici/stt",
      vision_doc: "sici/vision_doc",
      vision_image: "sici/vision_image",
      embed: "sici/embed",
    },
  },
  {
    id: "zai",
    label: "Z.ai",
    apiUrl: "https://api.z.ai/api/paas/v4",
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    keyUser: "zai_api_key",
    defaults: {
      chat: "glm-5.2",
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
    local: true,
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

/**
 * Built-in keyless local embedding provider (granite-embedding-97m onnx).
 * Seeded into the pool as an embed binding; runs fully offline, no API key.
 */
export const GRANITE_EMBED_PROVIDER: {
  id: string;
  name: string;
  type: string;
  apiUrl: string;
  keyUser: string;
  isDefault: boolean;
} = {
  id: "local-granite",
  name: "Local Granite Embeddings",
  type: GRANITE_EMBED_TYPE,
  apiUrl: "",
  keyUser: "",
  isDefault: false,
};
