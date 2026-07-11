// ManuscriptEditor — the writable, Word-like editor for a Dissertation
// `Document` (a paper / thesis being authored). Built on Milkdown 7 (a
// markdown-first WYSIWYG on ProseMirror) so the user sees formatted text and
// never has to know markdown — yet the stored source of truth is the document's
// `body_md` column, which is what the agent contract and pandoc export consume.
//
// Data flow (DESIGN.md §3 + docs/tools.md §4):
//   GET /documents/:id  → Document (with bodyMd)   (load once per documentId)
//   edit the body in Milkdown
//   on every change → debounced (800ms) PUT /documents/:id { bodyMd }   (autosave)
//
// The editor is keyed by `documentId` in CenterPane, so switching documents
// remounts a fresh instance with the right initial markdown — no in-place
// content swapping, no save/replace guard needed.
//
// A Document is ONE body. Markdown headers (`## intro`) are just lines in
// the body, not separate rows — structural stats (line count, header
// positions) are computed by parsing the body, never stored.
//
// Citation tokens `[@citekey:printedPage]` (DESIGN.md §11 #8) are rendered as
// clickable "chips" by a ProseMirror decorations plugin (see
// `citationPlugin`) — the raw token stays editable text so the agent, autosave
// and pandoc export all see clean markdown. Clicking a chip resolves the
// citation (open the linked PDF at the page, or pop up the reference card).
//
// Source-MD toggle: a read-only peek at the underlying markdown for power
// users / debugging (the user-facing surface stays WYSIWYG by default).

import "../../lib/milkdown-theme.css";
import "@milkdown/theme-nord/style.css";

import { useEffect, useState } from "react";
import { MilkdownProvider } from "@milkdown/react";
import type { Document } from "@dissertator/shared";
import { api } from "../../lib/api";
import { EditorInner } from "./EditorInner";
import type { CitationClickHandler } from "./_shared";

interface Props {
  documentId: string;
  /** P5: bumps whenever the agent edits this document. The editor refetches
   *  on change and live-swaps the body via `replaceAll` when it has no unsaved
   *  local edits (otherwise it shows a stale banner the user can accept). */
  revision?: number;
  /** Citation-chip click handler. When omitted, chips still render (styled)
   *  but are inert. */
  onCitationClick?: CitationClickHandler;
}

export function ManuscriptEditor({ documentId, revision = 0, onCitationClick }: Props) {
  const [doc, setDoc] = useState<Document | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    setLoading(true);
    setError(null);
    setDoc(null);
    (async () => {
      try {
        const d = await api.getDocument(documentId);
        if (aborted) return;
        setDoc(d);
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
  }, [documentId, revision]);

  if (loading) return <div className="editor-status">Loading document…</div>;
  if (error)
    return <div className="editor-error">Failed to load document: {error}</div>;
  if (!doc) return null;

  return (
    <MilkdownProvider>
      <EditorInner
        document={doc}
        initialMarkdown={doc.bodyMd ?? ""}
        onCitationClick={onCitationClick}
      />
    </MilkdownProvider>
  );
}
