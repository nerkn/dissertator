// PdfViewer — renders a single source PDF via pdf.js (one page at a time).
//
// File bytes are fetched from the sidecar's `/files/:id` endpoint (the Tauri
// asset protocol is intentionally NOT scoped in this project — see the file-
// access decision in the P3 workstream spec). The pdf.js worker is wired via
// Vite's `?url` import so it runs off the main thread.
//
// Rendering loop: load doc once per `sourceId`, then on each page change
// (re)render that page to a <canvas>. A prior in-flight RenderTask is
// cancelled before starting a new one (pdf.js throws a benign
// RenderingCancelledException that we swallow). On unmount / source change we
// cancel the render and destroy the document to free memory.

import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
// `?url` is a Vite feature (types declared via `vite/client`): it returns the
// resolved worker URL as a string, which pdf.js loads in a Web Worker.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api } from "../lib/api";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

interface Props {
  sourceId: string;
  /** Page to land on after load (1-based). Defaults to 1. Future hook for
   *  search-hit navigation. */
  initialPage?: number;
}

const RENDER_SCALE = 1.5;

export function PdfViewer({ sourceId, initialPage }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Tracked so a superseding render (page change / unmount) can cancel it.
  const renderTaskRef = useRef<RenderTask | null>(null);

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState<number>(
    initialPage && initialPage > 0 ? initialPage : 1,
  );
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // --- Load the document once per sourceId. --------------------------------
  useEffect(() => {
    let aborted = false;
    // Captured per-run so cleanup destroys exactly this run's document.
    let doc: PDFDocumentProxy | null = null;

    setLoading(true);
    setError(null);
    setTotal(0);
    setPdf(null);
    // Tear down any render from the previous document first.
    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;

    (async () => {
      try {
        const res = await fetch(api.fileUrl(sourceId));
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`${res.status} ${body}`.trim());
        }
        const data = await res.arrayBuffer();
        doc = await pdfjsLib.getDocument({ data }).promise;
        if (aborted) {
          void doc.destroy();
          doc = null;
          return;
        }
        setPdf(doc);
        setTotal(doc.numPages);
        // Clamp the initial page into the valid range.
        setPage((p) => Math.min(Math.max(1, p), doc!.numPages));
        setLoading(false);
      } catch (e) {
        if (aborted) return;
        setError((e as Error)?.message ?? String(e));
        setLoading(false);
      }
    })();

    return () => {
      aborted = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      // Free the document loaded by THIS run (null until fetch resolves).
      void doc?.destroy();
    };
  }, [sourceId]);

  // --- Render the current page. --------------------------------------------
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    // Cancel any in-flight render from a prior page before starting a new one.
    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;

    (async () => {
      try {
        const pdfPage = await pdf.getPage(page);
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const viewport = pdfPage.getViewport({ scale: RENDER_SCALE });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const task = pdfPage.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
      } catch (e) {
        // Expected when a newer render supersedes this one or the component
        // unmounts mid-render — swallow it. Everything else is a real error.
        if ((e as Error)?.name === "RenderingCancelledException") return;
        if (!cancelled) {
          setError((e as Error)?.message ?? String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdf, page]);

  if (loading) return <div className="pdf-status">Loading PDF…</div>;
  if (error) return <div className="pdf-error">Failed to load PDF: {error}</div>;

  const goto = (n: number): void => {
    if (!total) return;
    setPage(Math.min(Math.max(1, n), total));
  };

  return (
    <div className="pdf-viewer">
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
      </div>
      <div className="pdf-canvas-area">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
