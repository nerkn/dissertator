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
import { useChatInputStore } from "../../lib/stores/chatInput";
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
  embeddingApiKey?: string;
  onDocumentEdited?: (doc: Document) => void;
  onOpenSource?: (sourceId: string) => void;
  onOpenDocument?: (documentId: string) => void;
  onOpenSettings?: () => void;
}

export interface ChatPanelHandle {
  startNewDocumentChat: () => Promise<void>;
}

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
  const activeDocumentId = useActiveDocumentId();
  const sources = useSourceItems();
  const health = useSessionStore((s) => s.health);
  const projectPath = useSessionStore((s) => s.project?.projectPath ?? null);
  const settings = useContentStore((s) => s.settings);
  const flow = useMemo(
    () => ({ ...DEFAULT_CHAT_FLOW, ...(settings?.chatFlow ?? {}) }),
    [settings?.chatFlow],
  );
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoadedFor, setMessagesLoadedFor] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [loadingChats, setLoadingChats] = useState(true);

  const activeChat = useMemo(
    () => chats.find((c) => c.id === activeChatId) ?? null,
    [chats, activeChatId],
  );

  const fileNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sources) m.set(s.id, s.filename);
    return m;
  }, [sources]);

  const [embed, setEmbed] = useState<EmbeddingStatus | null>(null);
  useEffect(() => {
    if (health !== "up") return;
    let stopped = false;
    const tick = async (): Promise<void> => {
      try {
        const e = await api.embedStatus();
        if (!stopped) setEmbed(e);
      } catch {
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
      setMessagesLoadedFor(chatId);
      return list;
    } catch {
      setMessages([]);
      setMessagesLoadedFor(chatId);
      return [];
    }
  }, []);

  useEffect(() => {
    if (!configured) return;
    setActiveChatId(null);
    setMessages([]);
    setMessagesLoadedFor(null);
    let stopped = false;
    (async () => {
      setLoadingChats(true);
      const list = await refreshChats();
      try {
        if (!stopped) setPrompts(await api.listPrompts());
      } catch {
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
        }
      }
      if (!stopped && next.length > 0) setActiveChatId(next[0].id);
      if (!stopped) setLoadingChats(false);
    })();
    return () => {
      stopped = true;
    };
  }, [configured, projectPath, refreshChats]);

  useEffect(() => {
    if (activeChatId) void loadMessages(activeChatId);
    else setMessages([]);
  }, [activeChatId, loadMessages]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [liveAssistant, setLiveAssistant] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [toolBeats, setToolBeats] = useState<ToolBeat[]>([]);
  const [pendingOptions, setPendingOptions] = useState<GuiOption[] | null>(null);
  const [toasts, setToasts] = useState<ChatToast[]>([]);
  const [debugEvents, setDebugEvents] = useState<DebugEvent[]>([]);
  const [debugOpen, setDebugOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const lastSentRef = useRef<string>("");
  const greetedRef = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const liveBufRef = useRef("");
  const liveFlushRef = useRef<number | null>(null);
  const resetLiveBuffer = useCallback(() => {
    if (liveFlushRef.current !== null) {
      cancelAnimationFrame(liveFlushRef.current);
      liveFlushRef.current = null;
    }
    liveBufRef.current = "";
    setLiveAssistant("");
  }, []);
  const onDeltaBundled = useCallback((d: string) => {
    liveBufRef.current += d;
    if (liveFlushRef.current === null) {
      liveFlushRef.current = requestAnimationFrame(() => {
        liveFlushRef.current = null;
        setLiveAssistant(liveBufRef.current);
      });
    }
  }, []);

  const pushToast = useCallback((kind: ChatToast["kind"], text: string) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: streaming ? "auto" : "smooth" });
  }, [messages, liveAssistant, toolBeats, pendingOptions, streaming]);

  const inheritSources = useCallback((): string[] | undefined => {
    if (!flow.inheritPins) return undefined;
    const pins = activeChat?.contextSources;
    return pins && pins.length ? pins : undefined;
  }, [flow.inheritPins, activeChat]);

  const maybeAutotitle = useCallback(
    async (chatId: string) => {
      try {
        const { chat, updated } = await api.autotitle(chatId, apiKey);
        if (updated)
          setChats((prev) => prev.map((c) => (c.id === chat.id ? chat : c)));
      } catch {
      }
    },
    [apiKey],
  );

  const runOpener = useCallback(
    async (chatId: string) => {
      if (!apiKey || streaming) return;
      const ac = new AbortController();
      abortRef.current = ac;
      setStreaming(true);
      resetLiveBuffer();
      setToolBeats([]);
      setDebugEvents([]);
      const result = await streamChat(chatId, "", apiKey, {
        opener: true,
        openFiles: activeChat?.contextSources ?? [],
        activeDocumentId,
        embeddingApiKey,
        onDelta: onDeltaBundled,
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
            createdAt: existing?.createdAt ?? Date.now(),
          });
        },
        onGui: (g: GuiEvent) => {
          switch (g.kind) {
            case "open":
              onOpenSource?.(g.sourceId);
              break;
            case "source_edited":
              useContentStore.getState().bumpSourceRevision(g.sourceId);
              break;
            case "suggest_replies":
              setPendingOptions(g.options);
              break;
            case "action":
              pushToast(g.action, g.text);
              break;
          }
        },
        onDebug: (e) =>
          setDebugEvents((prev) => [...prev, e].slice(-5)),
        signal: ac.signal,
      });
      setStreaming(false);
      resetLiveBuffer();
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
    async (overrideText?: string, sendOpts?: { retry?: boolean }) => {
      const isRetry = sendOpts?.retry === true;
      const text = (overrideText ?? input).trim();
      if (!text || !activeChatId || streaming) return;
      lastSentRef.current = text;
      setError(null);
      if (!isRetry) setInput("");
      setPendingOptions(null);
      setToolBeats([]);
      setDebugEvents([]);

      if (!isRetry) {
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
      }

      const ac = new AbortController();
      abortRef.current = ac;
      setStreaming(true);
      resetLiveBuffer();

      const result = await streamChat(activeChatId, text, apiKey, {
        openFiles: activeChat?.contextSources ?? [],
        activeDocumentId,
        embeddingApiKey,
        ...(isRetry ? { retry: true } : {}),
        onDelta: onDeltaBundled,
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
            createdAt: existing?.createdAt ?? Date.now(),
          });
        },
        onGui: (g: GuiEvent) => {
          switch (g.kind) {
            case "open":
              onOpenSource?.(g.sourceId);
              break;
            case "source_edited":
              useContentStore.getState().bumpSourceRevision(g.sourceId);
              break;
            case "suggest_replies":
              setPendingOptions(g.options);
              break;
            case "action":
              pushToast(g.action, g.text);
              break;
          }
        },
        onDebug: (e) =>
          setDebugEvents((prev) => [...prev, e].slice(-5)),
        signal: ac.signal,
      });

      setStreaming(false);
      resetLiveBuffer();
      setToolBeats([]);
      abortRef.current = null;

      if (result.error && !result.aborted) {
        setError(result.error);
      } else if (result.capped) {
        pushToast("warn", "Agent hit its step cap — it may not have finished.");
      }
      const list = await loadMessages(activeChatId);
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

  const selectChat = useCallback(
    (id: string) => {
      if (streaming) abortRef.current?.abort();
      setActiveChatId(id);
    },
    [streaming],
  );

  useEffect(() => {
    if (!flow.autoGreet) return;
    if (!activeChatId || streaming) return;
    if (messagesLoadedFor !== activeChatId) return;
    if (messages.length > 0) return;
    if (greetedRef.current.has(activeChatId)) return;
    greetedRef.current.add(activeChatId);
    void runOpener(activeChatId);
  }, [activeChatId, messagesLoadedFor, messages.length, streaming, flow.autoGreet, runOpener]);

  const chatInputToken = useChatInputStore((s) => s.token);
  const chatInputText = useChatInputStore((s) => s.text);
  const lastPrefillTokenRef = useRef(0);
  useEffect(() => {
    if (chatInputToken === lastPrefillTokenRef.current) return;
    lastPrefillTokenRef.current = chatInputToken;
    const text = chatInputText?.trim();
    if (!text) return;
    const quote = text
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    setInput((prev) => (prev.trim() ? `${prev.trim()}\n\n${quote}\n\n` : `${quote}\n\n`));
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [chatInputToken, chatInputText]);

  const newChat = useCallback(async () => {
    try {
      const c = await api.createChat({ contextSources: inheritSources() });
      setChats((prev) => [c, ...prev]);
      selectChat(c.id);
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  }, [selectChat, inheritSources]);

  const startNewDocumentChat = useCallback(async () => {
    try {
      const c = await api.createChat({ contextSources: inheritSources() });
      setChats((prev) => [c, ...prev]);
      selectChat(c.id);
      const found = prompts.find(
        (p) => p.label.toLowerCase() === "new document"
      );
      setInput(found?.prompt ?? NEW_DOCUMENT_PROMPT_FALLBACK);
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  }, [prompts, selectChat, inheritSources]);

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
      const remaining = chats.filter((c) => c.id !== chat.id);
      setChats(remaining);
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
          }
        }
      }
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  }, [chats, activeChatId]);

  const [pickerOpen, setPickerOpen] = useState(false);
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
      setChats((prev) =>
        prev.map((c) =>
          c.id === activeChat.id ? { ...c, contextSources: next } : c,
        ),
      );
      try {
        await api.updateChat(activeChat.id, { contextSources: next });
      } catch (e) {
        setError((e as Error)?.message ?? String(e));
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
      <div className="chat-corpus muted small" title="What the agent can reach via list">
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

          {import.meta.env.DEV && debugEvents.length > 0 && (
            <DevDebugPanel
              events={debugEvents}
              open={debugOpen}
              onToggle={() => setDebugOpen((v) => !v)}
              streaming={streaming}
            />
          )}

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
                onClick={() => send(lastSentRef.current, { retry: true })}
                title="Re-run the last message"
              >
                <ArrowClockwise size={14} weight="bold" />
                Retry
              </button>
            </div>
          )}

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

interface ChatToast {
  id: string;
  kind: "warn" | "celebrate" | "info";
  text: string;
}

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
