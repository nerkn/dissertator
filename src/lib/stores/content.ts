// Content store — the open project's data: settings, sources, documents,
// references, and per-doc revision counters.
//
// Owns data + pure updaters (handleDocumentEdited bumps a doc's revision so
// its editor reloads; handleSettingsChange re-fetches after the dialog saves).
// Raw setters are exposed because refresh-on-project-open + SSE live in
// useApp (they need the project guard + setError, which is session-domain).

import { create } from "zustand";
import { api } from "../api";
import type {
  Document,
  Reference,
  Settings,
  SourceFile,
  SourcesResponse,
} from "@dissertator/shared";

// Stable fallback so selectors returning "sources or empty" don't mint a new
// array each read (which would break useSyncExternalStore's snapshot cache
// and loop React forever). See useSourceItems below.
const EMPTY_SOURCES: SourceFile[] = [];

interface ContentState {
  settings: Settings | null;
  sources: SourcesResponse | null;
  documents: Document[];
  /** All references in the open project, keyed by `source_file_id` for O(1)
   *  lookup (tab-title resolution). Null until first fetch completes. */
  referencesBySource: Map<string, Reference> | null;
  /** Per-document revision counters. Bumped whenever the agent edits a
   *  document so its editor live-reloads the new body. Keyed by document id. */
  docRevisions: Record<string, number>;

  setSettings: (settings: Settings | null) => void;
  setSources: (sources: SourcesResponse | null) => void;
  setDocuments: (documents: Document[]) => void;
  setReferences: (refs: Reference[]) => void;
  /** The agent wrote/changed a document: upsert it into the list and bump its
   *  revision so its editor live-reloads. Pure reducer — no cross-domain deps. */
  handleDocumentEdited: (doc: Document) => void;
  /** Re-fetch settings (after the Settings dialog persists selections/prompts)
   *  so the derived per-function keys + Library provider chips recompute. */
  handleSettingsChange: () => Promise<void>;
}

export const useContentStore = create<ContentState>((set) => ({
  settings: null,
  sources: null,
  documents: [],
  referencesBySource: null,
  docRevisions: {},

  setSettings: (settings) => set({ settings }),
  setSources: (sources) => set({ sources }),
  setDocuments: (documents) => set({ documents }),
  setReferences: (refs) => {
    const m = new Map<string, Reference>();
    for (const r of refs) if (r.source_file_id) m.set(r.source_file_id, r);
    set({ referencesBySource: m });
  },

  handleDocumentEdited: (doc) =>
    set((s) => ({
      documents: s.documents.some((d) => d.id === doc.id)
        ? s.documents.map((d) => (d.id === doc.id ? { ...d, ...doc } : d))
        : [...s.documents, doc],
      docRevisions: {
        ...s.docRevisions,
        [doc.id]: (s.docRevisions[doc.id] ?? 0) + 1,
      },
    })),

  handleSettingsChange: async () => {
    try {
      set({ settings: await api.getSettings() });
    } catch {
      /* sidecar mid-restart */
    }
  },
}));

/** The current project's source list, or a stable empty array when no
 *  project is open. Prefer this over `useContentStore((s) => s.sources?.items
 *  ?? [])` — the inline `[]` literal returns a fresh reference every snapshot
 *  read and trips an infinite re-render loop in React 18's
 *  useSyncExternalStore. */
export function useSourceItems(): SourceFile[] {
  return useContentStore((s) => s.sources?.items ?? EMPTY_SOURCES);
}
