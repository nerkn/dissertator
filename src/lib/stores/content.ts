// Content store — the open project's data: settings, sources, references,
// and per-source revision counters.
//
// Owns data + pure updaters (bumpSourceRevision bumps an md source's revision
// so its editor reloads; handleSettingsChange re-fetches after the dialog
// saves). Raw setters are exposed because refresh-on-project-open + SSE live
// in useApp (they need the project guard + setError, which is session-domain).

import { create } from "zustand";
import { api } from "../api";
import type {
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
  /** All references in the open project, keyed by `source_file_id` for O(1)
   *  lookup (tab-title resolution). Null until first fetch completes. */
  referencesBySource: Map<string, Reference> | null;
  /** Per-source revision counters (markdown sources edited by the agent or
   *  the user). Bumped so an open editor live-reloads the new body from disk. */
  sourceRevisions: Record<string, number>;

  setSettings: (settings: Settings | null) => void;
  setSources: (sources: SourcesResponse | null) => void;
  setReferences: (refs: Reference[]) => void;
  /** The agent wrote a markdown source file: bump its revision so an open
   *  editor live-reloads the new body. No store row (the file on disk is the
   *  source of truth). */
  bumpSourceRevision: (sourceId: string) => void;
  /** Re-fetch settings (after the Settings dialog persists selections/prompts)
   *  so the derived per-function keys + Library provider chips recompute. */
  handleSettingsChange: () => Promise<void>;
}

export const useContentStore = create<ContentState>((set) => ({
  settings: null,
  sources: null,
  referencesBySource: null,
  sourceRevisions: {},

  setSettings: (settings) => set({ settings }),
  setSources: (sources) => set({ sources }),
  setReferences: (refs) => {
    const m = new Map<string, Reference>();
    for (const r of refs) if (r.source_file_id) m.set(r.source_file_id, r);
    set({ referencesBySource: m });
  },

  handleSettingsChange: async () => {
    try {
      set({ settings: await api.getSettings() });
    } catch {
      /* sidecar mid-restart */
    }
  },

  bumpSourceRevision: (sourceId) =>
    set((s) => ({
      sourceRevisions: {
        ...s.sourceRevisions,
        [sourceId]: (s.sourceRevisions[sourceId] ?? 0) + 1,
      },
    })),
}));

/** The current project's source list, or a stable empty array when no
 *  project is open. Prefer this over `useContentStore((s) => s.sources?.items
 *  ?? [])` — the inline `[]` literal returns a fresh reference every snapshot
 *  read and trips an infinite re-render loop in React 18's
 *  useSyncExternalStore. */
export function useSourceItems(): SourceFile[] {
  return useContentStore((s) => s.sources?.items ?? EMPTY_SOURCES);
}
