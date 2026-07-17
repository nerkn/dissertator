import type { Bindings, ResolvedBindings } from "./functions";
import type { OcrStrategy } from "./sources";

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
 * Chat-flow UX toggles (AgentTab). All default ON. Stored as a single JSON
 * blob under settings key `chatFlow`; partial patches merge onto defaults.
 */
export interface ChatFlowSettings {
  /** Prompts section expanded by default on first open. */
  promptsOpen: boolean;
  /** New chat inherits the previous chat's pinned `contextSources`. */
  inheritPins: boolean;
  /** Opener auto-runs a greeting turn when a new/empty chat is shown. */
  autoGreet: boolean;
  /** After the threshold turn, summarize a title (replaces "New chat"). */
  autoTitle: boolean;
  /** Message count that triggers auto-title (user+assistant turns). */
  autoTitleTurns: number;
}

/** Defaults applied when no `chatFlow` blob is stored yet. */
export const DEFAULT_CHAT_FLOW: ChatFlowSettings = {
  promptsOpen: true,
  inheritPins: true,
  autoGreet: true,
  autoTitle: true,
  autoTitleTurns: 4,
};

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
  /** Chat-flow UX toggles (AgentTab). */
  chatFlow?: ChatFlowSettings;
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
  /** Partial chat-flow patch — merges onto stored values + defaults. */
  chatFlow?: Partial<ChatFlowSettings>;
}
