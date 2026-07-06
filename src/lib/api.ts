import type {
  Chat,
  ChatMessage,
  DocType,
  Document,
  EmbeddingStatus,
  GuiEvent,
  HealthResponse,
  InitProjectResponse,
  ProjectStatus,
  Prompt,
  ProviderConfig,
  ProviderKind,
  Reference,
  SearchResponse,
  Settings,
  SettingsPatch,
  SourceFile,
  SourcesResponse,
} from "@dissertator/shared";
import { SIDECAR_PORT, SIDECAR_PORT_RANGE } from "@dissertator/shared";

/**
 * Sidecar base URL. Resolved lazily:
 *   1. explicit `VITE_SIDECAR_URL` env override wins;
 *   2. otherwise we scan `SIDECAR_PORT..SIDECAR_PORT+SIDECAR_PORT_RANGE`,
 *      hitting `/health` on each until the sidecar answers, then cache it;
 *   3. as a last resort we fall back to the preferred port so the UI shows
 *      its usual connection error rather than a wrong-URL one.
 *
 * The sidecar binds the first free port in that same range, so a busy
 * preferred port never blocks the app from starting.
 */
const PREFERRED_BASE = `http://127.0.0.1:${SIDECAR_PORT}`;
const envBase = import.meta.env.VITE_SIDECAR_URL as string | undefined;
let resolvedBase: string | null = envBase ?? null;

const baseForPort = (p: number) => `http://127.0.0.1:${p}`;

async function probeSidecar(base: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${base}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    // Confirm it's our sidecar (not some other app squatting on the port)
    // by checking the documented HealthResponse shape.
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
    } | null;
    return !!body?.ok;
  } catch {
    return false;
  }
}

/**
 * Scan the sidecar port range for a live server and cache its base URL.
 * Idempotent — subsequent calls return the cached value. Callers (the App
 * health poller) should `await resolveSidecarBase()` before issuing requests.
 *
 * Resolution order:
 *   1. explicit `VITE_SIDECAR_URL` env override (cached at module load);
 *   2. the port Tauri hands us over IPC — Tauri owns the sidecar process, so
 *      this is authoritative and never ambiguous, even with many app windows
 *      each running their own sidecar on a different port;
 *   3. web/standalone fallback: probe `/health` across the port range.
 */
export async function resolveSidecarBase(): Promise<string> {
  if (resolvedBase) return resolvedBase;

  // 2. Tauri spawned the sidecar and knows its port — trust it directly.
  const tauri = await baseFromTauri();
  if (tauri) {
    resolvedBase = tauri;
    return tauri;
  }

  // 3. Not under Tauri (e.g. `dev:web` + a standalone `dev:sidecar`) — scan.
  for (let p = SIDECAR_PORT; p < SIDECAR_PORT + SIDECAR_PORT_RANGE; p++) {
    const base = baseForPort(p);
    if (await probeSidecar(base)) {
      resolvedBase = base;
      return base;
    }
  }
  // Nothing answered yet (sidecar may still be booting). Return the
  // preferred base WITHOUT caching so the next poll re-scans the range
  // and picks up the sidecar once it's up — possibly on a shifted port.
  return PREFERRED_BASE;
}

/** Ask Tauri for the sidecar port. Returns null under web (no Tauri runtime). */
async function baseFromTauri(): Promise<string | null> {
  try {
    const { ipc } = await import("../ipc");
    const port = await ipc.sidecarPort();
    if (typeof port === "number" && port > 0) return `http://127.0.0.1:${port}`;
    return null;
  } catch {
    return null;
  }
}

/**
 * Drop any cached base so the next `resolveSidecarBase()` re-scans. Call when
 * the sidecar is known to be down (e.g. health failed) so a restart on a
 * shifted port is picked up. An explicit `VITE_SIDECAR_URL` override is
 * always honored and never cleared.
 */
export function resetSidecarBase(): void {
  if (!envBase) resolvedBase = null;
}

/** Current sidecar base URL (preferred port until `resolveSidecarBase()` runs). */
function base(): string {
  return resolvedBase ?? PREFERRED_BASE;
}

/** Stable base URL for SSE/file-URL callers (resolved after health probe). */
export function sidecarBase(): string {
  return base();
}

/**
 * Fetch helper. `opts` is spread AFTER the default `Content-Type` header, but
 * caller-supplied headers are merged explicitly so a full `headers` object on
 * `opts` does NOT clobber `Content-Type` (required e.g. for the OCR vision
 * call, which also sends `Authorization`).
 */
async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const { headers: callerHeaders, ...rest } = opts ?? {};
  const res = await fetch(`${base()}${path}`, {
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
  saveSettings: (patch: SettingsPatch) =>
    req<Settings>("/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  // --- Providers (P6) ------------------------------------------------------
  // Named, user-editable provider rows. The frontend builds the list; the
  // Functions tab assigns chat-kind → chat, embedding-kind → vectorizer.
  // Keys live in the OS keychain under each row's keyUser (frontend-managed).

  listProviders: () => req<ProviderConfig[]>("/providers"),
  createProvider: (input: {
    name: string;
    kind: ProviderKind;
    type: ProviderConfig["type"];
    apiUrl?: string;
    model?: string;
    isDefault?: boolean;
  }) =>
    req<ProviderConfig>("/providers", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateProvider: (
    id: string,
    patch: {
      name?: string;
      kind?: ProviderKind;
      type?: ProviderConfig["type"];
      apiUrl?: string;
      model?: string;
      isDefault?: boolean;
    },
  ) =>
    req<ProviderConfig>(`/providers/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  deleteProvider: (id: string) =>
    req<{ ok: true }>(`/providers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  // --- Working-docs persistence (UI tabs) ----------------------------------

  getUiTabs: () =>
    req<{ tabs: Array<{ sourceId: string; kind: string; title: string }>; activeTabId: string | null }>("/ui/tabs"),
  saveUiTabs: (
    tabs: Array<{ sourceId: string; kind: string; title: string }>,
    activeTabId: string | null,
  ) =>
    req<{ ok: true }>("/ui/tabs", {
      method: "PUT",
      body: JSON.stringify({ tabs, activeTabId }),
    }),

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

  // --- References (P2 Track 3) ---------------------------------------------

  listReferences: (sourceFileId?: string) =>
    req<Reference[]>(
      "/references" +
        (sourceFileId
          ? `?source_file_id=${encodeURIComponent(sourceFileId)}`
          : ""),
    ),
  createReference: (ref: Partial<Reference>) =>
    req<Reference>("/references", {
      method: "POST",
      body: JSON.stringify(ref),
    }),
  /** Resolve a reference by id OR citekey. `GET /references/:idOrCitekey`
   *  accepts either, so a `[@citekey:page]` token resolves directly. Returns
   *  the full record incl. `source_file_id` (null for fileless refs). */
  getReference: (idOrCitekey: string) =>
    req<Reference>(`/references/${encodeURIComponent(idOrCitekey)}`),
  updateReference: (id: string, ref: Partial<Reference>) =>
    req<Reference>(`/references/${id}`, {
      method: "PUT",
      body: JSON.stringify(ref),
    }),
  deleteReference: (id: string) =>
    req<{ ok: true }>(`/references/${id}`, { method: "DELETE" }),
  /** Crossref DOI → reference. Polite-pool email read from settings server-side. */
  lookupDoi: (doi: string) =>
    req<Reference | null>("/references/lookup-doi", {
      method: "POST",
      body: JSON.stringify({ doi }),
    }),
  /** Crossref free-text search → candidate references. */
  lookupReference: (query: string) =>
    req<Reference[]>("/references/lookup", {
      method: "POST",
      body: JSON.stringify({ query }),
    }),
  /** Import a .bib string → parsed references (upserted). */
  importBibtex: (bibtex: string) =>
    req<Reference[]>("/references/import-bibtex", {
      method: "POST",
      body: JSON.stringify({ text: bibtex }),
    }),
  /** Export all references as a .bib string. */
  exportBibtex: () =>
    fetch(`${base()}/references/export.bibtex`).then((r) => r.text()),

  /** Render a manuscript (as HTML) to PDF / DOCX / DOC via headless
   *  LibreOffice on the sidecar. Returns the converted file as a Blob.
   *  (Browser fallback path — Tauri webviews swallow blob-URL downloads, so
   *  prefer {@link exportDocumentToPath} there.) */
  exportDocument: (
    html: string,
    format: "pdf" | "docx" | "doc",
    title?: string,
  ) =>
    fetch(`${base()}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html, format, title }),
    }).then(async (r) => {
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error ?? `export failed (${r.status})`);
      }
      return r.blob();
    }),

  /** Same conversion, but write the result to an absolute `outPath` (chosen
   *  via a Tauri Save dialog). Returns the path written. Reliable in the
   *  Tauri webview, unlike the blob-download path. */
  exportDocumentToPath: (
    html: string,
    format: "pdf" | "docx" | "doc",
    outPath: string,
    title?: string,
  ) =>
    fetch(`${base()}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html, format, title, outPath }),
    }).then(async (r) => {
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error ?? `export failed (${r.status})`);
      }
      return (await r.json()) as { ok: true; path: string };
    }),

  // --- Documents (P3 editor) -----------------------------------------------
  // The manuscript editor loads a document (with bodyMd) and autosaves the body
  // via PUT /documents/:id { bodyMd }. A document is a single body — markdown
  // headers are just lines in it, not separate rows.

  /** List all documents (each with bodyMd). */
  listDocuments: () => req<Document[]>("/documents"),

  /** Create a document with an empty body. `title` required. */
  createDocument: (input: {
    title: string;
    docType?: DocType;
    thesis?: string;
    researchQuestions?: string[];
    focusPrompt?: string;
  }) =>
    req<Document>("/documents", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** Full document (including bodyMd). */
  getDocument: (id: string) =>
    req<Document>(`/documents/${encodeURIComponent(id)}`),

  /** Partial patch. Omit a field to keep it; pass null to clear. `bodyMd` may
   *  be set to "" explicitly (empty body) — omit to keep the current body. */
  updateDocument: (
    id: string,
    patch: Partial<{
      title: string;
      docType: DocType | null;
      thesis: string | null;
      researchQuestions: string[];
      focusPrompt: string | null;
      bodyMd: string;
    }>,
  ) =>
    req<Document>(`/documents/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  deleteDocument: (id: string) =>
    req<{ ok: true }>(`/documents/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  // --- Chats (P3 Track E) --------------------------------------------------
  // A chat is a freeform, persisted thread (NOT bound to a document). The user
  // pins a set of source files as per-chat context (`contextSources`); each
  // message belongs to a chat. `POST /chat` streams an assistant reply and
  // persists both turns scoped to the chat.

  /** List chats, most-recently-touched first. */
  listChats: () => req<Chat[]>("/chats"),

  /** Create a chat. `title`/`contextSources` optional (defaults applied). */
  createChat: (input?: { title?: string; contextSources?: string[] }) =>
    req<Chat>("/chats", { method: "POST", body: JSON.stringify(input ?? {}) }),

  getChat: (id: string) => req<Chat>(`/chats/${encodeURIComponent(id)}`),

  /** Partial patch (omit to keep; pass to set). Stamps `updatedAt`. */
  updateChat: (
    id: string,
    patch: { title?: string; contextSources?: string[] },
  ) =>
    req<Chat>(`/chats/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  deleteChat: (id: string) =>
    req<{ ok: true }>(`/chats/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  /** A chat's messages, oldest-first (transcript replay). */
  listChatMessages: (chatId: string, limit?: number) =>
    req<ChatMessage[]>(
      `/chats/${encodeURIComponent(chatId)}/messages` +
        (limit ? `?limit=${limit}` : ""),
    ),

  // --- Predefined prompts (per-project prompts.md) -------------------------

  /** Parsed quick-fire prompts from `Dissertator/prompts.md` ([] if absent). */
  listPrompts: () => req<Prompt[]>("/prompts"),

  /** Raw `prompts.md` markdown ("" if absent) — seeds the Prompts-tab editor. */
  getPromptsMarkdown: () => req<string>("/prompts/raw"),

  /** Overwrite `prompts.md`; returns the re-parsed Prompt[] quick-pick list. */
  savePromptsMarkdown: (markdown: string) =>
    req<Prompt[]>("/prompts", {
      method: "PUT",
      body: JSON.stringify({ markdown }),
    }),
};

/** Stream a chat completion from `POST /chat` (P5 agent loop).
 *
 *  `chatId` is REQUIRED (the turn is scoped to that chat). The chat API key
 *  travels as a Bearer header; the EMBEDDING key (for the agent's corpus_*
 *  vector tools) travels as `X-Embedding-Key`. The stream is an agent loop,
 *  not a single round-trip: alongside `delta` (text) you may receive
 *  `tool_call` / `tool_result` (narration), `edit` (the agent wrote a
 *  document — pass to the editor for a live reload), and `gui` (open a
 *  viewer, offer option chips, show a non-blocking beat). The stream ends
 *  with `done` (ids + usage + toolCalls + capped) or `error`.
 *
 *  `onDelta` is called per text fragment; the granular callbacks fire for
 *  the other event types. `signal` aborts the run. Returns the parsed
 *  `done`/`error` payload. */
export async function streamChat(
  chatId: string,
  message: string,
  apiKey: string,
  opts: {
    openFiles?: string[];
    /** Document the user is editing (default target for p_read/p_write/p_insert). */
    activeDocumentId?: string;
    /** Embedding key for the agent's corpus_* vector tools (`X-Embedding-Key`). */
    embeddingApiKey?: string;
    onDelta?: (text: string) => void;
    onToolCall?: (e: ToolCallEvent) => void;
    onToolResult?: (e: ToolResultEvent) => void;
    onEdit?: (e: EditEvent) => void;
    onGui?: (e: GuiEvent) => void;
    /** Dev: the exact payload sent to the LLM each agent step (config +
     *  messages + tool list). Surfaced so a dev panel can show "what we sent". */
    onDebug?: (e: DebugEvent) => void;
    signal?: AbortSignal;
  },
): Promise<{
  userMessageId?: string;
  assistantMessageId?: string;
  aborted?: boolean;
  error?: string;
  toolCalls?: number;
  capped?: boolean;
}> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (opts.embeddingApiKey) headers["X-Embedding-Key"] = opts.embeddingApiKey;
  const res = await fetch(`${base()}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      chatId,
      message,
      openFiles: opts.openFiles ?? [],
      ...(opts.activeDocumentId ? { activeDocumentId: opts.activeDocumentId } : {}),
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    return { error: `${res.status} ${text}`.trim() };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result: Record<string, unknown> = {};
  let currentEvent = "message";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        // Hono's `writeSSE` emits `data: <value>` — a space AFTER the colon
        // — and does NOT JSON-encode string data (objects only). So we must
        // strip both `data:` and the single separating space. Using slice(5)
        // alone left the leading space, injecting one space per delta —
        // invisible for chunky final-answer text, but with token-by-token
        // reasoning (esp. Turkish's tiny BPE tokens) it put spaces INSIDE
        // every word (e.g. "dos yas ını").
        const payload = line.replace(/^data:\s?/, "");
        if (currentEvent === "delta") {
          // If the fragment happens to be a JSON-quoted string, unwrap it.
          let text = payload;
          try {
            const parsed = JSON.parse(payload);
            if (typeof parsed === "string") text = parsed;
          } catch {
            /* not JSON — use raw payload */
          }
          opts.onDelta?.(text);
        } else if (currentEvent === "tool_call") {
          try {
            const e = JSON.parse(payload) as ToolCallEvent;
            opts.onToolCall?.(e);
          } catch {
            /* ignore malformed */
          }
        } else if (currentEvent === "tool_result") {
          try {
            const e = JSON.parse(payload) as ToolResultEvent;
            opts.onToolResult?.(e);
          } catch {
            /* ignore malformed */
          }
        } else if (currentEvent === "edit") {
          try {
            const e = JSON.parse(payload) as EditEvent;
            opts.onEdit?.(e);
          } catch {
            /* ignore malformed */
          }
        } else if (currentEvent === "gui") {
          try {
            const e = JSON.parse(payload) as GuiEvent;
            opts.onGui?.(e);
          } catch {
            /* ignore malformed */
          }
        } else if (currentEvent === "debug") {
          try {
            const e = JSON.parse(payload) as DebugEvent;
            opts.onDebug?.(e);
          } catch {
            /* ignore malformed */
          }
        } else if (currentEvent === "done" || currentEvent === "error") {
          try {
            result = JSON.parse(payload);
          } catch {
            /* ignore */
          }
        }
      }
      currentEvent = line === "" ? "message" : currentEvent;
    }
  }
  return result as {
    userMessageId?: string;
    assistantMessageId?: string;
    aborted?: boolean;
    error?: string;
  };
}

// Base URL helpers are exported above (`sidecarBase`, `resolveSidecarBase`).

// P5 agent-loop SSE event payloads (see sidecar agent/loop.ts + index.ts).

/** `tool_call` event: the model invoked a tool. */
export interface ToolCallEvent {
  id: string;
  name: string;
  args: unknown;
}

/** `tool_result` event: the tool's outcome (paired with a `tool_call` by id). */
export interface ToolResultEvent {
  id: string;
  name: string;
  ok: boolean;
  summary: string;
  error?: string;
}

/** `edit` event: the agent mutated a document; live-reload the editor. */
export interface EditEvent {
  documentId: string;
  title: string;
  bodyMd: string;
}

/** `debug` event (dev): the exact payload sent to the LLM for one agent step.
 *  `messages` mirrors the OpenAI shape (role/content; assistant turns may
 *  carry `tool_calls`; `tool`-role results carry `tool_call_id`). */
export interface DebugEvent {
  step: number;
  config: { provider: string; apiUrl: string; model: string };
  toolChoice?: string;
  tools: string[];
  messages: Array<Record<string, unknown>>;
}

export type { SourceFile, SourcesResponse };
