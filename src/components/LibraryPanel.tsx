import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  Gear,
} from "@phosphor-icons/react";
import type {
  Document,
  EmbeddingStatus,
  OcrStrategy,
  ProjectStatus,
  Provider,
  SourceFile,
  SourcesResponse,
} from "@dissertator/shared";
import { api } from "../lib/api";
import { AttentionPanel } from "./AttentionPanel";
import { StatusBadge } from "./StatusBadge";

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
  /** Embedding API key (separate slot from the chat key). When set + there are
   *  pending chunks, the Sources group offers an "Embed now" action. */
  embeddingApiKey?: string;
  /** Open a source in the CenterPane viewer (click-to-open). */
  onOpen?: (src: SourceFile) => void;
  /** Manuscript documents for the 🟡 Documents group. */
  documents?: Document[];
  /** Create + open a new document. */
  onNewDocument?: () => void;
  /** Open an existing document in the editor. */
  onOpenDocument?: (doc: Document) => void;
  /** Open the Settings dialog (used by the embedding no-key nudge). */
  onOpenSettings?: () => void;
  /** Open the bibliography manager as a center-pane tab. Fired by the
   *  📒 References group card. */
  onOpenReferences?: () => void;
}

const ATTENTION_STATUSES: SourceFile["textStatus"][] = [
  "needs_ocr",
  "pending_vision",
  "failed",
];

/** CSS class suffix for a source row's colored dot, by ingest kind.
 *  Maps to `.source-dot.<suffix>` rules in styles.css. */
function kindDotClass(kind: string): string {
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

export function LibraryPanel({
  project,
  sources,
  onRescan,
  onAttentionResolved,
  busy,
  provider,
  ocrStrategy,
  apiKey,
  embeddingApiKey,
  onOpen,
  documents,
  onNewDocument,
  onOpenDocument,
  onOpenSettings,
  onOpenReferences,
}: Props) {
  // All hooks run BEFORE the early return (rules of hooks): the panel mounts
  // even on a not-yet-initialized project, so hook order must stay stable.
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(true);
  const [embed, setEmbed] = useState<EmbeddingStatus | null>(null);
  const [embedBusy, setEmbedBusy] = useState(false);
  const [embedError, setEmbedError] = useState<string | null>(null);

  // Aggregate embedding progress (5s poll). Cheap; drives the one-line
  // summary in the Sources group header. Per-file embed status isn't exposed
  // by the sidecar yet, so this is corpus-wide only (see P3 workstream spec).
  useEffect(() => {
    if (!project?.initialized) return;
    let stopped = false;
    const tick = async (): Promise<void> => {
      try {
        const e = await api.embedStatus();
        if (!stopped) setEmbed(e);
      } catch {
        /* sidecar mid-restart; next tick retries */
      }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [project?.initialized]);

  // "Embed now": push all pending chunks through the embedding provider.
  // Requires the embedding key (separate from the chat key). Errors from the
  // adapter surface inline (auth/network) without crashing; a missing key is
  // caught up front with an actionable message.
  const runEmbed = useCallback(async () => {
    setEmbedError(null);
    if (!embeddingApiKey) {
      setEmbedError(
        "No embedding provider assigned. Open ⚙ Settings → Functions and pick one that has a key.",
      );
      return;
    }
    setEmbedBusy(true);
    try {
      await api.embed(embeddingApiKey);
      const e = await api.embedStatus();
      setEmbed(e);
    } catch (e) {
      setEmbedError((e as Error)?.message ?? String(e));
    } finally {
      setEmbedBusy(false);
    }
  }, [embeddingApiKey]);

  // Sorted + filtered source list. Filtering is client-side substring on
  // filename + relPath (case-insensitive) — semantic search is a separate flow.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = (sources?.items ?? [])
      .slice()
      .sort((a, b) => a.filename.localeCompare(b.filename));
    if (!q) return items;
    return items.filter(
      (s) =>
        s.filename.toLowerCase().includes(q) ||
        s.relPath.toLowerCase().includes(q),
    );
  }, [sources, query]);

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

  // One-line aggregate embedding summary (corpus-wide). Hidden until we have
  // a status fetch back; degrades to nothing rather than "0/0".
  const embedLine = (() => {
    if (!embed) return null;
    if (!embed.vecLoaded) return "embeddings disabled on this platform";
    if (embed.total > 0) return `${embed.done}/${embed.total} embedded`;
    return null;
  })();

  // Is the corpus fully embedded (semantic search ready)? Drives the
  // prominent status block + the Embed button.
  const embedReady = !!embed && embed.vecLoaded && embed.total > 0 &&
    embed.pending === 0 && embed.failed === 0;
  const embedHasPending = !!embed && embed.vecLoaded && embed.pending > 0;
  const embedHasKey = !!embeddingApiKey;

  return (
    <aside className="panel lib">
      <div className="panel-title">Library</div>
      <div className="search">
        <input
          placeholder="🔍 search sources…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="group blue">
        <div
          className="group-head group-head-row sources-head"
          onClick={() => setExpanded((v) => !v)}
          role="button"
          aria-expanded={expanded}
          title={expanded ? "Collapse" : "Expand"}
        >
          <span className="sources-head-title">
            {expanded ? (
              <CaretDown size={13} weight="bold" />
            ) : (
              <CaretRight size={13} weight="bold" />
            )}
            🔵 Sources
          </span>
          {onRescan && (
            <button
              className="btn ghost tiny-btn"
              onClick={(e) => {
                e.stopPropagation();
                onRescan();
              }}
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
        {embedLine && <div className="muted small">{embedLine}</div>}

        {/* Embedding status + action. Extraction ("done") only means the
            text was pulled out + chunked — it does NOT mean vectors exist.
            Make that distinction visible and offer a one-click embed. */}
        {embed && embed.vecLoaded && embed.total > 0 && !embedReady && (
          <div className={`embed-box${embedHasPending ? " pending" : ""}`}>
            <div className="embed-box-head">
              <span className="embed-box-title">
                {embed.done}/{embed.total} chunks embedded
              </span>
              <button
                className="btn ghost tiny-btn embed-btn"
                onClick={runEmbed}
                disabled={embedBusy || !embedHasKey}
                title={
                  embedHasKey
                    ? "Embed all pending chunks now"
                    : "Assign an embedding provider with a key in Settings → Functions"
                }
              >
                <ArrowsClockwise size={13} weight="bold" />
                {embedBusy ? "embedding…" : "Embed now"}
              </button>
              {!embedHasKey && onOpenSettings && (
                <button
                  className="btn ghost tiny-btn"
                  onClick={onOpenSettings}
                  title="Open Settings → Functions"
                >
                  <Gear size={13} weight="bold" />
                  Settings
                </button>
              )}
            </div>
            <div className="embed-box-sub muted small">
              {embed.pending > 0 && `${embed.pending} pending · `}
              {embed.failed > 0 && `${embed.failed} failed · `}
              {!embedHasKey
                ? "no embedding provider assigned — set one in Settings → Functions"
                : embedHasPending
                  ? "extraction is done, but vectors aren't built yet"
                  : "some chunks failed — retry to re-attempt them"}
            </div>
            {embedError && (
              <div className="embed-box-error">{embedError}</div>
            )}
          </div>
        )}
        {embedReady && (
          <div className="embed-box ready">
            <span className="embed-box-title">✓ corpus embedded</span>
            <span className="muted small">semantic search ready</span>
          </div>
        )}

        {expanded && (
          <div className="source-tree">
            {filtered.length === 0 ? (
              <div className="muted small source-tree-empty">
                {query ? "No matching sources." : "No sources yet."}
              </div>
            ) : (
              filtered.map((src) => (
                <div
                  key={src.id}
                  className="source-row"
                  title={src.relPath}
                  onClick={() => onOpen?.(src)}
                >
                  <span
                    className={`source-dot ${kindDotClass(src.kind)}`}
                  />
                  <span className="source-name">{src.filename}</span>
                  <StatusBadge status={src.textStatus} />
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="group yellow">
        <div className="group-head group-head-row">
          <span>🟡 Documents</span>
          {onNewDocument && (
            <button
              className="btn ghost tiny-btn"
              onClick={onNewDocument}
              title="Create a new document"
            >
              + New
            </button>
          )}
        </div>
        <div className="count">{(documents ?? []).length} drafts</div>
        <div className="muted small">Your papers &amp; dissertations</div>
        {(documents ?? []).length > 0 && (
          <div className="source-tree">
            {(documents ?? []).map((d) => (
              <div
                key={d.id}
                className="source-row"
                title={d.title}
                onClick={() => onOpenDocument?.(d)}
              >
                <span className="source-dot doc" />
                <span className="source-name">{d.title}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div
        className="group purple clickable"
        onClick={onOpenReferences}
        title={onOpenReferences ? "Open the bibliography manager" : ""}
      >
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
