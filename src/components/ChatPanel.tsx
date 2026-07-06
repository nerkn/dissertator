// ChatPanel — the freeform, multi-chat agent interface.
//
// A chat is a persisted, document-UNBOUND thread. The user pins a set of
// source files as per-chat context (`contextSources`); each send streams an
// assistant reply (SSE) scoped to that chat. The frontend drives context: it
// sends the chat's pinned source ids as `openFiles` on every `POST /chat`.
//
// Data flow:
//   GET /chats                          → Chat[]           (most-recent first)
//   POST /chats                         → Chat             (create)
//   PUT  /chats/:id {contextSources}    → Chat             (persist picker)
//   GET /chats/:id/messages             → ChatMessage[]    (transcript)
//   POST /chat {chatId, message, openFiles} → SSE stream    (deltas → done)
//   GET /prompts                        → Prompt[]         (from prompts.md)
//
// Quick-fire prompt buttons come from the per-project `Dissertator/prompts.md`
// file; clicking one drops its text into the composer for review/send.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  PaperPlaneTilt,
  Plus,
  PencilSimpleLine,
  Trash,
  StopCircle,
  X,
  Files,
  Lightbulb,
  CaretDown,
  Bug,
  Gear,
} from "@phosphor-icons/react";
import type {
  Chat,
  ChatMessage,
  Document,
  EmbeddingStatus,
  GuiEvent,
  GuiOption,
  Prompt,
  SourceFile,
} from "@dissertator/shared";
import { api, streamChat } from "../lib/api";
import type { DebugEvent } from "../lib/api";

interface Props {
  health: "checking" | "up" | "down";
  configured: boolean;
  apiKey: string;
  sources: SourceFile[];
  /** Document the user is editing (default p_* target; sent each turn). */
  activeDocumentId?: string;
  /** Embedding key for the agent's corpus_* vector tools. */
  embeddingApiKey?: string;
  /** The agent wrote/changed a document — App refreshes its list + live-reloads. */
  onDocumentEdited?: (doc: Document) => void;
  /** The agent asked the UI to open a source viewer (gui_doc_open). */
  onOpenSource?: (sourceId: string) => void;
  /** The agent asked the UI to open a document editor (gui_p_open). */
  onOpenDocument?: (documentId: string) => void;
  /** Open the Settings dialog (used by the not-configured nudge). */
  onOpenSettings?: () => void;
}

/**
 * Imperative API exposed via ref for the parent (App). The New Document
 * button in App needs to (a) start a fresh chat and (b) prefill that chat's
 * composer with the "New document" planning prompt — without App knowing any
 * chat internals or the prompt text. Resolved from the loaded prompts list,
 * with a built-in fallback if the user removed that prompt from prompts.md.
 */
export interface ChatPanelHandle {
  startNewDocumentChat: () => Promise<void>;
}

/** Fallback prompt if the user deleted "New document" from prompts.md. */
const NEW_DOCUMENT_PROMPT_FALLBACK =
  "I just created a new, empty document. Help me plan its structure. Ask me what kind of manuscript this is (journal article, thesis chapter, literature review, conference paper), my topic, and any structure I already have in mind. Then propose a clear heading outline we can refine before writing.";

export const ChatPanel = forwardRef<ChatPanelHandle, Props>(function ChatPanel(
  {
    health,
    configured,
    apiKey,
    sources,
    activeDocumentId,
    embeddingApiKey,
    onDocumentEdited,
    onOpenSource,
    onOpenDocument,
    onOpenSettings,
  },
  ref,
) {
  // --- chats + active chat -------------------------------------------------
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [loadingChats, setLoadingChats] = useState(true);

  const activeChat = useMemo(
    () => chats.find((c) => c.id === activeChatId) ?? null,
    [chats, activeChatId],
  );

  // source id → filename, for context chips + picker labels
  const fileNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sources) m.set(s.id, s.filename);
    return m;
  }, [sources]);

  // Corpus size for the header badge: how many sources exist + how many
  // chunks are embedded (semantic-search readiness). Cheap 5s poll so the
  // badge stays accurate as the user ingests / embeds while chatting. The
  // agent's corpus_list tool sees the same data, so this makes the “what the
  // agent can reach” surface visible to the human too.
  const [embed, setEmbed] = useState<EmbeddingStatus | null>(null);
  useEffect(() => {
    if (health !== "up") return;
    let stopped = false;
    const tick = async (): Promise<void> => {
      try {
        const e = await api.embedStatus();
        if (!stopped) setEmbed(e);
      } catch {
        /* sidecar mid-restart; next tick retries */
      }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [health]);

  const refreshChats = useCallback(async () => {
    try {
      const list = await api.listChats();
      setChats(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  const loadMessages = useCallback(async (chatId: string) => {
    try {
      setMessages(await api.listChatMessages(chatId));
    } catch {
      setMessages([]);
    }
  }, []);

  // First load: chats + prompts once configured. Auto-create a chat if none,
  // so the user always lands on a writable surface.
  useEffect(() => {
    if (!configured) return;
    let stopped = false;
    (async () => {
      setLoadingChats(true);
      const list = await refreshChats();
      try {
        if (!stopped) setPrompts(await api.listPrompts());
      } catch {
        /* prompts.md absent → empty */
      }
      let next = list;
      if (!stopped && next.length === 0) {
        try {
          const created = await api.createChat();
          if (!stopped) {
            next = [created, ...list];
            setChats(next);
          }
        } catch {
          /* ignore — user can retry via New */
        }
      }
      if (!stopped && next.length > 0) setActiveChatId(next[0].id);
      if (!stopped) setLoadingChats(false);
    })();
    return () => {
      stopped = true;
    };
  }, [configured, refreshChats]);

  // Reload messages when the active chat changes.
  useEffect(() => {
    if (activeChatId) void loadMessages(activeChatId);
    else setMessages([]);
  }, [activeChatId, loadMessages]);

  // --- send / stream -------------------------------------------------------
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [liveAssistant, setLiveAssistant] = useState("");
  const [error, setError] = useState<string | null>(null);
  // P5 narration beats for the in-flight assistant turn (tool_call+result pairs).
  const [toolBeats, setToolBeats] = useState<ToolBeat[]>([]);
  // Quick-reply chips the agent offered via gui_options (cleared on next send).
  const [pendingOptions, setPendingOptions] = useState<GuiOption[] | null>(null);
  // Ephemeral non-blocking beats the agent surfaced via gui_action.
  const [toasts, setToasts] = useState<ChatToast[]>([]);
  // Dev: the LLM payloads captured this turn (one per agent step). Rendered in
  // a collapsible panel only in dev builds (`import.meta.env.DEV`).
  const [debugEvents, setDebugEvents] = useState<DebugEvent[]>([]);
  const [debugOpen, setDebugOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const pushToast = useCallback((kind: ChatToast["kind"], text: string) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  // Autoscroll to bottom as the transcript, the live reply, or its tool
  // narration grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, liveAssistant, toolBeats, pendingOptions]);

  const send = useCallback(
    async (overrideText?: string) => {
      const text = (overrideText ?? input).trim();
      if (!text || !activeChatId || streaming) return;
      setError(null);
      setInput("");
      // Stale quick-reply chips disappear the moment the user says anything else.
      setPendingOptions(null);
      setToolBeats([]);
      setDebugEvents([]);

      // Optimistic user bubble (no id); replaced wholesale on reload.
      const optimistic: ChatMessage = {
        id: `pending-${Date.now()}`,
        chatId: activeChatId,
        role: "user",
        content: text,
        openFiles: activeChat?.contextSources ?? [],
        costTokens: null,
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, optimistic]);

      const ac = new AbortController();
      abortRef.current = ac;
      setStreaming(true);
      setLiveAssistant("");

      const result = await streamChat(activeChatId, text, apiKey, {
        openFiles: activeChat?.contextSources ?? [],
        activeDocumentId,
        embeddingApiKey,
        onDelta: (d) => setLiveAssistant((prev) => prev + d),
        onToolCall: (e) =>
          setToolBeats((prev) => [
            ...prev,
            { id: e.id, name: e.name, args: e.args },
          ]),
        onToolResult: (e) =>
          setToolBeats((prev) =>
            prev.map((b) =>
              b.id === e.id
                ? { ...b, ok: e.ok, summary: e.summary, error: e.error }
                : b,
            ),
          ),
        onEdit: (e) => {
          onDocumentEdited?.({
            id: e.documentId,
            title: e.title,
            bodyMd: e.bodyMd,
            // The edit payload carries only id/title/bodyMd; the doc-type
            // fields are not part of the live event. App keeps its existing
            // record for those and only the body/title change in practice.
            docType: null,
            thesis: null,
            researchQuestions: [],
            focusPrompt: null,
            createdAt: Date.now(),
          });
        },
        onGui: (g: GuiEvent) => {
          switch (g.kind) {
            case "doc_open":
              onOpenSource?.(g.sourceId);
              break;
            case "p_open":
              onOpenDocument?.(g.documentId);
              break;
            case "options":
              setPendingOptions(g.options);
              break;
            case "action":
              pushToast(g.action, g.text);
              break;
          }
        },
        onDebug: (e) => setDebugEvents((prev) => [...prev, e]),
        signal: ac.signal,
      });

      setStreaming(false);
      setLiveAssistant("");
      setToolBeats([]);
      abortRef.current = null;

      if (result.error && !result.aborted) {
        setError(result.error);
      } else if (result.capped) {
        pushToast("warn", "Agent hit its step cap — it may not have finished.");
      }
      // Reload canonical state (server persisted both turns, even on abort).
      await loadMessages(activeChatId);
    },
    [
      input,
      activeChatId,
      streaming,
      activeChat,
      apiKey,
      loadMessages,
      activeDocumentId,
      embeddingApiKey,
      onDocumentEdited,
      onOpenSource,
      onOpenDocument,
      pushToast,
    ],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Flush an in-flight stream if the user switches chat mid-reply.
  const selectChat = useCallback(
    (id: string) => {
      if (streaming) abortRef.current?.abort();
      setActiveChatId(id);
    },
    [streaming],
  );

  const newChat = useCallback(async () => {
    try {
      const c = await api.createChat();
      setChats((prev) => [c, ...prev]);
      selectChat(c.id);
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  }, [selectChat]);

  /**
   * New Document flow (App → ChatPanel): create a fresh chat, switch to it,
   * and prefill the composer with the "New document" planning prompt. Used by
   * App's New Document button so the user lands in a chat ready to plan the
   * doc they just created. The prompt is resolved from the loaded prompts
   * list (so it tracks user edits to prompts.md); falls back to a constant if
   * the user deleted that entry.
   */
  const startNewDocumentChat = useCallback(async () => {
    try {
      const c = await api.createChat();
      setChats((prev) => [c, ...prev]);
      selectChat(c.id);
      const found = prompts.find(
        (p) => p.label.toLowerCase() === "new document"
      );
      setInput(found?.prompt ?? NEW_DOCUMENT_PROMPT_FALLBACK);
      // Focus after the new-chat re-render enables the textarea.
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  }, [prompts, selectChat]);

  // Expose the imperative API to the parent (App's New Document button).
  useImperativeHandle(ref, () => ({ startNewDocumentChat }), [
    startNewDocumentChat,
  ]);

  const renameChat = useCallback(async () => {
    if (!activeChat) return;
    const title = window.prompt("Chat title", activeChat.title);
    if (title == null) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const updated = await api.updateChat(activeChat.id, { title: trimmed });
      setChats((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  }, [activeChat]);

  const deleteChat = useCallback(async () => {
    if (!activeChat) return;
    if (!window.confirm(`Delete chat "${activeChat.title}"?`)) return;
    const id = activeChat.id;
    try {
      await api.deleteChat(id);
      setChats((prev) => {
        const remaining = prev.filter((c) => c.id !== id);
        // Fall through to the next chat, or auto-create if the last one was
        // deleted (never leave the user with a blank panel).
        if (remaining.length > 0) {
          setActiveChatId(remaining[0].id);
        } else {
          setActiveChatId(null);
          void api
            .createChat()
            .then((c) => setChats([c]))
            .then(() => {});
        }
        return remaining;
      });
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  }, [activeChat]);

  // --- context picker ------------------------------------------------------
  const [pickerOpen, setPickerOpen] = useState(false);
  // Prompts section: collapsed by default so the composer stays the focus.
  // Each click of the header toggles; selecting a prompt keeps it open.
  const [promptsOpen, setPromptsOpen] = useState(false);

  const toggleSource = useCallback(
    async (sourceId: string) => {
      if (!activeChat) return;
      const has = activeChat.contextSources.includes(sourceId);
      const next = has
        ? activeChat.contextSources.filter((s) => s !== sourceId)
        : [...activeChat.contextSources, sourceId];
      // Optimistic local update; persist behind it.
      setChats((prev) =>
        prev.map((c) =>
          c.id === activeChat.id ? { ...c, contextSources: next } : c,
        ),
      );
      try {
        await api.updateChat(activeChat.id, { contextSources: next });
      } catch (e) {
        setError((e as Error)?.message ?? String(e));
        // Revert on failure.
        setChats((prev) =>
          prev.map((c) =>
            c.id === activeChat.id
              ? { ...c, contextSources: activeChat.contextSources }
              : c,
          ),
        );
      }
    },
    [activeChat],
  );

  // ------------------------------------------------------------------- render
  if (health !== "up") {
    return (
      <aside className="panel chat">
        <div className="panel-title">💬 Chat</div>
        <div className="warn">
          Sidecar not running. Start it with <code>pnpm dev:sidecar</code>.
        </div>
      </aside>
    );
  }
  if (!configured) {
    return (
      <aside className="panel chat">
        <div className="panel-title">💬 Chat</div>
        <div className="warn">
          No chat provider with an API key yet.
          <div className="muted small" style={{ marginTop: 4 }}>
            Open <strong>⚙ Settings → Functions</strong> and assign a chat
            provider that has a key.
          </div>
          {onOpenSettings && (
            <button
              type="button"
              className="btn small primary"
              style={{ marginTop: 8 }}
              onClick={onOpenSettings}
            >
              <Gear size={14} weight="bold" />
              Open Settings
            </button>
          )}
        </div>
      </aside>
    );
  }

  // One-line corpus summary for the header: source count + embedding
  // readiness. Mirrors what corpus_list reports so the human and the agent
  // share the same picture of “what's reachable”.
  const corpusLine = (() => {
    const n = sources.length;
    const parts = [`${n} source${n === 1 ? "" : "s"}`];
    if (embed) {
      if (!embed.vecLoaded) parts.push("embeddings off");
      else if (embed.total > 0)
        parts.push(`${embed.done}/${embed.total} embedded`);
      else parts.push("not embedded");
    }
    return parts.join(" · ");
  })();

  return (
    <aside className="panel chat">
      <div className="chat-head">
        <div className="panel-title">💬 Chat</div>
        <div className="chat-head-actions">
          <button
            type="button"
            className="tb small"
            title="New chat"
            onClick={newChat}
          >
            <Plus size={14} weight="bold" />
          </button>
          <button
            type="button"
            className="tb small"
            title="Rename chat"
            onClick={renameChat}
            disabled={!activeChat}
          >
            <PencilSimpleLine size={14} weight="bold" />
          </button>
          <button
            type="button"
            className="tb small danger"
            title="Delete chat"
            onClick={deleteChat}
            disabled={!activeChat}
          >
            <Trash size={14} weight="bold" />
          </button>
        </div>
      </div>
      <div className="chat-corpus muted small" title="What the agent can reach via corpus_list">
        📚 {corpusLine}
      </div>

      {loadingChats ? (
        <div className="muted small chat-empty">Loading…</div>
      ) : (
        <>
          <select
            className="chat-select"
            value={activeChatId ?? ""}
            onChange={(e) => selectChat(e.target.value)}
          >
            {chats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>

          {/* Context picker — the per-chat pinned source set. */}
          <div className="chat-context">
            <button
              type="button"
              className="chat-context-toggle"
              onClick={() => setPickerOpen((v) => !v)}
            >
              <Files size={13} weight="bold" />
              {activeChat && activeChat.contextSources.length > 0
                ? `${activeChat.contextSources.length} source${
                    activeChat.contextSources.length > 1 ? "s" : ""
                  } in context`
                : "No context (corpus-wide)"}
            </button>
            {activeChat && activeChat.contextSources.length > 0 && (
              <div className="chat-chips">
                {activeChat.contextSources.map((id) => (
                  <span key={id} className="chip" title={id}>
                    {fileNames.get(id) ?? id.slice(0, 8)}
                    <button
                      type="button"
                      className="chip-x"
                      onClick={() => toggleSource(id)}
                      aria-label={`Remove ${fileNames.get(id) ?? id}`}
                    >
                      <X size={10} weight="bold" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {pickerOpen && (
              <div className="chat-picker">
                <div className="chat-picker-head">
                  <span className="muted small">Pin sources to this chat</span>
                  <button
                    type="button"
                    className="tb small"
                    title="Close"
                    onClick={() => setPickerOpen(false)}
                  >
                    <X size={12} weight="bold" />
                  </button>
                </div>
                {sources.length === 0 ? (
                  <div className="muted small chat-picker-empty">
                    No sources ingested yet.
                  </div>
                ) : (
                  <ul className="chat-picker-list">
                    {sources.map((s) => {
                      const on =
                        activeChat?.contextSources.includes(s.id) ?? false;
                      return (
                        <li key={s.id}>
                          <label className="chat-picker-item">
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => toggleSource(s.id)}
                            />
                            <span className="chat-picker-name" title={s.relPath}>
                              {s.filename}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Transcript. */}
          <div className="chat-transcript" ref={scrollRef}>
            {messages.length === 0 && !streaming && (
              <div className="muted small chat-empty">
                Ask anything about your corpus. Pin sources above to ground the
                reply.
              </div>
            )}
            {messages.map((m) => (
              <MessageBubble key={m.id} msg={m} />
            ))}
            {streaming && (
              <LiveAssistantBubble
                text={liveAssistant}
                beats={toolBeats}
              />
            )}
          </div>

          {/* Dev debug: the exact LLM payload per agent step. Shown only in
              dev builds so it never clutters a real writing session. */}
          {import.meta.env.DEV && debugEvents.length > 0 && (
            <DevDebugPanel
              events={debugEvents}
              open={debugOpen}
              onToggle={() => setDebugOpen((v) => !v)}
              streaming={streaming}
            />
          )}

          {/* Quick-reply chips the agent offered via gui_options. Persist
              after the turn until the user sends anything else (stale then). */}
          {pendingOptions && pendingOptions.length > 0 && !streaming && (
            <div className="option-chips">
              {pendingOptions.map((o, i) => (
                <button
                  key={i}
                  type="button"
                  className="option-chip"
                  title={o.prompt}
                  onClick={() => void send(o.prompt)}
                >
                  {o.short}
                </button>
              ))}
            </div>
          )}

          {/* Ephemeral agent beats (gui_action): warn / celebrate / info. */}
          {toasts.length > 0 && (
            <div className="chat-toasts">
              {toasts.map((t) => (
                <div
                  key={t.id}
                  className={`chat-toast ${t.kind}`}
                  onClick={() =>
                    setToasts((prev) => prev.filter((x) => x.id !== t.id))
                  }
                >
                  {t.text}
                </div>
              ))}
            </div>
          )}

          {/* Prompts — quick-fire buttons from prompts.md. Collapsible
              (collapsed by default) so they don't crowd the composer. */}
          {prompts.length > 0 && (
            <div className="chat-prompts">
              <button
                type="button"
                className={`chat-prompts-toggle${promptsOpen ? " open" : ""}`}
                onClick={() => setPromptsOpen((v) => !v)}
                aria-expanded={promptsOpen}
                title={promptsOpen ? "Hide prompts" : "Show prompts"}
              >
                <Lightbulb size={12} weight="bold" />
                Prompts
                <span className="chat-prompts-count">
                  {prompts.length}
                </span>
                <CaretDown
                  size={12}
                  weight="bold"
                  className="chat-prompts-caret"
                />
              </button>
              {promptsOpen && (
                <div className="chat-prompts-row">
                  {prompts.map((p, i) => (
                    <button
                      key={i}
                      type="button"
                      className="prompt-btn"
                      title={p.prompt}
                      onClick={() => {
                        setInput(p.prompt);
                        inputRef.current?.focus();
                      }}
                    >
                      {p.category ? `${p.category}: ` : ""}
                      {p.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="warn small" onClick={() => setError(null)}>
              {error}
            </div>
          )}

          {/* Composer. */}
          <div className="chat-composer">
            <textarea
              ref={inputRef}
              className="chat-input"
              placeholder={
                activeChat ? "Message the agent…  (Enter to send)" : ""
              }
              value={input}
              disabled={!activeChat}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
            />
            {streaming ? (
              <button
                type="button"
                className="btn stop"
                onClick={stop}
                title="Stop generating"
              >
                <StopCircle size={16} weight="bold" />
              </button>
            ) : (
              <button
                type="button"
                className="btn primary"
                onClick={() => void send()}
                disabled={!activeChat || !input.trim()}
                title="Send (Enter)"
              >
                <PaperPlaneTilt size={16} weight="bold" />
              </button>
            )}
          </div>
        </>
      )}
    </aside>
  );
});

/** One narration beat: a tool_call awaiting/with its tool_result. */
interface ToolBeat {
  id: string;
  name: string;
  args: unknown;
  ok?: boolean;
  summary?: string;
  error?: string;
}

/** Ephemeral gui_action surface. */
interface ChatToast {
  id: string;
  kind: "warn" | "celebrate" | "info";
  text: string;
}

/** Human label for a tool call: `p_write` → “editing manuscript”, etc. */
function toolVerb(name: string): string {
  switch (name) {
    case "corpus_list":
      return "searching corpus";
    case "corpus_write":
      return "noting to corpus";
    case "doc_read":
      return "reading source";
    case "p_read":
      return "reading manuscript";
    case "p_create":
      return "creating document";
    case "p_write":
      return "editing manuscript";
    case "p_insert":
      return "inserting text";
    case "gui_doc_open":
    case "gui_p_open":
      return "opening";
    case "gui_options":
      return "asking";
    case "gui_action":
      return "noting";
    default:
      return name;
  }
}

/** The in-flight assistant bubble: tool narration beats above the streamed text. */
function LiveAssistantBubble({
  text,
  beats,
}: {
  text: string;
  beats: ToolBeat[];
}) {
  return (
    <div className="msg msg-assistant live">
      <div className="msg-role">Agent</div>
      {beats.length > 0 && (
        <div className="tool-beats">
          {beats.map((b) => (
            <div
              key={b.id}
              className={`tool-beat${
                b.ok === undefined
                  ? ""
                  : b.ok
                    ? " ok"
                    : " err"
              }`}
            >
              <span className="tool-beat-verb">{toolVerb(b.name)}</span>
              {b.ok === false && b.error ? (
                <span className="tool-beat-detail">— {b.error}</span>
              ) : b.summary ? (
                <span className="tool-beat-detail">— {b.summary}</span>
              ) : (
                <span className="tool-beat-detail muted">…</span>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="msg-body">{text || "…"}</div>
    </div>
  );
}

/** One transcript row. `live` flags the in-flight assistant stream. */
function MessageBubble({
  msg,
  live = false,
}: {
  msg: ChatMessage;
  live?: boolean;
}) {
  const isUser = msg.role === "user";
  return (
    <div className={`msg ${isUser ? "msg-user" : "msg-assistant"}${live ? " live" : ""}`}>
      <div className="msg-role">{isUser ? "You" : "Agent"}</div>
      <div className="msg-body">
        {msg.content || (live ? "…" : "")}
      </div>
    </div>
  );
}

/**
 * Dev-only panel: shows exactly what was sent to the LLM each agent step
 * (model config, advertised tools, and the full message array). Collapsed by
 * default; the header carries a live step counter. Rendered only when
 * `import.meta.env.DEV` so production builds stay clean.
 */
function DevDebugPanel({
  events,
  open,
  onToggle,
  streaming,
}: {
  events: DebugEvent[];
  open: boolean;
  onToggle: () => void;
  streaming: boolean;
}) {
  const last = events[events.length - 1];
  return (
    <div className={`dev-debug${open ? " open" : ""}`}>
      <button
        type="button"
        className="dev-debug-head"
        onClick={onToggle}
        aria-expanded={open}
      >
        <Bug size={12} weight="bold" />
        <span>LLM debug</span>
        <span className="dev-debug-steps">
          {events.length} step{events.length === 1 ? "" : "s"}
          {streaming ? "…" : ""}
        </span>
        {last && (
          <span className="dev-debug-model" title={last.config.apiUrl}>
            {last.config.model}
          </span>
        )}
        <CaretDown size={12} weight="bold" className="dev-debug-caret" />
      </button>
      {open && (
        <div className="dev-debug-body">
          {events.map((e) => (
            <details key={e.step} className="dev-debug-step">
              <summary>
                step {e.step} · {e.config.model} · {e.tools.length} tools ·{" "}
                {e.messages.length} msgs
                <span className="muted">
                  {" "}
                  [{e.messages.map((m) => String(m.role)).join(" →")}]
                </span>
              </summary>
              <pre className="dev-debug-pre">{JSON.stringify(e, null, 2)}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
