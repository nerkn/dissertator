// SourcesGroup — the 🔵 Sources section of the Library panel.
//
// Owns its own state: the collapse toggle, the corpus-wide embedding poll +
// "Embed now" action, and the client-side filter against the panel-level
// search query. Renders the group header (with rescan), the embedding status
// block, and the source tree.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  Gear,
} from "@phosphor-icons/react";
import type {
  EmbeddingStatus,
  ProjectStatus,
  SourceFile,
  SourcesResponse,
} from "@dissertator/shared";
import { api } from "../../lib/api";
import { StatusBadge } from "../StatusBadge";
import { kindDotClass } from "./_shared";

interface Props {
  project: ProjectStatus;
  /** Live source list + counts from `/sources`. */
  sources?: SourcesResponse | null;
  /** Panel-level search query (client-side substring filter). */
  query: string;
  /** Click handler for the rescan button. */
  onRescan?: () => void;
  /** While a rescan / OCR call is in flight, disable the rescan button. */
  busy?: boolean;
  /** Embedding API key for a REMOTE embed provider. Not required when the
   *  bound embed provider is keyless (local granite) — see embedStatus.keyless. */
  embeddingApiKey?: string;
  /** Click-to-open a source in the CenterPane viewer. */
  onOpen?: (src: SourceFile) => void;
  /** Open the Settings dialog (used by the embedding no-key nudge). */
  onOpenSettings?: () => void;
}

export function SourcesGroup({
  project,
  sources,
  query,
  onRescan,
  busy,
  embeddingApiKey,
  onOpen,
  onOpenSettings,
}: Props) {
  const [expanded, setExpanded] = useState(true);
  const [embed, setEmbed] = useState<EmbeddingStatus | null>(null);
  const [embedBusy, setEmbedBusy] = useState(false);
  const [embedError, setEmbedError] = useState<string | null>(null);

  // Aggregate embedding progress (5s poll). Cheap; drives the one-line
  // summary in the header + the status block. Per-file embed status isn't
  // exposed by the sidecar yet, so this is corpus-wide only.
  useEffect(() => {
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
  }, [project.initialized]);

  // "Embed now": push all pending chunks through the embedding provider.
  // Requires the embedding key. A missing key is caught up front with an
  // actionable message; adapter errors (auth/network) surface inline.
  const runEmbed = useCallback(async () => {
    setEmbedError(null);
    if (!embed?.keyless && !embeddingApiKey) {
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
  }, [embeddingApiKey, embed]);

  // Sorted + filtered source list (substring on filename + relPath).
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

  const c = project.counts;
  const sc = sources?.counts;
  // Prefer live counts from the ingest surface when available.
  const sourceCount = sc ? sc.total : c.sourceFiles;
  const doneCount = sc ? sc.done : null;
  const needsOcrCount = sc ? sc.needsOcr : null;
  const failedCount = sc ? sc.failed : null;
  const extractingCount = sc ? sc.extracting : null;

  // One-line aggregate embedding summary (corpus-wide). Hidden until we have
  // a status fetch back; degrades to nothing rather than "0/0".
  const embedLine = (() => {
    if (!embed) return null;
    if (!embed.vecLoaded) return "embeddings disabled on this platform";
    if (embed.total > 0) return `${embed.done}/${embed.total} embedded`;
    return null;
  })();

  const embedReady =
    !!embed && embed.vecLoaded && embed.total > 0 &&
    embed.pending === 0 && embed.failed === 0;
  const embedHasPending = !!embed && embed.vecLoaded && embed.pending > 0;
  // "Embed now" is available when the provider is keyless (local granite) OR
  // a remote key is set — local embeddings need no setup.
  const embedCanRun = !!embed?.keyless || !!embeddingApiKey;

  return (
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

      {/* Embedding status + action. Extraction ("done") only means the text
          was pulled out + chunked — it does NOT mean vectors exist. Make
          that distinction visible and offer a one-click embed. */}
      {embed && embed.vecLoaded && embed.total > 0 && !embedReady && (
        <div className={`embed-box${embedHasPending ? " pending" : ""}`}>
          <div className="embed-box-head">
            <span className="embed-box-title">
              {embed.done}/{embed.total} chunks embedded
            </span>
            <button
              className="btn ghost tiny-btn embed-btn"
              onClick={runEmbed}
              disabled={embedBusy || !embedCanRun}
              title={
                embedCanRun
                  ? "Embed all pending chunks now"
                  : "Assign an embedding provider with a key in Settings → Functions"
              }
            >
              <ArrowsClockwise size={13} weight="bold" />
              {embedBusy ? "embedding…" : "Embed now"}
            </button>
            {!embedCanRun && onOpenSettings && (
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
            {!embedCanRun
              ? "no embedding provider assigned — set one in Settings → Functions"
              : embedHasPending
                ? "extraction is done, but vectors aren't built yet"
                : "some chunks failed — retry to re-attempt them"}
          </div>
          {embedError && <div className="embed-box-error">{embedError}</div>}
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
                <span className={`source-dot ${kindDotClass(src.kind)}`} />
                <span className="source-name">{src.filename}</span>
                <StatusBadge status={src.textStatus} />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
