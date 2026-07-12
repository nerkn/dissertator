// ReferenceRow — a single bibliography entry. Renders in one of three modes:
//   • editing  — the inline ReferenceFields form (Save / cancel)
//   • linked   — the source file is connected: Open / Unlink / Edit / Delete
//   • fileless — no backing source: a link picker + Edit / Delete
//
// All mutations are delegated to the parent (which owns `refs` + edit state);
// this component is presentational.

import { FilePdf, Link, Trash, X } from "@phosphor-icons/react";
import type { Reference, SourceFile } from "@dissertator/shared";
import {
  fmtAuthors,
  ReferenceFields,
  type ReferenceDraft,
} from "../ReferenceFields";

interface Props {
  r: Reference;
  /** The linked source file, if any (resolved from `sources` by the parent). */
  linked?: SourceFile;
  /** True when this row is the one currently being edited. */
  editing: boolean;
  /** Draft state for the edit form (shared with parent so only one row edits). */
  draft: ReferenceDraft;
  setDraft: (d: ReferenceDraft) => void;
  /** All sources — populates the fileless "link to file" picker. */
  sources: SourceFile[];
  onLink: (r: Reference, sourceId: string) => void;
  onUnlink: (r: Reference) => void;
  onRemove: (id: string) => void;
  onStartEdit: (r: Reference) => void;
  onSaveEdit: (id: string) => void;
  onCancelEdit: () => void;
  onOpenSource?: (src: SourceFile) => void;
}

export function ReferenceRow({
  r,
  linked,
  editing,
  draft,
  setDraft,
  sources,
  onLink,
  onUnlink,
  onRemove,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onOpenSource,
}: Props) {
  return (
    <div className="reference-row">
      <div className="reference-main">
        {editing ? (
          <ReferenceFields draft={draft} setDraft={setDraft} />
        ) : (
          <>
            <div className="reference-head">
              <code className="citekey">{r.citekey}</code>
              {r.year && <span className="muted small">{r.year}</span>}
              {linked ? (
                <span className="ref-badge linked" title={linked.filename}>
                  <Link size={11} weight="bold" /> {linked.filename}
                </span>
              ) : (
                <span className="ref-badge fileless">fileless</span>
              )}
            </div>
            {r.title && <div className="reference-title">{r.title}</div>}
            {r.authors.length > 0 && (
              <div className="muted small">{fmtAuthors(r.authors)}</div>
            )}
            {(r.venue || r.doi) && (
              <div className="muted small">
                {[r.venue, r.doi].filter(Boolean).join(" · ")}
              </div>
            )}
          </>
        )}
      </div>

      <div className="reference-actions">
        {editing ? (
          <>
            <button className="btn primary small-btn" onClick={() => onSaveEdit(r.id)}>
              Save
            </button>
            <button className="btn ghost small-btn" onClick={onCancelEdit}>
              <X size={14} weight="bold" />
            </button>
          </>
        ) : linked ? (
          <>
            {onOpenSource && (
              <button
                className="btn ghost small-btn"
                onClick={() => onOpenSource(linked)}
                title="Open linked PDF"
              >
                <FilePdf size={14} weight="bold" /> Open
              </button>
            )}
            <button
              className="btn ghost small-btn"
              onClick={() => onUnlink(r)}
              title="Unlink from source"
            >
              <Link size={14} weight="bold" /> Unlink
            </button>
            <button className="btn ghost small-btn" onClick={() => onStartEdit(r)}>
              Edit
            </button>
            <button className="btn ghost small-btn" onClick={() => onRemove(r.id)}>
              <Trash size={14} weight="bold" />
            </button>
          </>
        ) : (
          <>
            <label className="ref-link-select" title="Link to a source file">
              <Link size={13} weight="bold" />
              <select
                value=""
                onChange={(e) => {
                  const id = e.target.value;
                  if (id) void onLink(r, id);
                }}
              >
                <option value="" disabled>
                  Link to file…
                </option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.filename}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn ghost small-btn" onClick={() => onStartEdit(r)}>
              Edit
            </button>
            <button className="btn ghost small-btn" onClick={() => onRemove(r.id)}>
              <Trash size={14} weight="bold" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
