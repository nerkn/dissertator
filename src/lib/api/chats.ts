import type { Chat, ChatMessage } from "@dissertator/shared";
import { req } from "./_client";

export const chatsApi = {
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
};
