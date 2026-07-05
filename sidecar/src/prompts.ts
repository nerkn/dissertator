// Predefined prompts loader (P4): reads + parses the project's
// `Dissertator/prompts.md` into a flat `Prompt[]` for the frontend's
// quick-pick menu. Self-contained — no DB access.
//
// FORMAT (lenient):
//   `## Heading`     → sets the current category (applies to following bullets
//                      until the next heading).
//   `- text` / `* text` → one prompt. If `text` matches `**Label**: rest`,
//                      split into {label, prompt: rest}; else the whole text
//                      is the prompt and the label is the first ~40 chars.
//   blank / other lines → ignored.
//
// The file lives at `<dissertatorDir>/prompts.md` (same dir as the db). A
// missing file is NOT an error → returns `[]` (the frontend shows "no prompts
// — create prompts.md"). The file is never auto-created.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Prompt } from "@dissertator/shared";
import { getCurrentProject } from "./db.ts";

/** Max label length for a plain (un-labeled) bullet before truncation. */
const LABEL_MAX = 40;

/**
 * Label-then-prompt split. Matches `**Label**: prompt` (label bold, colon,
 * rest). Returns `[label, prompt]` on a match, else null.
 */
const LABELLED = /^\*\*(.+?)\*\*\s*:\s*(.+)$/;

/**
 * Parse a `prompts.md` document into a flat {@link Prompt}[].
 *
 * Headings (`## X`) set the category for following bullets; bullets (`- ` or
 * `* `) each produce one prompt. Blank lines and any other line (prose) are
 * skipped. An empty / bullet-less document returns `[]`. Pure + exported so
 * it can be unit-tested without a DB.
 */
export function parsePrompts(markdown: string): Prompt[] {
  const out: Prompt[] = [];
  let category: string | undefined;
  const lines = markdown.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Heading → set the current category (applies until the next heading).
    if (line.startsWith("## ")) {
      category = line.slice(3).trim() || undefined;
      continue;
    }
    // Bullet (`- ` or `* `) → one prompt.
    let text: string | null = null;
    if (line.startsWith("- ")) {
      text = line.slice(2).trim();
    } else if (line.startsWith("* ")) {
      text = line.slice(2).trim();
    } else {
      // Prose / anything else → ignored.
      continue;
    }
    if (!text) continue;
    const m = LABELLED.exec(text);
    if (m) {
      out.push({ category, label: m[1].trim(), prompt: m[2].trim() });
    } else {
      const trimmed = text;
      const label =
        trimmed.length > LABEL_MAX
          ? trimmed.slice(0, LABEL_MAX).trimEnd() + "…"
          : trimmed;
      out.push({ category, label, prompt: trimmed });
    }
  }
  return out;
}

/**
 * Load + parse the current project's `Dissertator/prompts.md`. Returns `[]`
 * if no project is open OR the file does not exist (the frontend shows "no
 * prompts — create prompts.md"). Never throws on a missing file.
 */
export async function getPrompts(): Promise<Prompt[]> {
  const project = getCurrentProject();
  if (!project) return [];
  const path = join(project.dissertatorDir, "prompts.md");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    // Missing file (or unreadable) → no prompts. Not an error.
    return [];
  }
  return parsePrompts(text);
}

/** Raw markdown of the project's `prompts.md`, or "" if absent (P6 Prompts
 *  tab seeds the editor from this). */
export async function readPromptsMarkdown(): Promise<string> {
  const project = getCurrentProject();
  if (!project) return "";
  try {
    return await readFile(join(project.dissertatorDir, "prompts.md"), "utf8");
  } catch {
    return "";
  }
}

/**
 * Overwrite `prompts.md` with the given markdown (P6 Prompts tab). Creates
 * the file if missing. Throws on write failure (the caller maps to a 500).
 */
export async function savePrompts(markdown: string): Promise<void> {
  const project = getCurrentProject();
  if (!project) throw new Error("no project initialized");
  await writeFile(
    join(project.dissertatorDir, "prompts.md"),
    markdown,
    "utf8",
  );
}
