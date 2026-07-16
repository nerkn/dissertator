// CitationPopup — a floating reference card shown when a `[@citekey:page]`
// chip is clicked but the reference has NO linked source file (a fileless
// reference) or the citekey is unknown. When the reference IS linked to a
// source, App opens the PDF directly (no popup), so this card is the
// "nothing to open" branch.
//
// Anchored just below the clicked chip; closes on outside-click / Escape.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X, BookOpen, Warning } from "@phosphor-icons/react";
import type { Reference, SourceFile } from "@dissertator/shared";
import { api } from "../lib/api";
import { useSourceItems } from "../lib/stores/content";
import { SourceCombobox } from "./SourceCombobox";

interface Props {
  citekey: string;
  page: number | null;
  rect: DOMRect;
  onClose: () => void;
  /** Called after the user links a reference to a source: opens that PDF
   *  (at `page` if given) and closes the popup. */
  onLinkOpen: (sourceId: string, page: number | null) => void;
}

/** Format authors as "Given Family, Given Family" (CSL-ish). Empty → "". */
function formatAuthors(authors: Reference["authors"]): string {
  return authors
    .map((a) => [a.given, a.family].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(", ");
}

export function CitationPopup({ citekey, page, rect, onClose, onLinkOpen }: Props) {
  const sources = useSourceItems();
  const [ref, setRef] = useState<Reference | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [notFound, setNotFound] = useState<boolean>(false);
  const [linking, setLinking] = useState<boolean>(false);
  const cardRef = useRef<HTMLDivElement>(null);
  // Position state — clamped so the card never overflows the viewport.
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: rect.left,
    top: rect.bottom + 6,
  });

  // Resolve the citekey → reference (one shot per citekey).
  useEffect(() => {
    let aborted = false;
    setLoading(true);
    setNotFound(false);
    setRef(null);
    (async () => {
      try {
        const r = await api.getReference(citekey);
        if (!aborted) {
          setRef(r);
          setLoading(false);
        }
      } catch {
        if (!aborted) {
          setNotFound(true);
          setLoading(false);
        }
      }
    })();
    return () => {
      aborted = true;
    };
  }, [citekey]);

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
  }, [rect, loading, notFound, ref]);

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

  // Link this reference to a chosen source file, then open it. Persists the
  // link via the references API so future clicks open directly (no popup).
  const linkAndOpen = async (sourceId: string) => {
    if (!ref || !sourceId || linking) return;
    setLinking(true);
    try {
      await api.updateReference(ref.id, { source_file_id: sourceId });
      onLinkOpen(sourceId, page);
      onClose();
    } catch {
      setLinking(false);
    }
  };

  // No reference record exists for this citekey: create one on the fly,
  // linked to the chosen source, so the chip resolves on future clicks.
  const createAndOpen = async (source: SourceFile) => {
    if (linking) return;
    setLinking(true);
    try {
      await api.createReference({ citekey, source_file_id: source.id });
      onLinkOpen(source.id, page);
      onClose();
    } catch {
      setLinking(false);
    }
  };

  return (
    <div className="citation-popup-overlay" onClick={onClose}>
      <div
        ref={cardRef}
        className="citation-popup"
        style={{ left: pos.left, top: pos.top }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="citation-popup-head">
          <BookOpen size={14} weight="bold" />
          <span className="citation-popup-citekey">{citekey}</span>
          {page ? (
            <span className="citation-popup-page">p.&nbsp;{page}</span>
          ) : null}
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
          {loading && <div className="muted small">Looking up reference…</div>}
          {!loading && notFound && (
            <div className="citation-popup-unknown">
              <Warning size={16} weight="bold" />
              <div>
                <div>No reference found for this citekey.</div>
                <div className="muted small">
                  Pick a source to create this reference and open it, or add it
                  via the References tab.
                </div>
                <label className="citation-popup-link">
                  <span className="muted small">Link to source file:</span>
                  <SourceCombobox
                    sources={sources}
                    disabled={linking}
                    placeholder={linking ? "Linking…" : "Type to search a source…"}
                    onSelect={createAndOpen}
                  />
                </label>
              </div>
            </div>
          )}
          {!loading && ref && (
            <>
              {ref.title && (
                <div className="citation-popup-title">{ref.title}</div>
              )}
              {formatAuthors(ref.authors) && (
                <div className="citation-popup-authors">
                  {formatAuthors(ref.authors)}
                </div>
              )}
              <div className="citation-popup-meta muted small">
                {[ref.year, ref.venue].filter(Boolean).join(". ")}
                {ref.doi && (
                  <>
                    {" · "}
                    <a
                      href={`https://doi.org/${ref.doi}`}
                      target="_blank"
                      rel="noreferrer"
                      className="citation-popup-doi"
                    >
                      doi:{ref.doi}
                    </a>
                  </>
                )}
              </div>
              <div className="citation-popup-note muted small">
                No source file is linked to this reference.
              </div>
              <label className="citation-popup-link">
                <span className="muted small">Link to source file:</span>
                <SourceCombobox
                  sources={sources}
                  disabled={linking}
                  placeholder={linking ? "Linking…" : "Choose a file…"}
                  onSelect={(s) => void linkAndOpen(s.id)}
                />
              </label>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
