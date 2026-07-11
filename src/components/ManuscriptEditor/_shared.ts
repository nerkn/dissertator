// Cross-file types shared across the ManuscriptEditor components. Each
// component's own Props interface lives with that component; this file only
// holds types (and re-exports) consumed by more than one file.

/** Autosave lifecycle, shown as a small status pip in the toolbar. */
export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export type { CitationClickHandler } from "../../lib/citationPlugin";
