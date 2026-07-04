// TextViewer — read-only extracted-text view for non-PDF/non-image sources
// (docx, xlsx, plain text, markdown, even "unsupported"). Fetches the sidecar's
// page-tagged concatenation (`GET /sources/:id/text`) and renders it in a
// scrollable monospace container.
//
// Empty text is NOT an error: it means the file hasn't been extracted yet
// (or has no chunks). We surface a muted placeholder in that case so the tab
// still opens and the user understands the state.

import { useEffect, useState } from "react";
import { api } from "../lib/api";

interface Props {
  sourceId: string;
}

interface SourceText {
  filename: string;
  text: string;
  pageCount: number;
}

export function TextViewer({ sourceId }: Props) {
  const [data, setData] = useState<SourceText | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    setLoading(true);
    setError(null);
    setData(null);

    (async () => {
      try {
        const res = await api.getSourceText(sourceId);
        if (aborted) return;
        setData(res);
        setLoading(false);
      } catch (e) {
        if (aborted) return;
        setError((e as Error)?.message ?? String(e));
        setLoading(false);
      }
    })();

    return () => {
      aborted = true;
    };
  }, [sourceId]);

  if (loading) return <div className="text-viewer-status">Loading…</div>;
  if (error) return <div className="pdf-error">Failed to load text: {error}</div>;

  const empty = !data?.text;
  return (
    <div className="text-viewer">
      <div className="text-viewer-head">
        <span className="text-viewer-filename">{data?.filename}</span>
        {data && data.pageCount > 0 && (
          <span className="muted small">{data.pageCount} pages</span>
        )}
      </div>
      {empty ? (
        <div className="text-viewer-empty muted">
          This file hasn’t been extracted yet.
          <div className="small">
            If it needs OCR, resolve it from the Attention list in the Library.
          </div>
        </div>
      ) : (
        // `white-space: pre-wrap` (set in CSS) preserves the [p.N] page
        // markers and paragraph breaks from the concatenation.
        <pre className="text-viewer-body">{data!.text}</pre>
      )}
    </div>
  );
}
