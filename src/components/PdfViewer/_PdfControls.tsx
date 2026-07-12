// PdfControls — the PDF viewer toolbar: prev/next page nav, page indicator,
// zoom out/reset/in, and the "Citation" button. Purely presentational.

import { BookOpen } from "@phosphor-icons/react";
import { MAX_SCALE, MIN_SCALE } from "./_constants";

interface Props {
  page: number;
  total: number;
  scale: number;
  goto: (n: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  onOpenCitation: () => void;
}

export function PdfControls({
  page,
  total,
  scale,
  goto,
  zoomIn,
  zoomOut,
  zoomReset,
  onOpenCitation,
}: Props) {
  return (
    <div className="pdf-controls">
      <button
        className="btn ghost small-btn"
        onClick={() => goto(page - 1)}
        disabled={page <= 1}
        title="Previous page"
      >
        ‹ Prev
      </button>
      <span className="pdf-page-indicator">
        Page
        <input
          className="pdf-page-input"
          type="number"
          min={1}
          max={total || 1}
          value={page}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (Number.isFinite(n)) goto(n);
          }}
        />
        / {total}
      </span>
      <button
        className="btn ghost small-btn"
        onClick={() => goto(page + 1)}
        disabled={page >= total}
        title="Next page"
      >
        Next ›
      </button>
      <span className="pdf-controls-divider" />
      <button
        className="btn ghost small-btn"
        onClick={zoomOut}
        disabled={scale <= MIN_SCALE}
        title="Zoom out"
      >
        −
      </button>
      <button
        className="btn ghost small-btn pdf-zoom-reset"
        onClick={zoomReset}
        title="Reset zoom"
      >
        {Math.round(scale * 100)}%
      </button>
      <button
        className="btn ghost small-btn"
        onClick={zoomIn}
        disabled={scale >= MAX_SCALE}
        title="Zoom in"
      >
        +
      </button>
      <span className="pdf-controls-divider" />
      <button
        className="btn ghost small-btn"
        onClick={onOpenCitation}
        title="Edit the reference / citation linked to this source"
      >
        <BookOpen size={14} weight="bold" /> Citation
      </button>
    </div>
  );
}
