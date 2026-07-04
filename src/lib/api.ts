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
  Reference,
  SearchResponse,
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

  /** Raw file-byte URL for PDF/image viewing (sidecar streams bytes). */
  fileUrl: (id: string) => `${SIDECAR_BASE}/files/${encodeURIComponent(id)}`,

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
    fetch(`${BASE}/references/export.bibtex`).then((r) => r.text()),

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
  const res = await fetch(`${BASE}/chat`, {
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
        const payload = line.slice(5);
        if (currentEvent === "delta") {
          // `stream.writeSSE` JSON-encodes the data; a single text fragment
          // becomes a quoted string. Strip the wrapping quotes if present.
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

/** Base URL the SSE EventSource connects to (matches `BASE` above). */
export const SIDECAR_BASE = BASE;

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

export type { SourceFile, SourcesResponse };
