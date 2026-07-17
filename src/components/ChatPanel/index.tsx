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
  Gear,
  ArrowClockwise,
} from "@phosphor-icons/react";
import type {
  Chat,
  ChatMessage,
  Document,
  EmbeddingStatus,
  GuiEvent,
  GuiOption,
  Prompt,
} from "@dissertator/shared";
import { DEFAULT_CHAT_FLOW } from "@dissertator/shared";
import { api, streamChat } from "../../lib/api";
import type { DebugEvent } from "../../lib/api";
import { useActiveDocumentId } from "../../lib/stores/tabs";
import { useContentStore, useSourceItems } from "../../lib/stores/content";
import { useSessionStore } from "../../lib/stores/session";
import { promptDialog, confirmDialog } from "../../lib/stores/dialogs";
import {
  LiveAssistantBubble,
  MessageBubble,
  DevDebugPanel,
} from "./_bubbles";
import type { ToolBeat } from "./_bubbles";

interface Props {
  configured: boolean;
  apiKey: string;
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
    configured,
    apiKey,
    embeddingApiKey,
    onDocumentEdited,
    onOpenSource,
    onOpenDocument,
    onOpenSettings,
  },
  ref,
) {
  // --- chats + active chat -------------------------------------------------
  // The document the user is currently editing (active doc tab) is derived
  // from the tabs store; sent each turn as the default p_* target.
  const activeDocumentId = useActiveDocumentId();
  const sources = useSourceItems();
  const health = useSessionStore((s) => s.health);
  // Project identity: chats live in the per-project DB, so the chat list
  // must reload whenever the open project changes.
  const projectPath = useSessionStore((s) => s.project?.projectPath ?? null);
  // Chat-flow UX toggles (Settings → Agent). Resolved onto defaults so the
  // panel works before settings arrive; updates live when they do.
  const settings = useContentStore((s) => s.settings);
  const flow = useMemo(
    () => ({ ...DEFAULT_CHAT_FLOW, ...(settings?.chatFlow ?? {}) }),
    [settings?.chatFlow],
  );
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
      const list = await api.listChatMessages(chatId);
      setMessages(list);
      return list;
    } catch {
      setMessages([]);
      return [];
    }
  }, []);

  // First load: chats + prompts once configured. Auto-create a chat if none,
  // so the user always lands on a writable surface.
  useEffect(() => {
    if (!configured) return;
    // Project switched: drop the previous project's chat selection so
    // stale messages don't linger while the new project's chats load.
    setActiveChatId(null);
    setMessages([]);
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
  }, [configured, projectPath, refreshChats]);

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
  // Last successfully-submitted text, so the Retry button can re-run a turn
  // that errored without re-typing it.
  const lastSentRef = useRef<string>("");
  // Chats we've already auto-greeted this session (opener fires once/chat).
  const greetedRef = useRef<Set<string>>(new Set());
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

  // New chats inherit the previous (active) chat's pinned sources when the
  // toggle is on — preserves the user's working context across "New chat".
  const inheritSources = useCallback((): string[] | undefined => {
    if (!flow.inheritPins) return undefined;
    const pins = activeChat?.contextSources;
    return pins && pins.length ? pins : undefined;
  }, [flow.inheritPins, activeChat]);

  // Auto-title (non-blocking): summarize a short title after the threshold
  // turn. The server no-ops unless the title is still "New chat".
  const maybeAutotitle = useCallback(
    async (chatId: string) => {
      try {
        const { chat, updated } = await api.autotitle(chatId, apiKey);
        if (updated)
          setChats((prev) => prev.map((c) => (c.id === chat.id ? chat : c)));
      } catch {
        /* non-blocking */
      }
    },
    [apiKey],
  );

  // OPENER: auto-greet a new/empty chat. The server injects an internal
  // opener instruction; NO user row is persisted — only the greeting. Reuses
  // the same streaming UI as a normal send (deltas, tool beats, gui events).
  const runOpener = useCallback(
    async (chatId: string) => {
      if (!apiKey || streaming) return;
      const ac = new AbortController();
      abortRef.current = ac;
      setStreaming(true);
      setLiveAssistant("");
      setToolBeats([]);
      setDebugEvents([]);
      const result = await streamChat(chatId, "", apiKey, {
        opener: true,
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
          const existing = useContentStore
            .getState()
            .documents.find((d) => d.id === e.documentId);
          onDocumentEdited?.({
            id: e.documentId,
            title: e.title,
            bodyMd: e.bodyMd,
            docType: existing?.docType ?? null,
            thesis: existing?.thesis ?? null,
            researchQuestions: existing?.researchQuestions ?? [],
            focusPrompt: existing?.focusPrompt ?? null,
            createdAt: existing?.createdAt ?? Date.now(),
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
      await loadMessages(chatId);
    },
    [
      apiKey,
      streaming,
      activeChat,
      activeDocumentId,
      embeddingApiKey,
      loadMessages,
      onDocumentEdited,
      onOpenSource,
      onOpenDocument,
      pushToast,
    ],
  );

  const send = useCallback(
    async (overrideText?: string) => {
      const text = (overrideText ?? input).trim();
      if (!text || !activeChatId || streaming) return;
      lastSentRef.current = text;
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
          // The edit event only carries title/bodyMd — preserve the doc's
          // structural fields from its in-memory row. The store merges with
          // {...d, ...doc}, so fabricated nulls would clobber docType/thesis/
          // researchQuestions/focusPrompt on every agent edit.
          const existing = useContentStore
            .getState()
            .documents.find((d) => d.id === e.documentId);
          onDocumentEdited?.({
            id: e.documentId,
            title: e.title,
            bodyMd: e.bodyMd,
            docType: existing?.docType ?? null,
            thesis: existing?.thesis ?? null,
            researchQuestions: existing?.researchQuestions ?? [],
            focusPrompt: existing?.focusPrompt ?? null,
            createdAt: existing?.createdAt ?? Date.now(),
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
      const list = await loadMessages(activeChatId);
      // Auto-title once the transcript crosses the configured turn threshold
      // (only while still the default title — a manual rename opts out).
      if (
        flow.autoTitle &&
        activeChat?.title === "New chat" &&
        list.length >= flow.autoTitleTurns
      ) {
        void maybeAutotitle(activeChatId);
      }
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
      maybeAutotitle,
      flow.autoTitle,
      flow.autoTitleTurns,
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

  // Fire the opener when a new/empty chat is shown — once per chat/session.
  // Guards: toggle on, a chat is active, not mid-stream, truly empty, and not
  // already greeted (so switching away and back doesn't re-spend tokens).
  useEffect(() => {
    if (!flow.autoGreet) return;
    if (!activeChatId || streaming) return;
    if (messages.length > 0) return;
    if (greetedRef.current.has(activeChatId)) return;
    greetedRef.current.add(activeChatId);
    void runOpener(activeChatId);
  }, [activeChatId, messages.length, streaming, flow.autoGreet, runOpener]);

  const newChat = useCallback(async () => {
    try {
      const c = await api.createChat({ contextSources: inheritSources() });
      setChats((prev) => [c, ...prev]);
      selectChat(c.id);
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  }, [selectChat, inheritSources]);

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
      const c = await api.createChat({ contextSources: inheritSources() });
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
  }, [prompts, selectChat, inheritSources]);

  // Expose the imperative API to the parent (App's New Document button).
  useImperativeHandle(ref, () => ({ startNewDocumentChat }), [
    startNewDocumentChat,
  ]);

  const renameChatById = useCallback(async (chat: Chat) => {
    const title = await promptDialog({
      title: "Rename chat",
      label: "Chat title",
      defaultValue: chat.title,
      okLabel: "Save",
    });
    if (title == null) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const updated = await api.updateChat(chat.id, { title: trimmed });
      setChats((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  }, []);

  const deleteChatById = useCallback(async (chat: Chat) => {
    const ok = await confirmDialog({
      title: "Delete chat",
      message: `Delete chat “${chat.title}”?`,
      okLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteChat(chat.id);
      // Compute the next list OUTSIDE the setChats updater — React 18
      // StrictMode double-invokes updaters in dev, so a side effect
      // (api.createChat) inside one would fire twice and create a duplicate.
      const remaining = chats.filter((c) => c.id !== chat.id);
      setChats(remaining);
      // Only reshuffle selection if the ACTIVE chat was deleted. Deleting a
      // non-active row (from the switcher) just removes it.
      if (chat.id === activeChatId) {
        if (remaining.length > 0) {
          setActiveChatId(remaining[0].id);
        } else {
          setActiveChatId(null);
          try {
            const created = await api.createChat();
            setChats([created]);
            setActiveChatId(created.id);
          } catch {
            /* ignore — user can retry via New */
          }
        }
      }
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  }, [chats, activeChatId]);

  // --- context picker ------------------------------------------------------
  const [pickerOpen, setPickerOpen] = useState(false);
  // Chat switcher anchored panel (replaces the <select>): open near the
  // trigger button; closes on outside click.
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!switcherOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!switcherRef.current?.contains(e.target as Node))
        setSwitcherOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [switcherOpen]);
  // Prompts section: open by default (Settings → Agent). Honor the stored
  // preference once settings arrive, then let the user toggle freely.
  const [promptsOpen, setPromptsOpen] = useState(flow.promptsOpen);
  const promptsInitedRef = useRef(false);
  useEffect(() => {
    if (promptsInitedRef.current) return;
    if (settings?.chatFlow) {
      promptsInitedRef.current = true;
      setPromptsOpen(settings.chatFlow.promptsOpen);
    }
  }, [settings?.chatFlow]);

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
            onClick={() => activeChat && renameChatById(activeChat)}
            disabled={!activeChat}
          >
            <PencilSimpleLine size={14} weight="bold" />
          </button>
          <button
            type="button"
            className="tb small danger"
            title="Delete chat"
            onClick={() => activeChat && deleteChatById(activeChat)}
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
          <div className="chat-switcher" ref={switcherRef}>
            <button
              type="button"
              className="chat-switcher-btn"
              onClick={() => setSwitcherOpen((v) => !v)}
              disabled={!activeChat}
              title={activeChat?.title ?? "Select chat"}
            >
              <span className="chat-switcher-title">
                {activeChat?.title ?? "No chat"}
              </span>
              <CaretDown size={12} weight="bold" />
            </button>
            {switcherOpen && (
              <div className="chat-switcher-panel">
                <button
                  type="button"
                  className="chat-switcher-new"
                  onClick={() => {
                    setSwitcherOpen(false);
                    void newChat();
                  }}
                >
                  <Plus size={12} weight="bold" />
                  New chat
                </button>
                <ul className="chat-switcher-list">
                  {chats.map((c) => (
                    <li
                      key={c.id}
                      className={`chat-switcher-item${
                        c.id === activeChatId ? " active" : ""
                      }`}
                    >
                      <button
                        type="button"
                        className="chat-switcher-row"
                        onClick={() => {
                          setSwitcherOpen(false);
                          selectChat(c.id);
                        }}
                      >
                        <span className="chat-switcher-name" title={c.title}>
                          {c.title || "(untitled)"}
                        </span>
                        <span className="chat-switcher-time muted small">
                          {relTime(c.updatedAt)}
                        </span>
                      </button>
                      <span className="chat-switcher-actions">
                        <button
                          type="button"
                          className="tb xs"
                          title="Rename"
                          onClick={() => void renameChatById(c)}
                        >
                          <PencilSimpleLine size={11} weight="bold" />
                        </button>
                        <button
                          type="button"
                          className="tb xs danger"
                          title="Delete"
                          onClick={() => void deleteChatById(c)}
                        >
                          <Trash size={11} weight="bold" />
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

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
            <div className="warn small error-row">
              <span className="error-text" onClick={() => setError(null)}>
                {error}
              </span>
              <button
                type="button"
                className="btn retry"
                onClick={() => send(lastSentRef.current)}
                title="Re-run the last message"
              >
                <ArrowClockwise size={14} weight="bold" />
                Retry
              </button>
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

/** Ephemeral gui_action surface. */
interface ChatToast {
  id: string;
  kind: "warn" | "celebrate" | "info";
  text: string;
}

/** Compact relative timestamp for the chat switcher rows. */
function relTime(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toISOString().slice(0, 10);
}
