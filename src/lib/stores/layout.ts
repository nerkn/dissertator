import { create } from "zustand";

const BASE_LIB = 280;
const BASE_CHAT = 340;
const MIN_LIB = BASE_LIB;
const MIN_CHAT = 240;
const STORAGE_KEY = "dissertator.layout.v1";

interface Saved {
  lib: number;
  chat: number;
}

function clampLib(v: number, winW: number): number {
  const max = Math.max(MIN_LIB, Math.floor(winW * 0.5));
  return Math.min(max, Math.max(MIN_LIB, Math.round(v)));
}

function clampChat(v: number, winW: number): number {
  const max = Math.max(MIN_CHAT, Math.floor(winW * 0.5));
  return Math.min(max, Math.max(MIN_CHAT, Math.round(v)));
}

function load(): Saved {
  const fallback: Saved = { lib: BASE_LIB, chat: BASE_CHAT };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Saved>;
      const w = window.innerWidth;
      return {
        lib: clampLib(Number.isFinite(p.lib) ? p.lib! : BASE_LIB, w),
        chat: clampChat(Number.isFinite(p.chat) ? p.chat! : BASE_CHAT, w),
      };
    }
  } catch {
    /* private mode / SSR — fall through to default */
  }
  return fallback;
}

function save(s: Saved): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore quota / private mode */
  }
}

interface LayoutState {
  libraryWidth: number;
  chatWidth: number;
  /** Grow (+) / shrink (-) the library. The chat panel donates first; once
   *  chat hits its floor, the center pane (1fr) absorbs the remainder. */
  adjustLibrary: (delta: number) => void;
  /** Grow (+) / shrink (-) the chat. The library panel donates first; once
   *  library hits its base, the center pane absorbs the remainder. */
  adjustChat: (delta: number) => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  libraryWidth: load().lib,
  chatWidth: load().chat,
  adjustLibrary: (delta) => {
    const s = get();
    const w = window.innerWidth;
    const newChat = clampChat(s.chatWidth - delta, w);
    const newLib = clampLib(s.libraryWidth + delta, w);
    save({ lib: newLib, chat: newChat });
    set({ libraryWidth: newLib, chatWidth: newChat });
  },
  adjustChat: (delta) => {
    const s = get();
    const w = window.innerWidth;
    const newLib = clampLib(s.libraryWidth - delta, w);
    const newChat = clampChat(s.chatWidth + delta, w);
    save({ lib: newLib, chat: newChat });
    set({ libraryWidth: newLib, chatWidth: newChat });
  },
}));

export const layout = { BASE_LIB, BASE_CHAT, MIN_CHAT };
