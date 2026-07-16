// Tabs store — one tab per source/doc id. Reopening activates the existing
// tab; closing the active tab falls through to the last remaining one.
//
// setTabs/setActiveTabId are exposed because working-set persistence (restore
// on project open + debounced save) lives in useApp.

import { create } from "zustand";
import type { Document, SourceFile } from "@dissertator/shared";
import { kindForSource, REFERENCES_TAB_ID, type Tab } from "../tabs";

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  /** Replace the whole tab list (used by the restore effect). */
  setTabs: (tabs: Tab[]) => void;
  setActiveTabId: (id: string | null) => void;
  /** Open (or focus) a source tab. */
  openSource: (src: SourceFile) => void;
  /** Open (or focus) a source tab AND jump its viewer to a page (citation
   *  clicks). Bumps an existing tab's `initialPage`; creates one seeded with
   *  the page otherwise. A missing page leaves an existing initialPage. */
  openSourceAtPage: (src: SourceFile, page?: number) => void;
  /** Open a manuscript document in a new editor tab (one per doc id). */
  openDocument: (doc: Document) => void;
  /** Open the bibliography manager as a singleton center-pane tab. */
  openReferencesView: () => void;
  closeTab: (sourceId: string) => void;
}

export const useTabsStore = create<TabsState>((set) => ({
  tabs: [],
  activeTabId: null,
  setTabs: (tabs) => set({ tabs }),
  setActiveTabId: (id) => set({ activeTabId: id }),

  openSource: (src) =>
    set((s) => ({
      tabs: s.tabs.some((t) => t.sourceId === src.id)
        ? s.tabs
        : [
            ...s.tabs,
            { sourceId: src.id, kind: kindForSource(src.kind), title: src.filename },
          ],
      activeTabId: src.id,
    })),

  openSourceAtPage: (src, page) =>
    set((s) => {
      const existing = s.tabs.find((t) => t.sourceId === src.id);
      const tabs = existing
        ? s.tabs.map((t) =>
            t.sourceId === src.id
              ? { ...t, initialPage: page ?? t.initialPage }
              : t,
          )
        : [
            ...s.tabs,
            {
              sourceId: src.id,
              kind: kindForSource(src.kind),
              title: src.filename,
              initialPage: page,
            } as Tab,
          ];
      return { tabs, activeTabId: src.id };
    }),

  openDocument: (doc) =>
    set((s) => ({
      tabs: s.tabs.some((t) => t.sourceId === doc.id)
        ? s.tabs
        : [...s.tabs, { sourceId: doc.id, kind: "doc" as const, title: doc.title }],
      activeTabId: doc.id,
    })),

  openReferencesView: () =>
    set((s) => ({
      tabs: s.tabs.some((t) => t.sourceId === REFERENCES_TAB_ID)
        ? s.tabs
        : [
            ...s.tabs,
            {
              sourceId: REFERENCES_TAB_ID,
              kind: "references" as const,
              title: "References",
            },
          ],
      activeTabId: REFERENCES_TAB_ID,
    })),

  closeTab: (sourceId) =>
    set((s) => {
      const remaining = s.tabs.filter((t) => t.sourceId !== sourceId);
      // Closing the active tab → activate the last remaining one (or null).
      const activeTabId =
        s.activeTabId !== sourceId
          ? s.activeTabId
          : remaining.length > 0
            ? remaining[remaining.length - 1].sourceId
            : null;
      return { tabs: remaining, activeTabId };
    }),
}));

/**
 * The document the user is currently editing (the active `doc`-kind tab), if
 * any. Sent each chat turn as the default target for the agent's p_* tools.
 */
export function useActiveDocumentId(): string | undefined {
  return useTabsStore((s) => {
    if (!s.activeTabId) return undefined;
    const tab = s.tabs.find((t) => t.sourceId === s.activeTabId);
    return tab && tab.kind === "doc" ? tab.sourceId : undefined;
  });
}
