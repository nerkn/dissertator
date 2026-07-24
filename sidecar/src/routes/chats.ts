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
import { getAgentPersona, readPreferences } from "../agent-files.ts";
import {
  runAgentLoop,
  type AgentStreamEvent,
} from "../agent/loop.ts";
import { completeChat, streamOpenAIChat, type LoopMessage, type ToolSpec } from "../chat/openai.ts";
import type { ToolContext } from "../agent/tools.ts";

const OPENER_INSTRUCTION =
  "This is a brand-new chat and the user hasn't said anything yet. Greet them in ONE short sentence, then orient: you can already see the full corpus and the active manuscript above. Propose 2–3 concrete next steps (e.g. read a specific source, draft or revise a section, compare sources, fill a citation gap) and surface them as one-tap choices via suggest. Keep it brief — do NOT read documents or run heavy tools yet; just propose and let the user pick.";

function sanitizeTitle(raw: string): string {
  let t = raw.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  t = t.replace(/[.·:]\s*$/, "").trim();
  if (t.length > 80) t = t.slice(0, 80).trim();
  return t;
}

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
    if (isOpener && listChatMessages(chatId, 1).length > 0) {
      return c.json({ error: "chat not empty" }, 400);
    }

    const auth = c.req.header("Authorization") ?? "";
    const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!apiKey) return c.json({ error: "chat api key required" }, 400);

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

      const recent = listChatMessages(chatId, 20).filter(
        (m) => m.role !== "system" && (userMsg ? m.id !== userMsg.id : true),
      );
      const prevOpenFiles = recent.length
        ? recent[recent.length - 1].openFiles ?? []
        : [];

      const systemParts: string[] = [
        "You are Dissertator, a research writing assistant. You help the user read sources and write their manuscript.",
        "",
        "You have tools — use them proactively:",
        "- list({query?}) semantic-searches the embedded corpus; ({author,title,filename,limit}) filters the reference index. Returns lean metadata + each source's handle (`filename`); call read for full text.",
        "- read({id?, page?} | {id?, offset?, limit?}) reads text. Paginated sources (PDF/docx) take `page`; the manuscript or any `.md` source takes an `offset`+`limit` char window. `id` defaults to the active document.",
        "- create({title, text?}) creates a new manuscript and returns its id + body.",
        "- edit({id?, op, anchor?, text}) mutates the manuscript or a `.md` source. `op:\"replace\"` swaps the first verbatim `anchor` for `text`; `op:\"insert\"` inserts `text` after the first `anchor` (empty/omitted anchor = top). `id` defaults to the active document; non-markdown sources are read-only via read.",
        "- show({id}) opens a document or source in the UI for the user to view.",
        "- suggest({options:[{short,prompt}]}) offers quick-reply buttons the user taps to choose the next step (the run does NOT pause). This is your DEFAULT turn-ending action — see \"Response pattern\" below. Think of it as \"suggested replies\" (like Gmail/Slack), NOT configuration.",
        "- pref_add({ text }) records ONE durable user preference or correction as a bullet (read into every future chat). Call it the moment the user expresses a LASTING preference OR corrects you / shows frustration — distill it into one forward rule (what TO do). NEVER for one-off or transient requests.",
        "- toast({action, text}) narrates a milestone (action: \"warn\" | \"celebrate\" | \"info\").",
        "",
        "Tools that take `id` (read, edit) act on the active manuscript when `id` is omitted.",
        "Manuscript edits are CONTENT-ADDRESSED: pass the exact `anchor` you got from read. If edit fails because the text wasn't found, read again — the user may have edited meanwhile.",
        "Cite sources inline as [@citekey] or [@citekey:42] (page). Prefer grounded claims; say plainly when the sources are insufficient.",
        "",
        "# Response pattern (REQUIRED)",
        "END EVERY TURN WITH suggest offering 2–4 concrete next-step buttons. This is your single most important habit. Whenever you would pose a bare question or list alternatives in prose, wrap them as buttons instead. The only exceptions: (a) the user asked a direct factual question and you just answered it, or (b) the task is fully complete with nothing left to choose. Never end with a plain question like \"What would you like next?\" or \"Should I do A or B?\" — that is a suggest call, not prose. Never end a turn without calling suggest unless one of the two exceptions clearly applies.",
      ];
      const persona = await getAgentPersona();
      if (persona.personality.trim() || persona.rules.trim()) {
        const block: string[] = [];
        if (persona.personality.trim()) block.push("", "# Personality", persona.personality.trim());
        if (persona.rules.trim()) block.push("", "# Rules", persona.rules.trim());
        systemParts.splice(1, 0, ...block);
      }
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
          `The user is currently editing the manuscript "${d?.title ?? "(unknown)"}" (id: ${activeDocId}). read/edit without an explicit \`id\` act on it.`
        );
      }
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
          "Every source in this project — TSV: citekey <TAB> title <TAB> year <TAB> authors. Cite inline as [@citekey]; call list({title}) or ({author}) to resolve a source id, then read(id) for full text.",
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
            `\nPinned sources (UNCHANGED since last turn — full text already seen; call read(id) to re-read): ${openFiles.map(labelOf).join("; ")}.`,
          );
        } else if (ctx) {
          systemParts.push(
            `\nThe user has pinned these source files (full text below) as grounding context:\n\n${ctx}`,
          );
        }
      }
      const messages: LoopMessage[] = [
        { role: "system", content: systemParts.join("\n") },
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
      let content = "";
      stream.onAbort(() => {
        aborted = true;
        ac.abort();
      });

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
          }
        }
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
      updateChat(chatId, {});
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
