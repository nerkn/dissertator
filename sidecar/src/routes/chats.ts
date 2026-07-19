import type { Hono } from "hono";
import { join } from "node:path";
import { streamSSE } from "hono/streaming";
import type { ChatRequest, Reference, ToolTrace } from "@dissertator/shared";
import {
  buildOpenFilesContext,
  createChat,
  deleteChat,
  deleteChatMessage,
  getChat,
  getCurrentProject,
  getDocument,
  getSettings,
  insertChatMessage,
  listChatMessages,
  listChats,
  listReferences,
  updateChat,
} from "../db";
import { readPreferences } from "../agent-files.ts";
import {
  runAgentLoop,
  type AgentStreamEvent,
} from "../agent/loop.ts";
import { completeChat, streamOpenAIChat, type LoopMessage, type ToolSpec } from "../chat/openai.ts";
import type { ToolContext } from "../agent/tools.ts";

/**
 * Ephemeral opener instruction injected as the (unsent) user turn when a
 * brand-new chat auto-greets. The system prompt already carries the whole
 * corpus glimpse + other chat titles + the active manuscript, so this just
 * asks for a short orientation + concrete next-step proposals (offered as
 * one-tap gui_options). No user row is persisted for opener turns.
 */
const OPENER_INSTRUCTION =
  "This is a brand-new chat and the user hasn't said anything yet. Greet them in ONE short sentence, then orient: you can already see the full corpus and the active manuscript above. Propose 2–3 concrete next steps (e.g. read a specific source, draft or revise a section, compare sources, fill a citation gap) and surface them as one-tap choices via gui_options. Keep it brief — do NOT read documents or run heavy tools yet; just propose and let the user pick.";

/** Tighten a model-emitted title: strip quotes/punctuation, cap length. */
function sanitizeTitle(raw: string): string {
  let t = raw.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  t = t.replace(/[.·:]\s*$/, "").trim();
  if (t.length > 80) t = t.slice(0, 80).trim();
  return t;
}

// ---------------------------------------------------------------------------
// Chats (P4): freeform chat thread CRUD. A chat is NOT bound to a document;
// it carries its own pinned `contextSources` (source_file ids) for UI
// persistence, and owns a transcript of `chat_messages` (POST /chat appends).
// Mirrors the /documents guards (400 if no project, 404 if id unknown).
// ---------------------------------------------------------------------------

export function registerChats(app: Hono): void {
  app.get("/chats", (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    return c.json(listChats());
  });

  app.post("/chats", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const body = await c.req
      .json<{ title?: string; contextSources?: string[] }>()
      .catch(
        () =>
          ({}) as { title?: string; contextSources?: string[] }
      );
    const chat = createChat({
      title: body.title,
      contextSources: Array.isArray(body.contextSources)
        ? body.contextSources
        : undefined,
    });
    return c.json(chat, 201);
  });

  app.get("/chats/:id", (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const id = c.req.param("id");
    const chat = getChat(id);
    if (!chat) return c.json({ error: "not found" }, 404);
    return c.json(chat);
  });

  app.put("/chats/:id", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const id = c.req.param("id");
    const body = await c.req
      .json<{ title?: string; contextSources?: string[] }>()
      .catch(
        () => ({}) as { title?: string; contextSources?: string[] }
      );
    const chat = updateChat(id, body);
    if (!chat) return c.json({ error: "not found" }, 404);
    return c.json(chat);
  });

  app.delete("/chats/:id", (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const id = c.req.param("id");
    const ok = deleteChat(id);
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  app.get("/chats/:id/messages", (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const id = c.req.param("id");
    if (!getChat(id)) return c.json({ error: "not found" }, 404);
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    return c.json(
      listChatMessages(id, Number.isFinite(limit) ? limit : undefined)
    );
  });

  // -----------------------------------------------------------------------
  // Auto-title (non-blocking): summarize the transcript into a short title.
  // Only honored while the title is still the default "New chat" — a manual
  // rename (or a prior auto-title) opts the chat out. Reuses the configured
  // chat provider/model; the API key travels as a Bearer header. The client
  // fires this once after the configured turn threshold (Settings → Agent).
  // -----------------------------------------------------------------------
  app.post("/chats/:id/autotitle", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const id = c.req.param("id");
    const chat = getChat(id);
    if (!chat) return c.json({ error: "not found" }, 404);
    if (chat.title !== "New chat") return c.json({ chat, updated: false });

    const auth = c.req.header("Authorization") ?? "";
    const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!apiKey) return c.json({ error: "chat api key required" }, 400);

    const settings = getSettings();
    const cfg = settings.resolved?.chat;
    if (!cfg?.apiUrl || !cfg?.model) {
      return c.json({ error: "no chat provider/model bound" }, 400);
    }

    const msgs = listChatMessages(id, 10).filter((m) => m.role !== "system");
    if (msgs.length < 2) return c.json({ chat, updated: false });

    const transcript = msgs
      .map(
        (m) =>
          `${m.role === "assistant" ? "Assistant" : "User"}: ${(
            m.content ?? ""
          ).slice(0, 600)}`,
      )
      .join("\n");

    try {
      const raw = await completeChat({
        apiKey,
        config: { apiUrl: cfg.apiUrl, model: cfg.model },
        messages: [
          {
            role: "system",
            content:
              "Summarize the conversation below into a concise chat title: at most 6 words, no surrounding quotes, no trailing period, title case. Reply with the title only.",
          },
          { role: "user", content: transcript },
        ],
        maxTokens: 1024,
        temperature: 0.3,
      });
      const title = sanitizeTitle(raw);
      if (title && title !== "New chat") {
        const updated = updateChat(id, { title });
        return c.json({ chat: updated, updated: true });
      }
      return c.json({ chat, updated: false });
    } catch (e) {
      return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
    }
  });

  // -------------------------------------------------------------------------
  // Chat (P3 Track E): streaming `POST /chat` with open-files context.
  //
  // Streams an OpenAI-compatible chat completion. The chat provider/model/url
  // come from `Settings` (optionally overridden by the P3 `chat_*` block —
  // decision #1: fall back to the main provider if not specified). The API key
  // travels ONLY as a Bearer header — never stored, never logged (mirrors the
  // /embed + ocr/vision discipline).
  //
  // CONTEXT: `open_files` source ids are concatenated (their chunks, page-
  // tagged) up to a char budget and injected as a system message. This is plain
  // full-text injection, NOT semantic retrieval (that's /search). The full
  // transcript is persisted to `chat_messages` AFTER the turn completes (user
  // msg up-front, assistant msg once the stream ends — so an aborted stream
  // still records the user turn + whatever completed).
  //
  // STREAM PROTOCOL: each delta is forwarded as an SSE `delta` event carrying
  // the text fragment; a final `done` event carries usage + persisted message
  // ids. Errors mid-stream are emitted as an `error` event then the stream
  // closes (the client sees the partial text + the error message).
  //
  // SCOPING (P4): `chatId` is REQUIRED — the turn is persisted to + replayed
  // from THAT chat only. `GET /chat/messages?chatId=` is retained as a thin
  // backward-compat alias for `GET /chats/:id/messages` (canonical).
  // -------------------------------------------------------------------------

  app.get("/chat/messages", (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const chatId = c.req.query("chatId");
    if (!chatId) return c.json({ error: "chatId required" }, 400);
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    return c.json(
      listChatMessages(chatId, Number.isFinite(limit) ? limit : undefined)
    );
  });

  app.post("/chat", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const body = await c
      .req.json<ChatRequest>()
      .catch(() => ({}) as ChatRequest);
    const chatId = (body.chatId ?? "").trim();
    if (!chatId) return c.json({ error: "chatId required" }, 400);
    if (!getChat(chatId)) return c.json({ error: "chat not found" }, 404);
    const isOpener = body.opener === true;
    const isRetry = body.retry === true;
    const message = (body.message ?? "").trim();
    if (!message && !isOpener) return c.json({ error: "message required" }, 400);
    const openFiles = Array.isArray(body.openFiles) ? body.openFiles : [];
    // Opener only fires on an empty chat — defense against re-greeting a
    // chat that already has turns (e.g. a stale frontend trigger).
    if (isOpener && listChatMessages(chatId, 1).length > 0) {
      return c.json({ error: "chat not empty" }, 400);
    }

    // API key travels ONLY as a Bearer header (same discipline as /embed +
    // ocr/vision). Never logged.
    const auth = c.req.header("Authorization") ?? "";
    const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!apiKey) return c.json({ error: "chat api key required" }, 400);

    // P5: the document the user is currently editing (default p_* target) + the
    // embedding key (separate secret slot) for corpus_list vector search. Both
    // are optional; corpus_list degrades to metadata-only without the embed key.
    const activeDocId = (body.activeDocumentId ?? "").trim() || undefined;
    const embedKeyRaw = c.req.header("X-Embedding-Key") ?? "";
    const embeddingApiKey = embedKeyRaw.trim() || undefined;

    const settings = getSettings();
    const chat = settings.resolved?.chat;
    if (!chat?.apiUrl || !chat?.model) {
      return c.json(
        { error: "no chat provider/model bound — set one in Settings → Functions" },
        400,
      );
    }
    const config = { apiUrl: chat.apiUrl, model: chat.model };

    return streamSSE(c, async (stream) => {
      // Persist the user turn immediately (so an aborted stream still records it).
      // OPENER turns skip the user row entirely — only the assistant greeting
      // is persisted (the opener instruction below is ephemeral).
      // RETRY turns also skip the insert — the last user row is reused as-is,
      // and the most recent assistant row (the failed/partial one) is deleted
      // first so the transcript keeps a single user+assistant pair instead of
      // accumulating duplicates with each retry.
      let userMsg: { id: string } | null = null;
      if (isOpener) {
        userMsg = null;
      } else if (isRetry) {
        const tail = listChatMessages(chatId, 10);
        const reversed = [...tail].reverse();
        const lastAssistant = reversed.find((m) => m.role === "assistant");
        const lastUser = reversed.find((m) => m.role === "user");
        if (lastAssistant) deleteChatMessage(lastAssistant.id);
        userMsg = lastUser ? { id: lastUser.id } : null;
      } else {
        userMsg = insertChatMessage({
          chatId,
          role: "user",
          content: message,
          openFiles,
        });
      }

      // Recent transcript (excluding system rows + the user turn just
      // inserted). Reused for (a) detecting whether the pinned-source set
      // CHANGED vs the previous turn — full text is injected only on change
      // (pins-on-change design), and (b) replaying conversational continuity.
      const recent = listChatMessages(chatId, 20).filter(
        (m) => m.role !== "system" && (userMsg ? m.id !== userMsg.id : true),
      );
      const prevOpenFiles = recent.length
        ? recent[recent.length - 1].openFiles ?? []
        : [];

      // Build the system message: role + tool guidance + active-doc + context.
      const systemParts: string[] = [
        "You are Dissertator, a research writing assistant. You help the user read sources and write their manuscript.",
        "",
        "You have tools — use them proactively:",
        "- corpus_list({query}) semantic-searches the embedded corpus; ({author,title}) filters the reference index. Returns short metadata; call doc_read for full text.",
        "- doc_read({id, page?}) reads a source's extracted text.",
        "- p_read({id?}) reads the manuscript body (id defaults to the active document).",
        "- p_create({title, text?}) creates a new manuscript.",
        "- p_write({id?, oldtext, text}) REPLACES the first occurrence of `oldtext` (must exist verbatim) with `text`.",
        "- p_insert({id?, anchor, text}) INSERTs `text` right after the first occurrence of `anchor` (empty anchor = top of the body).",
        "- gui_doc_open / gui_p_open open things for the user; gui_options offers quick-reply choices (does NOT pause); gui_action narrates milestones.",
        "- pref_add({ text }) records ONE durable user preference (tone, format, citation style, workflow, constraint) as a bullet. Use ONLY for lasting preferences — NEVER for one-off requests.",
        "",
        "Manuscript edits are CONTENT-ADDRESSED: pass the exact `oldtext`/`anchor` you got from p_read. If p_write/p_insert fails because the text wasn't found, p_read again — the user may have edited meanwhile.",
        "Cite sources inline as [@citekey] or [@citekey:42] (page). Prefer grounded claims; say plainly when the sources are insufficient.",
      ];
      const prefs = await readPreferences();
      if (prefs.trim()) {
        systemParts.push(
          "",
          "# Known user preferences",
          "(Durable preferences the user has stated across sessions. Respect them.)",
          prefs.trim(),
        );
      }
      if (activeDocId) {
        const d = getDocument(activeDocId);
        systemParts.push(
          `The user is currently editing the manuscript "${d?.title ?? "(unknown)"}" (id: ${activeDocId}). p_* tools without an explicit \`id\` act on it.`
        );
      }
      // Whole-corpus glimpse: compact metadata for EVERY source (one TSV row
      // each) so the model always knows what exists and can cite by citekey or
      // resolve a source via corpus_list/doc_read for full text. Sent every
      // turn — it's cheap metadata and underpins the pins-on-change design
      // (unchanged pins fall back to this index instead of re-injected text).
      //
      // Trimming: (a) drop placeholder refs (no authors AND no real title) —
      // they're filename-derived stubs that add tokens and confuse citation;
      // (b) dedupe by source_file_id so a stub citekey (e.g. `emo`) and a
      // later real citekey (`Eshraghian2025`) for the SAME source don't both
      // appear — the model would otherwise pass the stale citekey to doc_read.
      const allRefs = listReferences();
      const seenSrc = new Set<string>();
      const isPlaceholder = (r: Reference) =>
        r.authors.length === 0 &&
        (!r.title || r.title.trim().toLowerCase() === r.citekey.trim().toLowerCase());
      const refs = allRefs.filter((r) => {
        if (isPlaceholder(r)) return false;
        if (r.source_file_id) {
          if (seenSrc.has(r.source_file_id)) return false;
          seenSrc.add(r.source_file_id);
        }
        return true;
      });
      if (refs.length) {
        const refRows = refs.map((r) =>
          [
            r.citekey,
            r.title ?? "",
            typeof r.year === "number" ? String(r.year) : "",
            (r.authors ?? [])
              .map((a) => [a.given, a.family].filter(Boolean).join(" "))
              .join("; "),
          ].join("\t")
        );
        systemParts.push(
          "",
          "# Corpus (entire library)",
          "Every source in this project — TSV: citekey <TAB> title <TAB> year <TAB> authors. Cite inline as [@citekey]; call corpus_list({title}) or ({author}) to resolve a source id, then doc_read(id) for full text.",
          "citekey\ttitle\tyear\tauthors",
          ...refRows,
        );
      }
      const otherChats = listChats().filter((c) => c.id !== chatId);
      if (otherChats.length) {
        systemParts.push(
          "",
          "# Other chats in this project",
          "Recent threads (for continuity — don't repeat their content unless the user asks):",
          ...otherChats.slice(0, 20).map((c) => `- ${c.title || "(untitled)"}`),
        );
      }
      const ctx = buildOpenFilesContext(openFiles);
      if (openFiles.length) {
        const refBySrc = new Map(
          refs.filter((r) => r.source_file_id).map((r) => [r.source_file_id!, r]),
        );
        const labelOf = (id: string): string => {
          const r = refBySrc.get(id);
          return r ? `${r.citekey}${r.title ? ` — ${r.title}` : ""}` : id;
        };
        const sameSet = (a: string[], b: string[]): boolean =>
          a.length === b.length && a.every((x) => b.includes(x));
        if (sameSet(prevOpenFiles, openFiles)) {
          systemParts.push(
            `\nPinned sources (UNCHANGED since last turn — full text already seen; call doc_read(id) to re-read): ${openFiles.map(labelOf).join("; ")}.`,
          );
        } else if (ctx) {
          systemParts.push(
            `\nThe user has pinned these source files (full text below) as grounding context:\n\n${ctx}`,
          );
        }
      }
      const messages: LoopMessage[] = [
        { role: "system", content: systemParts.join("\n") },
        // Replay THIS chat's recent turns for conversational continuity (omit
        // system rows; we synthesize our own above). Only text content is
        // replayed — the tool-call trace lives in the current run only.
        ...recent.slice(-12).map(
          (m): LoopMessage => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content ?? "",
          }),
        ),
        { role: "user", content: isOpener ? OPENER_INSTRUCTION : message },
      ];

      const ac = new AbortController();
      let aborted = false;
      // Accumulate streamed text here (not from runAgentLoop's return value)
      // so a throw on a LATER step (e.g. 429 on synthesis after the answer
      // already streamed) still has the partial content to persist —
      // otherwise the catch block saves a placeholder and the UI watches
      // the streamed reply vanish on reload.
      let content = "";
      stream.onAbort(() => {
        aborted = true;
        ac.abort();
      });

      // P5: single SSE fan-in. Every beat (deltas, tool calls/results, live
      // edits, gui side-effects) flows through here as a named event.
      // `toolTrace` mirrors the tool beats so the assistant turn's narration
      // can be PERSISTED onto the message row (survives reload; visible even
      // on a turn that errored before any text streamed).
      const toolTrace: (ToolTrace & { id: string })[] = [];
      const onEvent = async (e: AgentStreamEvent): Promise<void> => {
        switch (e.type) {
          case "delta":
            content += e.text;
            await stream.writeSSE({ event: "delta", data: e.text });
            break;
          case "tool_call":
            toolTrace.push({ id: e.id, name: e.name, args: e.args });
            await stream.writeSSE({
              event: "tool_call",
              data: JSON.stringify({
                id: e.id,
                name: e.name,
                args: e.args,
              }),
            });
            break;
          case "tool_result":
            for (const b of toolTrace) {
              if (b.id === e.id) {
                b.ok = e.ok;
                b.summary = e.summary;
                if (e.error) b.error = e.error;
              }
            }
            await stream.writeSSE({
              event: "tool_result",
              data: JSON.stringify({
                id: e.id,
                name: e.name,
                ok: e.ok,
                summary: e.summary,
                ...(e.error ? { error: e.error } : {}),
              }),
            });
            break;
          case "edit":
            await stream.writeSSE({
              event: "edit",
              data: JSON.stringify({
                documentId: e.documentId,
                title: e.title,
                bodyMd: e.bodyMd,
              }),
            });
            break;
          case "gui":
            await stream.writeSSE({
              event: "gui",
              data: JSON.stringify(e.gui),
            });
            break;
        }
      };

      // Dev debug: surface exactly what's sent to the LLM. We wrap the
      // streaming adapter so every agent step fires a `debug` SSE event with
      // the model config, the full message array (roles + content + tool-call
      // traces), and the tool advertisements. The API key is NOT in the
      // payload (it travels only as a header).
      //
      // Also appended to `Dissertator/logs/agent.log` so a dev can `tail -f`
      // the exact LLM payloads during local debugging. ON by default; set
      // DEBUG=0 to disable (e.g. to keep the project folder quiet in prod).
      let debugStep = 0;
      const debugToFile = process.env.DEBUG !== "0";
      const wrapStream = (opts: Parameters<typeof streamOpenAIChat>[0]) => {
        const step = ++debugStep;
        const payload = {
          step,
          config: {
            apiUrl: opts.config.apiUrl,
            model: opts.config.model,
          },
          toolChoice: opts.toolChoice ?? (opts.tools && opts.tools.length ? "auto" : undefined),
          tools: (opts.tools ?? []).map((t: ToolSpec) => t.function.name),
          messages: opts.messages,
        };
        // Emit as a first-class SSE event the client can render in a dev panel.
        stream.writeSSE({ event: "debug", data: JSON.stringify(payload) }).catch(() => {});
        if (debugToFile) {
          try {
            const project = getCurrentProject();
            if (project) {
              const logsDir = join(project.dissertatorDir, "logs");
              const logPath = join(logsDir, "agent.log");
              const stamp = new Date().toISOString();
              const line = `${stamp} [agent step ${step}] model=${opts.config.model} tools=${payload.tools.length} msgs=${opts.messages.length}\n` +
                JSON.stringify(payload, null, 2) + "\n";
              void import("node:fs/promises").then(async (fs) => {
                await fs.mkdir(logsDir, { recursive: true });
                await fs.appendFile(logPath, line, "utf8");
              }).catch(() => {});
            }
          } catch {
            /* logging must never throw */
          }
        }
        return streamOpenAIChat(opts);
      };
      const toolContext: ToolContext = {
        embeddingApiKey,
        activeDocumentId: activeDocId,
        emitGui: (gui) => {
          void onEvent({ type: "gui", gui });
        },
      };

      let usage = { prompt: 0, completion: 0 };
      let toolCalls = 0;
      let capped = false;
      // Keep the SSE connection alive across model "thinking" gaps and slow
      // tool/embedding calls. Bun.serve's default idleTimeout (10s) drops an
      // idle socket, and a reasoning model (e.g. glm-5.2) can spend >10s
      // emitting nothing before its first token on a synthesis step. That gap
      // looked exactly like the client giving up: Hono's stream.onAbort fired
      // → ac.abort() → the in-flight model fetch aborted → empty reply.
      // An SSE comment (`: ping`) every 3s keeps the socket warm and is
      // silently ignored by the client's SSE parser (only `event:`/`data:`
      // lines are dispatched). Mirrors the /events heartbeat on a tighter
      // cadence (well under the 10s idle limit).
      const heartbeat = setInterval(() => {
        if (stream.aborted || stream.closed) return;
        stream.write(": ping\n\n").catch(() => {});
      }, 3000);
      try {
        const res = await runAgentLoop({
          apiKey,
          config,
          messages,
          toolContext,
          signal: ac.signal,
          onEvent,
          streamFn: wrapStream,
          stepTimeoutMs: Number(process.env.CHAT_STEP_TIMEOUT_MS) || 600_000,
        });
        content = res.content;
        usage = res.usage;
        toolCalls = res.toolCalls;
        capped = res.capped;
        aborted = aborted || res.aborted;
      } catch (e) {
        const errMsg = (e as Error)?.message ?? String(e);
        // Dev debug: a throw or abort here leaves agent.log without a
        // `[turn done]` line, which previously made failures look like the
        // model simply stopped. Log the reason so it's grep-able.
        if (debugToFile) {
          try {
            const project = getCurrentProject();
            if (project) {
              const logPath = join(project.dissertatorDir, "logs", "agent.log");
              const stamp = new Date().toISOString();
              const abortedNow = aborted || (e as Error)?.name === "AbortError";
              const line =
                `${stamp} [turn FAILED] steps=${debugStep} aborted=${abortedNow} ` +
                `contentLen=${content.length}\n` +
                `  error: ${JSON.stringify(errMsg)}\n`;
              void import("node:fs/promises").then((fs) => fs.appendFile(logPath, line, "utf8")).catch(() => {});
            }
          } catch {
            /* logging must never throw */
          }
        }
        // Surface the error but still persist whatever streamed before the
        // failure, so the transcript isn't lost. If the model ran tools but
        // produced no text (e.g. it died on the synthesis step), still record
        // a turn carrying the tool narration + a short error note — otherwise
        // the user sees the tools vanish and nothing else.
        const traceForPersist = toolTrace.map(({ id: _id, ...rest }) => rest);
        const partial =
          content || traceForPersist.length
            ? insertChatMessage({
                chatId,
                role: "assistant",
                content:
                  content ||
                  "_(no reply — the model errored before answering; see the error below)_",
                openFiles,
                costTokens: usage,
                toolCalls: traceForPersist,
              })
            : null;
        // Touch the chat's updated_at even on failure.
        updateChat(chatId, {});
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            message: errMsg,
            assistantMessageId: partial?.id ?? null,
          }),
        });
        return;
      } finally {
        clearInterval(heartbeat);
      }

      const assistantMsg = insertChatMessage({
        chatId,
        role: "assistant",
        content: content || "",
        openFiles,
        costTokens: usage,
        toolCalls: toolTrace.map(({ id: _id, ...rest }) => rest),
      });
      // Touch the chat's updated_at so it floats to the top of the sidebar.
      updateChat(chatId, {});
      // Dev debug: append a one-line turn summary to agent.log so a dev can
      // scan the tail of the log without expanding JSON blobs. (Full per-step
      // payloads are appended by wrapStream above.)
      if (debugToFile) {
        try {
          const project = getCurrentProject();
          if (project) {
            const logPath = join(project.dissertatorDir, "logs", "agent.log");
            const stamp = new Date().toISOString();
            const summary =
              `${stamp} [turn done] steps=${debugStep} tools_used=${toolCalls} ` +
              `tokens=${usage.prompt}↑/${usage.completion}↓ ` +
              `capped=${capped} aborted=${aborted}\n` +
              `  reply: ${JSON.stringify(content.slice(0, 200))}${content.length > 200 ? " …" : ""}\n`;
            void import("node:fs/promises").then((fs) => fs.appendFile(logPath, summary, "utf8")).catch(() => {});
          }
        } catch {
          /* logging must never throw */
        }
      }
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({
          userMessageId: userMsg?.id ?? null,
          assistantMessageId: assistantMsg.id,
          aborted,
          usage,
          toolCalls,
          capped,
        }),
      });
    });
  });
}
