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
/** One persisted tool-call narration beat for an assistant turn. */
export interface ToolTrace {
  name: string;
  args: unknown;
  ok?: boolean;
  summary?: string;
  error?: string;
}

export interface ChatMessage {
  id: string;
  /** FK to the chat this message belongs to. */
  chatId: string;
  role: "user" | "assistant" | "system";
  content: string | null;
  /** Source-file ids the user had open when this message was sent. */
  openFiles: string[];
  /** Tool calls the agent made during this assistant turn (narration). */
  toolCalls?: ToolTrace[];
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
  /**
   * OPENER: auto-greet a new/empty chat. When true, `message` is ignored and
   * no user row is persisted — the server injects an internal opener
   * instruction (greet + propose next steps from the corpus glimpse) and
   * persists only the assistant greeting. Only honored when the chat has no
   * messages yet (defense against re-greeting).
   */
  opener?: boolean;
  /**
   * RETRY: re-run the last user turn. When true, no new user row is inserted
   * (the existing last user row is reused) and the most recent assistant
   * row (the failed/partial one) is deleted first — so the transcript keeps
   * a single user+assistant pair instead of accumulating duplicates.
   */
  retry?: boolean;
}

/**
 * One option offered to the user mid-run via `gui_suggest_replies`. Clicking it sends
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
  | { kind: "suggest_replies"; options: GuiOption[] }
  | { kind: "action"; action: "warn" | "celebrate" | "info"; text: string };
