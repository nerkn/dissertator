// Shared text-status badge used by both the LibraryPanel source tree and the
// AttentionPanel. Extracted here so the two listings render identical labels
// + colors for the same TextStatus. Pure/presentational — no fetches.

import type { TextStatus } from "@dissertator/shared";

/** Visual config for each TextStatus (label + CSS badge class). */
const STATUS_MAP: Record<TextStatus, { label: string; cls: string }> = {
  new: { label: "new", cls: "badge gray" },
  extracting: { label: "extracting", cls: "badge yellow" },
  done: { label: "done", cls: "badge green" },
  needs_ocr: { label: "needs OCR", cls: "badge orange" },
  ocr_tesseract: { label: "OCR tesseract", cls: "badge yellow" },
  pending_vision: { label: "pending vision", cls: "badge orange" },
  needs_transcription: { label: "needs transcription", cls: "badge orange" },
  pending_transcription: { label: "transcribing", cls: "badge yellow" },
  failed: { label: "failed", cls: "badge red" },
};

/** Small colored badge for a file's text-status. */
export function StatusBadge({ status }: { status: TextStatus }) {
  const m = STATUS_MAP[status] ?? STATUS_MAP.new;
  return <span className={m.cls}>{m.label}</span>;
}
