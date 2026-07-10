// NotePopup — the "save this passage" card shown when the user selects text in
// a PDF and clicks the floating "Save note" pill. Self-contained: fetches the
// list set, lets the user pick a list + edit the prefilled excerpt + add an
// optional note, then POSTs /notes. On success it fires a window
// `dissertator:notes-changed` CustomEvent so the LibraryPanel refreshes
// (decoupled — no callback threading through App/CenterPane).
//
// Anchored just below the selection; clamped into the viewport; closes on
// outside-click / Escape. Mirrors CitationPopup's positioning logic.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X, Check } from "@phosphor-icons/react";
import type { List, NoteRect } from "@dissertator/shared";
import { api } from "../lib/api";

interface Props {
  sourceId: string;
  /** 1-based physical page the selection is on. */
  page: number;
  /** The selected text, prefilled into the excerpt field (editable). */
  initialExcerpt: string;
  /** Anchor: the selection's bounding client rect. */
  rect: DOMRect;
  /** Selection bbox in page-space % (stored for a future highlight overlay). */
  pageRect: NoteRect | null;
  onClose: () => void;
}

/** Dispatch the refresh signal consumed by LibraryPanel. */
export function notifyNotesChanged(): void {
  window.dispatchEvent(new CustomEvent("dissertator:notes-changed"));
}

/**
 * Insert a citation token (e.g. `[@smith2020:12]`) at the manuscript
 * editor's cursor. Returns `true` if an editor handled it.
 *
 * The ManuscriptEditor is only mounted while its tab is the active one
 * (see CenterPane), so when the user is reading a source PDF no listener is
 * alive — the caller should fall back to a clipboard copy in that case.
 *
 * Handshake: a cancelable window event; the editor calls `preventDefault()`
 * on success, which makes `dispatchEvent` (and thus this return value)
 * report whether insertion happened.
 */
export function insertCitation(token: string): boolean {
  const evt = new CustomEvent("dissertator:insert-citation", {
    detail: { token },
    cancelable: true,
  });
  window.dispatchEvent(evt);
  return evt.defaultPrevented;
}

export function NotePopup({
  sourceId,
  page,
  initialExcerpt,
  rect,
  pageRect,
  onClose,
}: Props) {
  const [lists, setLists] = useState<List[]>([]);
  const [listId, setListId] = useState<number>(1);
  const [excerpt, setExcerpt] = useState<string>(initialExcerpt);
  const [body, setBody] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: rect.left,
    top: rect.bottom + 6,
  });

  // Load the list set once.
  useEffect(() => {
    let aborted = false;
    (async () => {
      try {
        const ls = await api.listLists();
        if (aborted) return;
        setLists(ls);
        if (ls.length > 0) setListId(ls[0].id);
      } catch {
        /* sidecar mid-restart; the select stays empty and Save is disabled */
      }
    })();
    return () => {
      aborted = true;
    };
  }, []);

  // Clamp into the viewport once the card has a measured size.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const margin = 8;
    const { offsetWidth: w, offsetHeight: h } = card;
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + w > window.innerWidth - margin)
      left = Math.max(margin, window.innerWidth - w - margin);
    if (top + h > window.innerHeight - margin)
      top = Math.max(margin, rect.top - h - 6); // flip above if no room below
    setPos({ left, top });
  }, [rect, lists, error]);

  // Close on outside click / Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node))
        onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const save = async () => {
    if (saving || !listId) return;
    setSaving(true);
    setError(null);
    try {
      await api.createNote({
        sourceId,
        page,
        excerpt: excerpt.trim() || null,
        body: body.trim() || null,
        listId,
        rect: pageRect,
      });
      notifyNotesChanged();
      onClose();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
      setSaving(false);
    }
  };

  return (
    <div className="citation-popup-overlay">
      <div
        ref={cardRef}
        className="citation-popup note-popup"
        style={{ left: pos.left, top: pos.top }}
      >
        <div className="citation-popup-head">
          <span className="citation-popup-citekey">Save note</span>
          <span className="citation-popup-page">p.&nbsp;{page}</span>
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
          <label className="note-popup-field">
            <span className="muted small">List</span>
            <select
              className="citation-popup-select"
              value={listId}
              disabled={saving || lists.length === 0}
              onChange={(e) => setListId(parseInt(e.target.value, 10))}
            >
              {lists.length === 0 && <option value={1}>Loading…</option>}
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <label className="note-popup-field">
            <span className="muted small">Selected text</span>
            <textarea
              className="note-popup-excerpt"
              value={excerpt}
              placeholder="(optional)"
              rows={3}
              disabled={saving}
              onChange={(e) => setExcerpt(e.target.value)}
            />
          </label>
          <label className="note-popup-field">
            <span className="muted small">Your note</span>
            <textarea
              className="note-popup-body"
              value={body}
              placeholder="(optional)"
              rows={2}
              disabled={saving}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          {error && <div className="note-popup-error">{error}</div>}
          <button
            className="btn primary small note-popup-save"
            onClick={save}
            disabled={saving || lists.length === 0}
          >
            <Check size={14} weight="bold" />
            {saving ? "Saving…" : "Save note"}
          </button>
        </div>
      </div>
    </div>
  );
}
