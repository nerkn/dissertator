import type { Hono } from "hono";
import { join } from "node:path";
import { streamSSE } from "hono/streaming";
import type { ChatRequest, ToolTrace } from "@dissertator/shared";
import {
  buildOpenFilesContext,
  createChat,
  deleteChat,
  getChat,
  getCurrentProject,
  getDocument,
  getSettings,
  insertChatMessage,
  listChatMessages,
  listChats,
  updateChat,
} from "../db";
import { readPreferences } from "../agent-files.ts";
import {
  runAgentLoop,
  type AgentStreamEvent,
} from "../agent/loop.ts";
import { streamOpenAIChat, type LoopMessage, type ToolSpec } from "../chat/openai.ts";
import type { ToolContext } from "../agent/tools.ts";

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
    const message = (body.message ?? "").trim();
    if (!message) return c.json({ error: "message required" }, 400);
    const openFiles = Array.isArray(body.openFiles) ? body.openFiles : [];

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
      const userMsg = insertChatMessage({
        chatId,
        role: "user",
        content: message,
        openFiles,
      });

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
      const ctx = buildOpenFilesContext(openFiles);
      if (ctx) {
        systemParts.push(
          `\nThe user has the following source files open as grounding context:\n\n${ctx}`
        );
      }
      const messages: LoopMessage[] = [
        { role: "system", content: systemParts.join("\n") },
        // Replay THIS chat's recent turns for conversational continuity (omit
        // system rows; we synthesize our own above). Only text content is
        // replayed — the tool-call trace lives in the current run only.
        ...listChatMessages(chatId, 20)
          .filter((m) => m.role !== "system" && m.id !== userMsg.id)
          .slice(-12)
          .map(
            (m): LoopMessage => ({
              role: m.role === "assistant" ? "assistant" : "user",
              content: m.content ?? "",
            })
          ),
        { role: "user", content: message },
      ];

      const ac = new AbortController();
      let aborted = false;
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

      let content = "";
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
          stepTimeoutMs: Number(process.env.CHAT_STEP_TIMEOUT_MS) || 30_000,
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
          userMessageId: userMsg.id,
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
