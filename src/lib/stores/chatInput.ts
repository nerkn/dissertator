import { create } from "zustand";

interface ChatInputState {
  token: number;
  text: string;
  request: (text: string) => void;
}

export const useChatInputStore = create<ChatInputState>((set) => ({
  token: 0,
  text: "",
  request: (t) => set((s) => ({ text: t, token: s.token + 1 })),
}));
