// Cross-file helpers for the LibraryPanel sub-components.

import type { SourceFile } from "@dissertator/shared";

/** Source rows whose ingest needs user attention (surfaced in the
 *  AttentionPanel at the bottom of the Library). */
export const ATTENTION_STATUSES: SourceFile["textStatus"][] = [
  "needs_ocr",
  "pending_vision",
  "failed",
];

/** CSS class suffix for a source row's colored dot, by ingest kind.
 *  Maps to `.source-dot.<suffix>` rules in styles.css. */
export function kindDotClass(kind: string): string {
  switch (kind) {
    case "pdf":
      return "pdf";
    case "image":
      return "image";
    case "text":
      return "text";
    case "docx":
    case "xlsx":
      return "doc";
    default:
      return "other"; // unsupported / unknown → muted
  }
}
