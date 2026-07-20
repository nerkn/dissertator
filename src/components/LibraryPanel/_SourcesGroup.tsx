// SourcesGroup — the 🔵 Documents section of the Library panel.
//
// Owns its own state: the collapse toggle, the corpus-wide embedding poll +
// "Embed now" action, and the client-side filter against the panel-level
// search query. Renders the group header (with rescan), the embedding status
// block, and the source tree. Markdown source files are excluded — they
// belong to the Manuscripts group.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  CheckCircle,
  CircleNotch,
  DotsThreeVertical,
  Gear,
  PencilSimple,
  Sparkle,
} from "@phosphor-icons/react";
import type {
  EmbeddingStatus,
  ProjectStatus,
  SourceFile,
  SourcesResponse,
} from "@dissertator/shared";
import { api } from "../../lib/api";
import { useContentStore } from "../../lib/stores/content";
import { alertDialog } from "../../lib/stores/dialogs";
import { fmtAuthors } from "../ReferenceFields";
import { ReferenceEditDialog } from "../ReferenceEditDialog";
import { StatusBadge } from "../StatusBadge";
import { isMdSource, kindDotClass } from "./_shared";

type SortKey = "title" | "filecdate" | "author" | "publishyear" | "filename";

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
  chatKey?: string;
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
  chatKey,
  onOpen,
  onOpenSettings,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [embed, setEmbed] = useState<EmbeddingStatus | null>(null);
  // Optimistic flag covering the ≤5s gap between clicking "Embed now" and the
  // poll reflecting `embed.running`. Cleared once the poll confirms running
  // (or the drain already finished).
  const [embedStarting, setEmbedStarting] = useState(false);
  const [embedError, setEmbedError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>("title");
  const [menuOpen, setMenuOpen] = useState(false);
  const refsById = useContentStore((s) => s.referencesBySource);
  const setReferences = useContentStore((s) => s.setReferences);
  const [editingId, setEditingId] = useState<string | null>(null);

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

  const reloadRefs = useCallback(async () => {
    try {
      setReferences(await api.listReferences());
    } catch {
    }
  }, [setReferences]);
  useEffect(() => {
    if (!project.initialized) return;
    void reloadRefs();
  }, [project.initialized, sources, reloadRefs]);

  const isPlaceholder = (s: SourceFile): boolean => {
    const r = refsById?.get(s.id);
    return !r || (r.authors.length === 0 && !r.doi);
  };

  const [identifying, setIdentifying] = useState(false);
  const [identifyProg, setIdentifyProg] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [oneBusy, setOneBusy] = useState<string | null>(null);
  const [oneResult, setOneResult] = useState<
    { id: string; ok: boolean } | null
  >(null);

  const flashResult = useCallback((id: string, ok: boolean) => {
    setOneResult({ id, ok });
    window.setTimeout(() => {
      setOneResult((cur) => (cur && cur.id === id ? null : cur));
    }, 2500);
  }, []);

  const identifyOne = useCallback(
    async (id: string) => {
      setOneBusy(id);
      try {
        const res = await api.detectReference(id, chatKey);
        await reloadRefs();
        flashResult(id, res.found && res.source !== "none");
      } catch {
        flashResult(id, false);
      } finally {
        setOneBusy(null);
      }
    },
    [chatKey, reloadRefs, flashResult],
  );

  const identifyAll = useCallback(async () => {
    const items = sources?.items ?? [];
    const targets = items.filter(
      (s) => s.textStatus === "done" && isPlaceholder(s),
    );
    if (targets.length === 0) {
      await alertDialog({
        title: "Nothing to identify",
        message: "Every extracted source already has metadata.",
      });
      return;
    }
    setIdentifying(true);
    setIdentifyProg({ done: 0, total: targets.length });
    const counts: Record<string, number> = {};
    let filled = 0;
    try {
      for (let i = 0; i < targets.length; i++) {
        const s = targets[i];
        try {
          const res = await api.detectReference(s.id, chatKey);
          if (res.found && !res.alreadyLinked && res.source !== "none") {
            counts[res.source] = (counts[res.source] ?? 0) + 1;
            filled++;
          }
        } catch {
        }
        setIdentifyProg({ done: i + 1, total: targets.length });
      }
      await reloadRefs();
      const breakdown = Object.entries(counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ");
      await alertDialog({
        title: "Identification complete",
        message:
          filled > 0
            ? `Identified ${filled} of ${targets.length} source(s)${breakdown ? ` (${breakdown})` : ""}.`
            : `No metadata found for ${targets.length} source(s).`,
      });
    } finally {
      setIdentifying(false);
      setIdentifyProg(null);
    }
  }, [sources, refsById, chatKey, reloadRefs]);

  // "Embed now": start a background drain of ALL pending chunks. The POST
  // returns immediately (fire-and-forget); live progress comes from the 5s
  // poll via embed.running + pending/done. A missing key is caught up front
  // with an actionable message.
  const runEmbed = useCallback(async () => {
    setEmbedError(null);
    if (!embed?.keyless && !embeddingApiKey) {
      setEmbedError(
        "No embedding provider assigned. Open ⚙ Settings → Functions and pick one that has a key.",
      );
      return;
    }
    setEmbedStarting(true);
    try {
      await api.embed(embeddingApiKey);
    } catch (e) {
      setEmbedError((e as Error)?.message ?? String(e));
      setEmbedStarting(false);
    }
    // Don't clear embedStarting here — the poll's embed.running takes over
    // within 5s. The effect below clears it once running flips true or the
    // drain ends.
  }, [embeddingApiKey, embed]);

  // Sync the optimistic flag with the polled `running` state.
  const embedBusy = embedStarting || !!embed?.running;
  useEffect(() => {
    // Clear once the backend confirms the drain is running, or once it has
    // finished (running false AND no pending left).
    if (embed?.running || (embed && embed.pending === 0)) {
      setEmbedStarting(false);
    }
  }, [embed?.running, embed?.pending]);

  // Sorted + filtered source list (substring on filename + relPath).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const refFor = (s: SourceFile) => refsById?.get(s.id);
    const stripArticle = (t: string): string =>
      t.replace(/^\s*(a|an|the)\b\s*/i, "");
    const cmp = (a: SourceFile, b: SourceFile): number => {
      switch (sortBy) {
        case "title": {
          const ta = stripArticle(
            (refFor(a)?.title?.trim() || a.filename).toLowerCase(),
          );
          const tb = stripArticle(
            (refFor(b)?.title?.trim() || b.filename).toLowerCase(),
          );
          return ta.localeCompare(tb) || a.filename.localeCompare(b.filename);
        }
        case "filecdate":
          return b.addedAt - a.addedAt || a.filename.localeCompare(b.filename);
        case "author": {
          const fa = refFor(a)?.authors.find((x) => x.family)?.family ?? "";
          const fb = refFor(b)?.authors.find((x) => x.family)?.family ?? "";
          if (!fa && !fb) return a.filename.localeCompare(b.filename);
          if (!fa) return 1;
          if (!fb) return -1;
          return fa.localeCompare(fb) || a.filename.localeCompare(b.filename);
        }
        case "publishyear": {
          const ya = refFor(a)?.year ?? 0;
          const yb = refFor(b)?.year ?? 0;
          return yb - ya || a.filename.localeCompare(b.filename);
        }
        case "filename":
        default:
          return a.filename.localeCompare(b.filename);
      }
    };
    const items = (sources?.items ?? [])
      .slice()
      .filter((s) => s.textStatus !== "failed")
      .filter((s) => !isMdSource(s))
      .sort(cmp);
    if (!q) return items;
    return items.filter((s) => {
      const r = refFor(s);
      return (
        s.filename.toLowerCase().includes(q) ||
        s.relPath.toLowerCase().includes(q) ||
        (r?.title ?? "").toLowerCase().includes(q) ||
        (r && r.authors.length > 0 ? fmtAuthors(r.authors) : "")
          .toLowerCase()
          .includes(q)
      );
    });
  }, [sources, query, sortBy, refsById]);

  const sc = sources?.counts;
  const nonMdTotal = (sources?.items ?? []).filter((s) => !isMdSource(s)).length;
  const doneCount = sc ? sc.done : null;
  const needsOcrCount = sc ? sc.needsOcr : null;
  const failedCount = sc ? sc.failed : null;
  const extractingCount = sc ? sc.extracting : null;
  const sourceCount = sc ? Math.min(sc.total, nonMdTotal) : nonMdTotal;

  // One-line aggregate embedding summary (corpus-wide). Hidden until we have
  // a status fetch back; degrades to nothing rather than "0/0".
  const embedLine = (() => {
    if (!embed) return null;
    if (!embed.vecLoaded) return "embeddings unavailable (sqlite-vec not loaded)";
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
          Documents
        </span>
        <div className="sources-head-menu">
          <button
            className="btn ghost tiny-btn sources-head-menu-btn"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            title="Corpus actions"
            aria-label="Corpus actions"
          >
            <DotsThreeVertical size={14} weight="bold" />
          </button>
          {menuOpen && (
            <>
              <div
                className="sources-menu-backdrop"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                }}
              />
              <div
                className="sources-menu"
                onClick={(e) => e.stopPropagation()}
              >
                {embedReady && (
                  <div className="sources-menu-info" title="All chunks embedded — semantic search ready">
                    <CheckCircle size={13} weight="bold" />
                    corpus embedded
                  </div>
                )}
                {onRescan && (
                  <button
                    className="sources-menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      onRescan();
                    }}
                    disabled={busy}
                  >
                    <ArrowsClockwise size={13} weight="bold" />
                    {busy ? "Scanning…" : "Rescan"}
                  </button>
                )}
                <button
                  className="sources-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    void identifyAll();
                  }}
                  disabled={identifying || busy}
                  title="Detect title, authors, year via DOI, PDF metadata, then AI"
                >
                  <Sparkle size={13} weight="bold" />
                  {identifying
                    ? `Identifying ${identifyProg?.done ?? 0}/${identifyProg?.total ?? 0}`
                    : "Identify all"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

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
              {embedBusy ? "digesting…" : "Embed now"}
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


      {expanded && (
        <>
          <div className="source-sort">
            <span className="muted small">Sort</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
            >
              <option value="title">Title</option>
              <option value="author">Author</option>
              <option value="publishyear">Year</option>
              <option value="filecdate">Date added</option>
              <option value="filename">Filename</option>
            </select>
          </div>
          <div className="source-tree">
            {filtered.length === 0 ? (
              <div className="muted small source-tree-empty">
                {query ? "No matching sources." : "No sources yet."}
              </div>
            ) : (
              filtered.map((src) => {
                const ref = refsById?.get(src.id);
                const title = ref?.title?.trim() || src.filename;
                const author =
                  ref && ref.authors.length > 0 ? fmtAuthors(ref.authors) : "";
                const year = ref?.year ?? null;
                return (
                  <div
                    key={src.id}
                    className="source-card"
                    onClick={() => onOpen?.(src)}
                  >
                    <div className="source-card-main">
                      <span
                        className={`source-dot ${kindDotClass(src.kind)}`}
                      />
                      <div className="source-card-text">
                        <div className="source-card-title">{title}</div>
                        {(author || year != null) && (
                          <div className="source-card-sub">
                            {author && (
                              <span className="source-card-author">
                                {author}
                              </span>
                            )}
                            {year != null && (
                              <span className="source-card-year">{year}</span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="source-card-actions">
                      <StatusBadge status={src.textStatus} />
                      {isPlaceholder(src) && src.textStatus === "done" && (
                        (() => {
                          const busy = oneBusy === src.id;
                          const result =
                            oneResult && oneResult.id === src.id
                              ? oneResult
                              : null;
                          if (busy) {
                            return (
                              <span
                                className="source-card-identify working"
                                title="Identifying…"
                                aria-label="Identifying"
                              >
                                <CircleNotch size={12} weight="bold" />
                              </span>
                            );
                          }
                          if (result) {
                            return (
                              <span
                                className={`source-card-identify ${result.ok ? "ok" : "fail"}`}
                                title={
                                  result.ok
                                    ? "Identified"
                                    : "No metadata found"
                                }
                                aria-label={
                                  result.ok ? "Identified" : "No metadata found"
                                }
                              >
                                {result.ok ? "✓" : "✗"}
                              </span>
                            );
                          }
                          return (
                            <button
                              className="source-card-edit"
                              onClick={(e) => {
                                e.stopPropagation();
                                void identifyOne(src.id);
                              }}
                              disabled={identifying}
                              title="Identify this source"
                              aria-label="Identify this source"
                            >
                              <Sparkle size={12} weight="bold" />
                            </button>
                          );
                        })()
                      )}
                      <button
                        className="source-card-edit"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingId(src.id);
                        }}
                        title="Edit details"
                        aria-label="Edit details"
                      >
                        <PencilSimple size={12} weight="bold" />
                      </button>
                    </div>
                    <div className="source-card-popover">
                      <div className="source-card-popover-title">{title}</div>
                      {author && (
                        <div className="source-card-popover-row">{author}</div>
                      )}
                      <div className="source-card-popover-row muted small">
                        {[
                          year != null ? String(year) : null,
                          ref?.venue,
                          src.pageCount ? `${src.pageCount}p` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                      {ref?.doi && (
                        <div className="source-card-popover-row muted small">
                          DOI: {ref.doi}
                        </div>
                      )}
                      <div className="source-card-popover-row muted small file">
                        {src.relPath}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      <div className="count count-popover-trigger" tabIndex={0}>
        {sourceCount} files
        <div className="count-popover">
          {sc ? (
            <>
              <div className="count-popover-row">
                {doneCount} done
                {extractingCount ? `, ${extractingCount} extracting` : ""}
                {needsOcrCount ? `, ${needsOcrCount} need OCR` : ""}
                {failedCount ? `, ${failedCount} failed` : ""}
              </div>
              {embedLine && (
                <div className="count-popover-row muted">{embedLine}</div>
              )}
              {embedReady && (
                <div className="count-popover-row muted">✓ corpus embedded</div>
              )}
            </>
          ) : (
            <div className="count-popover-row muted">
              PDFs, DOCX, XLSX, CSV, MD, TXT, images
            </div>
          )}
        </div>
      </div>

      {editingId && (
        <ReferenceEditDialog
          sourceId={editingId}
          onClose={() => setEditingId(null)}
          onChanged={reloadRefs}
        />
      )}
    </div>
  );
}
