import { create } from "zustand";
import {
  DEFAULT_THEME_ID,
  THEME_VAR_KEYS,
  themeById,
  type ThemeVar,
} from "../themes";

const STORAGE_KEY = "dissertator.theme.v1";

interface Saved {
  themeId: string;
  textOverride: string | null;
  mutedOverride: string | null;
}

interface ThemeState {
  themeId: string;
  textOverride: string | null;
  mutedOverride: string | null;
  setTheme: (id: string) => void;
  setTextOverride: (color: string | null) => void;
  setMutedOverride: (color: string | null) => void;
}

function load(): Saved {
  const fallback: Saved = {
    themeId: DEFAULT_THEME_ID,
    textOverride: null,
    mutedOverride: null,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Saved>;
      return {
        themeId: p.themeId && themeById(p.themeId) ? p.themeId : DEFAULT_THEME_ID,
        textOverride: typeof p.textOverride === "string" ? p.textOverride : null,
        mutedOverride:
          typeof p.mutedOverride === "string" ? p.mutedOverride : null,
      };
    }
  } catch {
  }
  return fallback;
}

function persist(s: Saved): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
  }
}

function applyVars(themeId: string, text: string | null, muted: string | null): void {
  const root = document.documentElement;
  for (const k of THEME_VAR_KEYS) {
    root.style.removeProperty(`--${k}`);
  }
  const t = themeById(themeId);
  if (!t) return;
  for (const k of THEME_VAR_KEYS) {
    root.style.setProperty(`--${k}`, t.vars[k as ThemeVar]);
  }
  if (text) root.style.setProperty("--text", text);
  if (muted) root.style.setProperty("--muted", muted);
  root.style.setProperty("color-scheme", t.colorScheme);
}

const initial = load();
applyVars(initial.themeId, initial.textOverride, initial.mutedOverride);

export const useThemeStore = create<ThemeState>((set, get) => ({
  themeId: initial.themeId,
  textOverride: initial.textOverride,
  mutedOverride: initial.mutedOverride,
  setTheme: (id) => {
    if (!themeById(id)) return;
    const s = get();
    applyVars(id, s.textOverride, s.mutedOverride);
    persist({ themeId: id, textOverride: s.textOverride, mutedOverride: s.mutedOverride });
    set({ themeId: id });
  },
  setTextOverride: (color) => {
    const s = get();
    applyVars(s.themeId, color, s.mutedOverride);
    persist({ themeId: s.themeId, textOverride: color, mutedOverride: s.mutedOverride });
    set({ textOverride: color });
  },
  setMutedOverride: (color) => {
    const s = get();
    applyVars(s.themeId, s.textOverride, color);
    persist({ themeId: s.themeId, textOverride: s.textOverride, mutedOverride: color });
    set({ mutedOverride: color });
  },
}));
