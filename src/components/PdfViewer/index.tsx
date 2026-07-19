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

import { useEffect, useRef, useState, type CSSProperties } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
// `?url` is a Vite feature (types declared via `vite/client`): it returns the
// resolved worker URL as a string, which pdf.js loads in a Web Worker.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { NoteRect } from "@dissertator/shared";
import { api } from "../../lib/api";
import { useChatInputStore } from "../../lib/stores/chatInput";
import { NotePopup } from "../NotePopup";
import { ReferenceEditDialog } from "../ReferenceEditDialog";
import { PdfControls } from "./_PdfControls";
import {
  DEFAULT_SCALE,
  MAX_SCALE,
  MIN_SCALE,
  ZOOM_STEP,
} from "./_constants";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

interface Props {
  sourceId: string;
  /** Page to land on after load (1-based). Defaults to 1. Future hook for
   *  search-hit navigation. */
  initialPage?: number;
}

export function PdfViewer({ sourceId, initialPage }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  // Container (.pdf-canvas-area) — measured for fit-to-width.
  const areaRef = useRef<HTMLDivElement | null>(null);
  // True once we've auto-fit the current document (so user zoom isn't fought).
  const autoFitDone = useRef<boolean>(false);
  // Last computed fit-to-width scale; the reset button returns here.
  const fitScale = useRef<number>(DEFAULT_SCALE);
  // Tracked so a superseding render (page change / unmount) can cancel it.
  const renderTaskRef = useRef<RenderTask | null>(null);
  // Page wrapper (canvas + transparent text layer) — relative-positioned so
  // the text layer can absolutely overlay the canvas at matching size.
  const pageWrapRef = useRef<HTMLDivElement | null>(null);
  // The transparent, selectable text layer overlaid on the canvas.
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  // The in-flight TextLayer render; cancelled when superseded.
  const textLayerTaskRef = useRef<{ cancel: () => void } | null>(null);

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState<number>(
    initialPage && initialPage > 0 ? initialPage : 1,
  );
  // Render scale drives the canvas pixel dimensions. pdf.js always derives
  // height from width via the page's native aspect ratio, so changing scale
  // never distorts the page.
  const [scale, setScale] = useState<number>(DEFAULT_SCALE);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  // When set, the edit/create-citation modal is open over the PDF.
  const [showCitation, setShowCitation] = useState<boolean>(false);
  // A live text selection inside the PDF text layer (drives the "Save note"
  // pill). Cleared on page/source change. `clientRect` is viewport coords for
  // anchoring the pill + popup; `pageRect` is the bbox in page-space %.
  const [sel, setSel] = useState<{
    text: string;
    clientRect: DOMRect;
    pageRect: NoteRect | null;
  } | null>(null);
  const [pillLeft, setPillLeft] = useState<number | null>(null);
  // When set, the NotePopup save card is open (anchored at the selection).
  const [popup, setPopup] = useState<{
    text: string;
    clientRect: DOMRect;
    pageRect: NoteRect | null;
  } | null>(null);

  // --- Load the document once per sourceId. --------------------------------
  useEffect(() => {
    // Abort the in-flight PDF fetch on unmount / source-switch. Without this,
    // rapidly switching tabs abandons large downloads inside WebKit's network
    // loader, which floods `internallyFailedLoadTimerFired` and crashes the
    // webview (the WebLoaderStrategy.cpp:618 error storm on Linux).
    const controller = new AbortController();
    let aborted = false;
    // Captured per-run so cleanup destroys exactly this run's document.
    let doc: PDFDocumentProxy | null = null;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;

    setLoading(true);
    setError(null);
    setTotal(0);
    setPdf(null);
    setSel(null);
    setPopup(null);
    // Reset zoom + fit state when switching documents so a huge zoom from a
    // prior doc doesn't carry over and so we re-fit the new document's width.
    setScale(DEFAULT_SCALE);
    autoFitDone.current = false;
    fitScale.current = DEFAULT_SCALE;
    // Tear down any render from the previous document first.
    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;

    (async () => {
      try {
        const res = await fetch(api.fileUrl(sourceId), {
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`${res.status} ${body}`.trim());
        }
        const data = await res.arrayBuffer();
        const task = pdfjsLib.getDocument({ data });
        loadingTask = task;
        doc = await task.promise;
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
        // A clean abort from a tab switch is expected — never surface it.
        if (aborted || controller.signal.aborted) return;
        setError((e as Error)?.message ?? String(e));
        setLoading(false);
      }
    })();

    return () => {
      aborted = true;
      // Cancel the in-flight PDF-byte fetch so WebKit's network loader frees
      // the slot instead of queueing an "internal failure".
      controller.abort();
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      // Free the finished document, or cancel a still-loading one (not both).
      if (doc) void doc.destroy();
      else void loadingTask?.destroy();
      doc = null;
    };
  }, [sourceId]);

  // --- Render the current page. --------------------------------------------
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    // Cancel any in-flight render from a prior page before starting a new one.
    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;
    if (areaRef.current) areaRef.current.scrollTop = 0;

    (async () => {
      try {
        const pdfPage = await pdf.getPage(page);
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;

        // --- Fit-to-width on first paint of a freshly loaded document. ----
        // Ship at the default scale, then fill the pane width once we can
        // measure it (exactly once per document — autoFitDone guards against
        // re-fitting once the user starts zooming manually).
        const cw = areaRef.current?.clientWidth ?? 0;
        if (!autoFitDone.current && cw > 0) {
          autoFitDone.current = true;
          const pageW = pdfPage.getViewport({ scale: 1 }).width;
          const fit = Math.min(
            MAX_SCALE,
            Math.max(MIN_SCALE, (cw - 32) / pageW),
          );
          fitScale.current = fit;
          setScale(fit); // bumps `scale` → this effect re-runs and paints at fit
          return; // skip painting this pass; the re-run below does it
        }

        const viewport = pdfPage.getViewport({ scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const task = pdfPage.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;

        // Build the selectable text layer over the canvas (pdf.js TextLayer).
        // The container is sized to the viewport and inherits --scale-factor
        // (set inline on .pdf-page-wrap) so each span's font-size calc scales
        // with zoom. Cancel any prior instance; clearing innerHTML resets the
        // container for a fresh render. Best-effort: a failure never blanks
        // the page — the canvas is already painted above.
        textLayerTaskRef.current?.cancel();
        const tl = textLayerRef.current;
        if (tl) {
          tl.innerHTML = "";
          tl.style.width = `${viewport.width}px`;
          tl.style.height = `${viewport.height}px`;
          try {
            const textContent = await pdfPage.getTextContent();
            if (cancelled) return;
            const instance = new pdfjsLib.TextLayer({
              textContentSource: textContent,
              container: tl,
              viewport,
            });
            textLayerTaskRef.current = instance;
            await instance.render();
          } catch (e) {
            if ((e as Error)?.name === "RenderingCancelledException") return;
          }
        }
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
      textLayerTaskRef.current?.cancel();
      textLayerTaskRef.current = null;
    };
  }, [pdf, page, scale]);

  // --- External page navigation (e.g. clicking a citation [@key:5]) --------
  // `initialPage` seeds the starting page on mount (the useState init above)
  // and also doubles as a live "go to page" command: when a citation click
  // bumps it for an already-open tab (same sourceId → no remount), this effect
  // jumps the viewer there. The viewer's own prev/next buttons only call
  // setPage, so they never fight this. Ignored once until the PDF is loaded
  // (no `total` to clamp against yet).
  useEffect(() => {
    if (!pdf || !initialPage) return;
    setPage(Math.min(Math.max(1, initialPage), total || initialPage));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPage]);

  // Clear any live selection when the page or source changes (the text
  // layer is rebuilt, so an old selection's anchor node is gone). Also drops
  // the native DOM selection so it can't linger across pages.
  useEffect(() => {
    setSel(null);
    setPopup(null);
    if (typeof window !== "undefined")
      window.getSelection()?.removeAllRanges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, page]);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    let accum = 0;
    let locked = false;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    let unlockTimer: ReturnType<typeof setTimeout> | undefined;
    const norm = (e: WheelEvent): number =>
      e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 600 : 1);
    const onWheel = (e: WheelEvent) => {
      const goingDown = e.deltaY > 0;
      const atTop = el.scrollTop <= 0;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
      const atEdge = goingDown ? atBottom : atTop;
      if (!atEdge) return;
      e.preventDefault();
      if (locked) return;
      accum += norm(e);
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        accum = 0;
      }, 200);
      const threshold = 60;
      if (Math.abs(accum) < threshold) return;
      const dir = accum > 0 ? 1 : -1;
      accum = 0;
      locked = true;
      setPage((p) => Math.min(Math.max(1, p + dir), Math.max(1, total)));
      unlockTimer = setTimeout(() => {
        locked = false;
      }, 320);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      clearTimeout(resetTimer);
      clearTimeout(unlockTimer);
    };
  }, [total]);

  if (loading) return <div className="pdf-status">Loading PDF…</div>;
  if (error) return <div className="pdf-error">Failed to load PDF: {error}</div>;

  const goto = (n: number): void => {
    if (!total) return;
    setPage(Math.min(Math.max(1, n), total));
  };

  const zoomIn = (): void =>
    setScale((s) => Math.min(MAX_SCALE, Math.round((s + ZOOM_STEP) * 100) / 100));
  const zoomOut = (): void =>
    setScale((s) => Math.max(MIN_SCALE, Math.round((s - ZOOM_STEP) * 100) / 100));
  const zoomReset = (): void => setScale(fitScale.current);

  // Selection within the transparent text layer → show the "Save note" pill.
  // Only fires for selections anchored INSIDE the text layer (not e.g. the
  // page input). The bbox is normalized to page-space % so a future highlight
  // overlay survives zoom.
  const handleSelectionMouseUp = (): void => {
    const tl = textLayerRef.current;
    const canvas = canvasRef.current;
    if (!tl || !canvas) return;
    const s = window.getSelection();
    const text = s?.toString() ?? "";
    if (!text.trim() || !s || !s.anchorNode || !tl.contains(s.anchorNode)) {
      setSel(null);
      return;
    }
    const r = s.getRangeAt(0).getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) {
      setSel(null);
      return;
    }
    const cr = canvas.getBoundingClientRect();
    const pageRect: NoteRect | null =
      cr.width > 0 && cr.height > 0
        ? {
            x: ((r.left - cr.left) / cr.width) * 100,
            y: ((r.top - cr.top) / cr.height) * 100,
            w: (r.width / cr.width) * 100,
            h: (r.height / cr.height) * 100,
          }
        : null;
    setSel({ text, clientRect: r, pageRect });
  };

  const openNotePopup = (): void => {
    if (!sel) return;
    setPopup(sel);
    setSel(null);
  };

  const sendSelectionToChat = (): void => {
    if (!sel) return;
    useChatInputStore.getState().request(sel.text);
    setSel(null);
    window.getSelection()?.removeAllRanges();
  };

  const copySelection = async (): Promise<void> => {
    if (!sel) return;
    try {
      await navigator.clipboard.writeText(sel.text);
    } catch {
    }
    setSel(null);
    window.getSelection()?.removeAllRanges();
  };

  return (
    <div className="pdf-viewer">
      <PdfControls
        page={page}
        total={total}
        scale={scale}
        goto={goto}
        zoomIn={zoomIn}
        zoomOut={zoomOut}
        zoomReset={zoomReset}
        onOpenCitation={() => setShowCitation(true)}
      />
      <div className="pdf-canvas-area" ref={areaRef}>
        {/* --scale-factor drives the TextLayer's per-span font-size calc. */}
        <div
          className="pdf-page-wrap"
          ref={pageWrapRef}
          onMouseUp={handleSelectionMouseUp}
          style={{ "--scale-factor": scale } as CSSProperties}
        >
          <canvas ref={canvasRef} />
          <div ref={textLayerRef} className="textLayer" />
        </div>
      </div>
      {sel && (
        <div
          ref={(el) => {
            pillRef.current = el;
            if (!el) {
              setPillLeft(null);
              return;
            }
            const center = sel.clientRect.left + sel.clientRect.width / 2;
            const half = el.offsetWidth / 2;
            const max = window.innerWidth - el.offsetWidth - 4;
            setPillLeft(Math.max(4, Math.min(Math.round(center - half), max)));
          }}
          className="note-save-pill"
          style={{
            left: pillLeft ?? -9999,
            top: Math.round(sel.clientRect.bottom + 8),
            visibility: pillLeft === null ? "hidden" : "visible",
          }}
        >
          <button
            type="button"
            className="note-save-pill-btn"
            onClick={openNotePopup}
            title="Save this passage as a note"
          >
            📝 Save note
          </button>
          <button
            type="button"
            className="note-save-pill-btn"
            onClick={sendSelectionToChat}
            title="Quote this passage in the chat"
          >
            💬 To chat
          </button>
          <button
            type="button"
            className="note-save-pill-btn"
            onClick={() => void copySelection()}
            title="Copy this passage to the clipboard"
          >
            📋 Copy
          </button>
        </div>
      )}
      {popup && (
        <NotePopup
          sourceId={sourceId}
          page={page}
          initialExcerpt={popup.text}
          rect={popup.clientRect}
          pageRect={popup.pageRect}
          onClose={() => {
            setPopup(null);
            window.getSelection()?.removeAllRanges();
          }}
        />
      )}
      {showCitation && (
        <ReferenceEditDialog
          sourceId={sourceId}
          onClose={() => setShowCitation(false)}
        />
      )}
    </div>
  );
}
