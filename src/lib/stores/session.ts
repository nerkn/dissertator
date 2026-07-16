// Session store — app-wide scalars: sidecar health, open project status,
// the error toast, the global busy flag, and Settings-dialog visibility.
// Pure state + setters; lifecycle (health poll, project load) lives in
// useApp. Derived flags (initialized/configured) stay at the call site.

import { create } from "zustand";
import type { ProjectStatus } from "@dissertator/shared";

export type Health = "checking" | "up" | "down";

interface SessionState {
  health: Health;
  project: ProjectStatus | null;
  error: string | null;
  busy: boolean;
  showSettings: boolean;
  setHealth: (h: Health) => void;
  setProject: (p: ProjectStatus | null) => void;
  setError: (e: string | null) => void;
  setBusy: (b: boolean) => void;
  setShowSettings: (s: boolean) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  health: "checking",
  project: null,
  error: null,
  busy: false,
  showSettings: false,
  setHealth: (health) => set({ health }),
  setProject: (project) => set({ project }),
  setError: (error) => set({ error }),
  setBusy: (busy) => set({ busy }),
  setShowSettings: (showSettings) => set({ showSettings }),
}));
