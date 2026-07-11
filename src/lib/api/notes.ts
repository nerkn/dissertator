import type { Note, NoteRect } from "@dissertator/shared";
import { base, req } from "./_client";

export const notesApi = {
  /** Notes, optionally filtered by list and/or source (newest-first). */
  listNotes: (opts?: { listId?: number; sourceId?: string }) => {
    const params = new URLSearchParams();
    if (opts?.listId !== undefined) params.set("listId", String(opts.listId));
    if (opts?.sourceId) params.set("sourceId", opts.sourceId);
    const qs = params.toString();
    return req<Note[]>(`/notes${qs ? `?${qs}` : ""}`);
  },
  createNote: (input: {
    sourceId: string;
    page: number;
    excerpt?: string | null;
    body?: string | null;
    listId: number;
    rect?: NoteRect | null;
  }) => req<Note>("/notes", { method: "POST", body: JSON.stringify(input) }),
  updateNote: (
    id: string,
    patch: Partial<{
      excerpt: string | null;
      body: string | null;
      listId: number;
      rect: NoteRect | null;
    }>,
  ) =>
    req<Note>(`/notes/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  deleteNote: (id: string) =>
    fetch(`${base()}/notes/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }).then(async (r) => {
      if (!r.ok) throw new Error((await r.text().catch(() => "")) || `${r.status}`);
    }),
};
