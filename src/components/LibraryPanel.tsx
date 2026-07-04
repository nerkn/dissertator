import { ArrowsClockwise } from "@phosphor-icons/react";
import type {
  OcrStrategy,
  ProjectStatus,
  Provider,
  SourceFile,
  SourcesResponse,
} from "@dissertator/shared";
import { AttentionPanel } from "./AttentionPanel";

interface Props {
  project: ProjectStatus | null;
  /** Live source list + counts from `/sources`. Optional; falls back to
   *  `project.counts.sourceFiles` when absent (e.g. before first fetch). */
  sources?: SourcesResponse | null;
  /** Click handler for the rescan button. */
  onRescan?: () => void;
  /** Fired when an attention item is resolved (OCR ran). Refreshes the
   *  source list. Defaults to `onRescan` when not supplied. */
  onAttentionResolved?: () => void;
  /** While a rescan / OCR call is in flight, disable the rescan button. */
  busy?: boolean;
  /** Provider + strategy forwarded to the AttentionPanel. */
  provider?: Provider;
  ocrStrategy?: OcrStrategy;
  apiKey?: string;
}

const ATTENTION_STATUSES: SourceFile["textStatus"][] = [
  "needs_ocr",
  "pending_vision",
  "failed",
];

export function LibraryPanel({
  project,
  sources,
  onRescan,
  onAttentionResolved,
  busy,
  provider,
  ocrStrategy,
  apiKey,
}: Props) {
  if (!project?.initialized) {
    return (
      <aside className="panel lib">
        <div className="panel-title">Library</div>
        <p className="muted">
          Open a research folder to build your corpus. Files are scanned,
          extracted, OCR'd, and indexed for grounded retrieval.
        </p>
      </aside>
    );
  }

  const c = project.counts;
  const sc = sources?.counts;
  // Prefer live counts from the ingest surface when available.
  const sourceCount = sc ? sc.total : c.sourceFiles;
  const doneCount = sc ? sc.done : null;
  const needsOcrCount = sc ? sc.needsOcr : null;
  const failedCount = sc ? sc.failed : null;
  const extractingCount = sc ? sc.extracting : null;

  const attentionItems = (sources?.items ?? []).filter((i) =>
    ATTENTION_STATUSES.includes(i.textStatus),
  );

  return (
    <aside className="panel lib">
      <div className="panel-title">Library</div>
      <div className="search">
        <input placeholder="🔍 search sources (P3)" disabled />
      </div>

      <div className="group blue">
        <div className="group-head group-head-row">
          <span>🔵 Sources</span>
          {onRescan && (
            <button
              className="btn ghost tiny-btn"
              onClick={onRescan}
              disabled={busy}
              title="Re-scan project root for new/changed files"
            >
              <ArrowsClockwise size={13} weight="bold" />
              {busy ? "scanning…" : "Rescan"}
            </button>
          )}
        </div>
        <div className="count">{sourceCount} files</div>
        {sc ? (
          <div className="muted small">
            {doneCount} done
            {extractingCount ? `, ${extractingCount} extracting` : ""}
            {needsOcrCount ? `, ${needsOcrCount} need OCR` : ""}
            {failedCount ? `, ${failedCount} failed` : ""}
          </div>
        ) : (
          <div className="muted small">
            PDFs, DOCX, XLSX, CSV, MD, TXT, images
          </div>
        )}
      </div>

      <div className="group yellow">
        <div className="group-head">🟡 Documents</div>
        <div className="count">{c.documents} drafts</div>
        <div className="muted small">Your papers &amp; dissertations</div>
      </div>

      <div className="group purple">
        <div className="group-head">📒 References</div>
        <div className="count">{c.references} entries</div>
        <div className="muted small">APA bibliography (citeproc)</div>
      </div>

      <AttentionPanel
        items={attentionItems}
        apiKey={apiKey}
        provider={provider}
        ocrStrategy={ocrStrategy ?? "tesseract"}
        onResolved={() => (onAttentionResolved ?? onRescan)?.()}
      />
    </aside>
  );
}
