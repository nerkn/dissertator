import { useEffect, useMemo, useState } from "react";
import { X, ArrowRight, ArrowUUpLeft, TrashSimple } from "@phosphor-icons/react";
import { api, type SourceHistoryEntry } from "../../lib/api";
import { diffLines, buildRight, type DiffSegment } from "../../lib/diff";
import { useContentStore } from "../../lib/stores/content";

interface Props {
  sourceId: string;
  title: string;
  onClose: () => void;
}

interface Row {
  kind: "equal" | "mod";
  line?: string;
  left?: string;
  right?: string;
  hunkIdx?: number;
  first?: boolean;
  applied?: boolean;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function HistoryMerge({ sourceId, title, onClose }: Props) {
  const [entries, setEntries] = useState<SourceHistoryEntry[]>([]);
  const [currentBody, setCurrentBody] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [applied, setApplied] = useState<Set<number>>(new Set());
  const [applying, setApplying] = useState<boolean>(false);
  const [showDelete, setShowDelete] = useState<boolean>(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [hist, cur] = await Promise.all([
        api.getSourceHistory(sourceId),
        api.getSourceMarkdown(sourceId),
      ]);
      setEntries(hist.items);
      setCurrentBody(cur.bodyMd ?? "");
      if (!selectedId && hist.items.length) {
        const prev = hist.items.find((h) => h.bodyAfter !== (cur.bodyMd ?? ""));
        setSelectedId(prev?.id ?? hist.items[0].id);
      }
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId]);

  const selected = entries.find((e) => e.id === selectedId) ?? null;
  const leftBody = selected?.bodyAfter ?? "";

  const segs = useMemo<DiffSegment[]>(
    () => diffLines(leftBody, currentBody),
    [leftBody, currentBody],
  );

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    segs.forEach((seg, idx) => {
      if (seg.kind === "equal") {
        for (const ln of seg.lines) out.push({ kind: "equal", line: ln });
      } else {
        const max = Math.max(seg.left.length, seg.right.length);
        for (let k = 0; k < max; k++) {
          out.push({
            kind: "mod",
            hunkIdx: idx,
            first: k === 0,
            left: seg.left[k],
            right: seg.right[k],
            applied: applied.has(idx),
          });
        }
      }
    });
    return out;
  }, [segs, applied]);

  const mergedBody = useMemo(
    () => buildRight(segs, applied),
    [segs, applied],
  );
  const changed = mergedBody !== currentBody;

  const toggleHunk = (idx: number) => {
    setApplied((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const onSelect = (id: string) => {
    setSelectedId(id);
    setApplied(new Set());
  };

  const apply = async () => {
    if (!changed) {
      onClose();
      return;
    }
    setApplying(true);
    try {
      await api.updateSourceMarkdown(sourceId, mergedBody);
      useContentStore.getState().bumpSourceRevision(sourceId);
      onClose();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    } finally {
      setApplying(false);
    }
  };

  const saveAs = async () => {
    if (!selected) return;
    try {
      const name = `${title || "manuscript"} (copy)`;
      await api.createManuscript(name, leftBody);
      setNotice(`Saved as “${name}” — open it from the library.`);
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="dialog dialog-wide history-merge"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <h2>History — {title}</h2>
          <div className="history-controls">
            <select
              className="history-select"
              value={selectedId ?? ""}
              onChange={(e) => onSelect(e.target.value)}
              disabled={!entries.length}
            >
              {!entries.length && <option value="">No history</option>}
              {entries.map((e) => (
                <option key={e.id} value={e.id}>
                  {fmtTime(e.createdAt)} · {e.author}
                  {e.editCount > 1 ? ` (${e.editCount} edits)` : ""} · {e.op}
                  {e.summary ? ` — ${e.summary}` : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn small"
              onClick={() => setShowDelete(true)}
              disabled={!entries.length}
              title="Delete history versions"
            >
              <TrashSimple size={14} weight="bold" /> Delete…
            </button>
            <button
              type="button"
              className="btn small"
              onClick={saveAs}
              disabled={!selected}
              title="Save the selected version as a new manuscript"
            >
              Save as new
            </button>
            <button type="button" className="btn small ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn small primary"
              onClick={apply}
              disabled={applying}
            >
              {applying ? "Applying…" : "Apply"}
            </button>
            <button
              type="button"
              className="btn small ghost"
              onClick={onClose}
              title="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {error && <div className="history-error">{error}</div>}
        {notice && <div className="history-notice">{notice}</div>}

        {loading ? (
          <div className="history-empty">Loading…</div>
        ) : !entries.length ? (
          <div className="history-empty">No edit history yet.</div>
        ) : (
          <div className="history-panes">
            <div className="history-pane-head">Previous version</div>
            <div className="history-pane-head history-center-head">Apply →</div>
            <div className="history-pane-head">Current (working copy)</div>
            <div className="history-grid">
              {rows.map((r, i) => {
                if (r.kind === "equal") {
                  return (
                    <div key={i} className="history-row history-eq">
                      <div className="history-cell history-left">{r.line}</div>
                      <div className="history-cell history-mid" />
                      <div className="history-cell history-right">{r.line}</div>
                    </div>
                  );
                }
                const cls = r.applied ? "history-applied" : "history-diff";
                return (
                  <div key={i} className={`history-row ${cls}`}>
                    <div className="history-cell history-left">
                      {r.left ?? ""}
                    </div>
                    <div className="history-cell history-mid">
                      {r.first && (
                        <button
                          type="button"
                          className="hunk-arrow"
                          title={
                            r.applied
                              ? "Revert this change"
                              : "Apply this change to current"
                          }
                          onClick={() => toggleHunk(r.hunkIdx!)}
                        >
                          {r.applied ? (
                            <ArrowUUpLeft size={14} weight="bold" />
                          ) : (
                            <ArrowRight size={14} weight="bold" />
                          )}
                        </button>
                      )}
                    </div>
                    <div className="history-cell history-right">
                      {r.applied ? (r.left ?? "") : (r.right ?? "")}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {showDelete && (
        <DeleteDialog
          entries={entries}
          onClose={() => setShowDelete(false)}
          onDeleted={(remaining) => {
            setEntries(remaining);
            if (selectedId && !remaining.some((e) => e.id === selectedId)) {
              setSelectedId(remaining[0]?.id ?? null);
              setApplied(new Set());
            }
            setShowDelete(false);
          }}
        />
      )}
    </div>
  );
}

function DeleteDialog({
  entries,
  onClose,
  onDeleted,
}: {
  entries: SourceHistoryEntry[];
  onClose: () => void;
  onDeleted: (remaining: SourceHistoryEntry[]) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<boolean>(false);

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const remove = async () => {
    if (!picked.size) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const ids = entries
        .filter((e) => picked.has(e.id))
        .flatMap((e) => e.ids);
      await api.deleteSourceHistory(ids);
      onDeleted(entries.filter((e) => !picked.has(e.id)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2>Delete history</h2>
          <button
            type="button"
            className="btn small ghost"
            onClick={onClose}
            title="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="history-delete-list">
          {entries.map((e) => (
            <label key={e.id} className="history-delete-row">
              <input
                type="checkbox"
                checked={picked.has(e.id)}
                onChange={() => toggle(e.id)}
              />
              <span>
                {fmtTime(e.createdAt)} · {e.author}
                {e.editCount > 1 ? ` (${e.editCount} edits)` : ""} · {e.op}
                {e.summary ? ` — ${e.summary}` : ""}
              </span>
            </label>
          ))}
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn small ghost"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn small danger"
            onClick={remove}
            disabled={busy || !picked.size}
          >
            {busy ? "Deleting…" : `Delete ${picked.size || ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
