import type {
  HealthResponse,
  InitProjectResponse,
  ProjectStatus,
  Settings,
  SourceFile,
  SourcesResponse,
} from "@dissertator/shared";

const BASE =
  (import.meta.env.VITE_SIDECAR_URL as string | undefined) ??
  "http://127.0.0.1:4319";

/**
 * Fetch helper. `opts` is spread AFTER the default `Content-Type` header, but
 * caller-supplied headers are merged explicitly so a full `headers` object on
 * `opts` does NOT clobber `Content-Type` (required e.g. for the OCR vision
 * call, which also sends `Authorization`).
 */
async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const { headers: callerHeaders, ...rest } = opts ?? {};
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...callerHeaders },
    ...rest,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text}`.trim());
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => req<HealthResponse>("/health"),
  initProject: (path: string) =>
    req<InitProjectResponse>("/project/init", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  projectStatus: () => req<ProjectStatus>("/project/status"),
  getSettings: () => req<Settings>("/settings"),
  saveSettings: (s: Settings) =>
    req<Settings>("/settings", {
      method: "PUT",
      body: JSON.stringify(s),
    }),

  // --- Ingest surface (Track G+H) -------------------------------------------

  /** All source files + live counts. */
  getSources: () => req<SourcesResponse>("/sources"),

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
};

/** Base URL the SSE EventSource connects to (matches `BASE` above). */
export const SIDECAR_BASE = BASE;

export type { SourceFile, SourcesResponse };
