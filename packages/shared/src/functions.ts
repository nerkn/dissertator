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
