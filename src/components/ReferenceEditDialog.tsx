// ReferenceEditDialog — modal to edit OR create the reference linked to the
// source currently shown in the PdfViewer. Lets you fix reference metadata
// (title / authors / year / DOI) without leaving the PDF.
//
// Loads the reference linked to `sourceId` (0 or 1 in practice). If one
// exists, its citekey is frozen (see ReferenceFields); if none exists, it's a
// "create" flow where the citekey is typed once and the new reference is
// linked to this source on save.
//
// Rendered as a centered modal (reuses .citation-popup styles + a modifier).

import { useEffect, useState } from "react";
import { BookOpen, Check, X } from "@phosphor-icons/react";
import { type Reference, parseAuthors } from "@dissertator/shared";
import { api } from "../lib/api";
import {
  ReferenceFields,
  fmtAuthors,
  type ReferenceDraft,
} from "./ReferenceFields";

interface Props {
  sourceId: string;
  onClose: () => void;
  /** Fired with the saved reference after a successful edit/create (so the
   *  parent can e.g. refresh a list). */
  onChanged?: (ref: Reference) => void;
}

export function ReferenceEditDialog({ sourceId, onClose, onChanged }: Props) {
  // undefined = loading, null = none linked, Reference = loaded.
  const [ref, setRef] = useState<Reference | null | undefined>(undefined);
  const [draft, setDraft] = useState<ReferenceDraft>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the reference linked to this source (one-shot per sourceId).
  useEffect(() => {
    let aborted = false;
    setRef(undefined);
    (async () => {
      try {
        const refs = await api.listReferences(sourceId);
        if (aborted) return;
        const r = refs[0] ?? null;
        setRef(r);
        setDraft(
          r
            ? {
                citekey: r.citekey,
                title: r.title ?? "",
                year: r.year,
                doi: r.doi ?? "",
                authors: r.authors,
                authorsText: fmtAuthors(r.authors),
              }
            : { citekey: "" },
        );
      } catch {
        if (!aborted) {
          setRef(null);
          setDraft({ citekey: "" });
        }
      }
    })();
    return () => {
      aborted = true;
    };
  }, [sourceId]);

  // Close on Escape (overlay click is handled inline).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isNew = !ref;

  const save = async () => {
    setError(null);
    const citekey = (draft.citekey ?? "").trim();
    if (!citekey) {
      setError("A citekey is required.");
      return;
    }
    const payload = {
      title: (draft.title ?? "").trim() || null,
      year: draft.year == null ? null : Number(draft.year) || null,
      doi: (draft.doi ?? "").trim() || null,
      authors: parseAuthors(draft.authorsText ?? ""),
    };
    setSaving(true);
    try {
      const saved = ref
        ? // citekey is frozen on edit — don't send it.
          await api.updateReference(ref.id, payload)
        : await api.createReference({ citekey, ...payload, source_file_id: sourceId });
      setRef(saved);
      onChanged?.(saved);
      onClose();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
      setSaving(false);
    }
  };

  return (
    <div className="citation-popup-overlay" onClick={onClose}>
      <div
        className="citation-popup ref-edit-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="citation-popup-head">
          <BookOpen size={14} weight="bold" />
          <span className="citation-popup-citekey">
            {ref ? "Edit citation" : "Add citation"}
          </span>
          <button
            className="citation-popup-close"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <X size={14} weight="bold" />
          </button>
        </div>
        <div className="citation-popup-body">
          {ref === undefined ? (
            <div className="muted small">Loading reference…</div>
          ) : (
            <>
              {ref && (
                <div className="ref-edit-dialog-linked muted small">
                  Linked citekey for this source:
                </div>
              )}
              <ReferenceFields
                draft={draft}
                setDraft={setDraft}
                citekeyEditable={isNew}
                disabled={saving}
              />
              {error && <div className="note-popup-error">{error}</div>}
              <button
                className="btn primary small note-popup-save"
                onClick={save}
                disabled={saving || (isNew && !(draft.citekey ?? "").trim())}
              >
                <Check size={14} weight="bold" />
                {saving ? "Saving…" : isNew ? "Create & link" : "Save"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
