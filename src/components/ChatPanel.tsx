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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PaperPlaneTilt,
  Plus,
  PencilSimpleLine,
  Trash,
  StopCircle,
  X,
  Files,
  Lightbulb,
} from "@phosphor-icons/react";
import type { Chat, ChatMessage, Prompt, SourceFile } from "@dissertator/shared";
import { api, streamChat } from "../lib/api";

interface Props {
  health: "checking" | "up" | "down";
  configured: boolean;
  apiKey: string;
  sources: SourceFile[];
}

export function ChatPanel({ health, configured, apiKey, sources }: Props) {
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
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Autoscroll to bottom as the transcript or the live reply grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, liveAssistant]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !activeChatId || streaming) return;
    setError(null);
    setInput("");

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
      onDelta: (d) => setLiveAssistant((prev) => prev + d),
      signal: ac.signal,
    });

    setStreaming(false);
    setLiveAssistant("");
    abortRef.current = null;

    if (result.error && !result.aborted) {
      setError(result.error);
    }
    // Reload canonical state (server persisted both turns, even on abort).
    await loadMessages(activeChatId);
  }, [input, activeChatId, streaming, activeChat, apiKey, loadMessages]);

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
        <div className="warn">Open ⚙ Settings to configure a provider and API key.</div>
      </aside>
    );
  }

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
              <MessageBubble
                msg={{
                  id: "live",
                  chatId: activeChatId ?? "",
                  role: "assistant",
                  content: liveAssistant || "…",
                  openFiles: [],
                  costTokens: null,
                  createdAt: Date.now(),
                }}
                live
              />
            )}
          </div>

          {/* Prompts — quick-fire buttons from prompts.md. */}
          {prompts.length > 0 && (
            <div className="chat-prompts">
              <div className="chat-prompts-label muted small">
                <Lightbulb size={12} weight="bold" /> Prompts
              </div>
              <div className="chat-prompts-row">
                {prompts.map((p, i) => (
                  <button
                    key={i}
                    type="button"
                    className="prompt-btn"
                    title={p.prompt}
                    onClick={() => setInput(p.prompt)}
                  >
                    {p.category ? `${p.category}: ` : ""}
                    {p.label}
                  </button>
                ))}
              </div>
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
