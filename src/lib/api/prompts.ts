import type { Prompt } from "@dissertator/shared";
import { req } from "./_client";

export const promptsApi = {
  // --- Predefined prompts (per-project prompts.md) -------------------------

  /** Parsed quick-fire prompts from `Dissertator/prompts.md` ([] if absent). */
  listPrompts: () => req<Prompt[]>("/prompts"),

  /** Raw `prompts.md` markdown ("" if absent) — seeds the Prompts-tab editor. */
  getPromptsMarkdown: () => req<string>("/prompts/raw"),

  /** Overwrite `prompts.md`; returns the re-parsed Prompt[] quick-pick list. */
  savePromptsMarkdown: (markdown: string) =>
    req<Prompt[]>("/prompts", {
      method: "PUT",
      body: JSON.stringify({ markdown }),
    }),
};
