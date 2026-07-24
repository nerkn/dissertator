import { type ChatEndpointConfig } from "@dissertator/shared";
import { streamOpenAIChat } from "../chat/openai.ts";
import { getSourceById, getSourceText, getSettings } from "../db";
import { getChatKey } from "../db/globalDb.ts";

const MAX_INPUT_CHARS = 4000;

const SYSTEM_PROMPT =
  "Summarize this source in ONE concise line (what it is, topic, type). " +
  "No preamble, <= 120 chars.";

export async function digestSource(
  id: string,
  opts?: { chatKey?: string },
): Promise<string | null> {
  const src = getSourceById(id);
  if (!src) return null;
  if (src.note && src.note.trim()) return src.note.trim();
  if (src.kind === "image") return null;
  const { text } = getSourceText(id);
  const snippet = text.slice(0, MAX_INPUT_CHARS).trim();
  if (!snippet) return null;

  const chatKey = opts?.chatKey ?? getChatKey();
  const cb = getSettings().resolved?.chat;
  const chatConfig: ChatEndpointConfig | null =
    chatKey && cb?.apiUrl && cb?.model
      ? { apiUrl: cb.apiUrl, model: cb.model }
      : null;
  if (!chatConfig || !chatKey) return null;

  let buf = "";
  try {
    await streamOpenAIChat({
      apiKey: chatKey,
      config: chatConfig,
      maxTokens: 200,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: snippet },
      ],
      onDelta: (d) => {
        buf += d;
      },
    });
  } catch (e) {
    console.error(`[digest] stream failed:`, (e as Error)?.message ?? String(e));
    return null;
  }

  const note = buf.trim();
  return note || null;
}
