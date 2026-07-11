import type { List } from "@dissertator/shared";
import { base, req } from "./_client";

export const listsApi = {
  // --- Lists & notes (collect-while-reading → cite-while-writing) ---------
  // `lists.id` is INTEGER; note ids are TEXT (same as everything else). The
  // delete routes return 204 with no body, so those clients don't parse JSON.

  /** All lists (built-in seeded + user-added), ordered by display order. */
  listLists: () => req<List[]>("/lists"),
  createList: (input: { label: string; icon?: string; color?: string }) =>
    req<List>("/lists", { method: "POST", body: JSON.stringify(input) }),
  updateList: (
    id: number,
    patch: { label?: string; icon?: string; color?: string; ord?: number },
  ) =>
    req<List>(`/lists/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  /** Delete a user list (cascades its notes). Built-in lists 400 server-side. */
  deleteList: (id: number) =>
    fetch(`${base()}/lists/${id}`, { method: "DELETE" }).then(async (r) => {
      if (!r.ok) throw new Error((await r.text().catch(() => "")) || `${r.status}`);
    }),
};
