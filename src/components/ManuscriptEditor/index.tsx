import "../../lib/milkdown-theme.css";
import "@milkdown/theme-nord/style.css";

import { useEffect, useState } from "react";
import { MilkdownProvider } from "@milkdown/react";
import { api } from "../../lib/api";
import { EditorInner } from "./EditorInner";
import type { CitationClickHandler } from "./_shared";

interface Props {
  sourceId: string;
  revision?: number;
  onCitationClick?: CitationClickHandler;
}

interface LoadedDoc {
  id: string;
  title: string;
  bodyMd: string;
}

export function ManuscriptEditor({
  sourceId,
  revision = 0,
  onCitationClick,
}: Props) {
  const [doc, setDoc] = useState<LoadedDoc | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    const coldStart = !doc || doc.id !== sourceId;
    if (coldStart) {
      setLoading(true);
      setError(null);
      setDoc(null);
    }
    (async () => {
      try {
        const d = await api.getSourceMarkdown(sourceId);
        if (aborted) return;
        setDoc({ id: d.id, title: d.title, bodyMd: d.bodyMd });
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
  }, [sourceId, revision]);

  if (loading) return <div className="editor-status">Loading manuscript…</div>;
  if (error)
    return <div className="editor-error">Failed to load manuscript: {error}</div>;
  if (!doc) return null;

  return (
    <MilkdownProvider>
      <EditorInner
        source={doc}
        initialMarkdown={doc.bodyMd ?? ""}
        onCitationClick={onCitationClick}
      />
    </MilkdownProvider>
  );
}
