/**
 * A predefined prompt loaded from the project's `Dissertator/prompts.md`.
 * `category` comes from a `## Heading` (applies to following bullets); `label`
 * comes from a `**Label**:` prefix, else a truncated prompt. Surfaced at
 * `GET /prompts` so the frontend can render a quick-pick menu.
 */
export interface Prompt {
  category?: string;
  label: string;
  prompt: string;
}

/**
 * Serialize a `Prompt[]` back into the `prompts.md` markdown shape that
 * {@link parsePrompts} (sidecar) reads: a `## Category` heading whenever the
 * category changes, then one `- **Label**: prompt` bullet per prompt. The
 * inverse of the sidecar parser — used by the Settings → Prompts tab to turn
 * the structured editor's rows back into the file. Empty rows are dropped so
 * a half-typed Add row never writes junk. Pure + exported for tests.
 */
export function serializePrompts(prompts: Prompt[]): string {
  const lines: string[] = ["# Prompts", ""];
  let lastCat: string | undefined;
  let emitted = false;
  for (const p of prompts) {
    const label = p.label.trim();
    const text = p.prompt.trim();
    // Skip a row that has neither label nor text (a half-typed Add row).
    if (!label && !text) continue;
    const cat = p.category?.trim() || undefined;
    if (cat !== lastCat) {
      if (emitted) lines.push("");
      lines.push(`## ${cat ?? "Prompts"}`);
      lastCat = cat;
      emitted = true;
    }
    lines.push(`- **${label || "Untitled"}**: ${text}`);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Lists & notes (collect-while-reading → cite-while-writing)
// ---------------------------------------------------------------------------
//
// While reading a source PDF, the user selects a passage and saves it as a
// Note into one of a small set of Lists. Both the selected text (excerpt)
// and the user's own note (body) are OPTIONAL. Later, when writing, the user
// turns a saved note into a citation `[@citekey:page]` (the citekey is the
// note's source's linked reference). `lists` is the ONE integer-PK table in
// the schema (1-4 seeded); every other id in the app is TEXT.

/** A user list a note can be saved into. Seeded defaults are non-deletable. */
export interface List {
  /** INTEGER primary key (1-4 seeded; auto-increment for user-added). */
  id: number;
  label: string;
  /** Phosphor icon name, rendered dynamically in the UI. */
  icon: string;
  /** Hex accent color for the dot/badge. */
  color: string;
  /** Display order, ascending. */
  ord: number;
  /** true = seeded built-in (non-deletable); false = user-added. */
  system: boolean;
}

/** The 4 predefined lists seeded at project init (ids 1-4, system=true). */
export const LIST_SEEDS: Array<
  Pick<List, "id" | "label" | "icon" | "color" | "ord">
> = [
  { id: 1, label: "Favorites", icon: "Star", color: "#f5a623", ord: 1 },
  { id: 2, label: "Saved", icon: "BookmarkSimple", color: "#4a90e2", ord: 2 },
  { id: 3, label: "Important", icon: "WarningCircle", color: "#e0584c", ord: 3 },
  { id: 4, label: "To revisit", icon: "ArrowUUpLeft", color: "#7b61ff", ord: 4 },
];
