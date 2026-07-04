// CenterPane — the middle document area.
//
// When no tabs are open it shows the empty placeholder (hero on a fresh
// project load, or the "No document open" wizard stub once initialized).
// When tabs ARE open it switches to a flex-column layout: a tab bar pinned
// at the top and the active tab's viewer filling the rest. Only the active
// tab's content is mounted — switching tabs re-mounts the viewer (cheap; each
// viewer manages its own fetch + cleanup).

import { Sparkle } from "@phosphor-icons/react";
import type { Tab } from "../lib/tabs";
import { api } from "../lib/api";
import type { SourceFile } from "@dissertator/shared";
import { PdfViewer } from "./PdfViewer";
import { TextViewer } from "./TextViewer";
import { ManuscriptEditor } from "./ManuscriptEditor";

interface Props {
  initialized: boolean;
  tabs: Tab[];
  activeTabId: string | null;
  onActivate: (sourceId: string) => void;
  onClose: (sourceId: string) => void;
  /** Used only for type-checking the open pipeline (the handler lives in App).
   *  Kept on the props interface so the wiring is explicit. */
  onOpen?: (src: SourceFile) => void;
  /** Create + open a new document. Replaces the disabled "Start Wizard"
   *  placeholder until the P4 wizard lands. */
  onNewDocument?: () => void;
}

export function CenterPane({
  initialized,
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onNewDocument,
}: Props) {
  const active = tabs.find((t) => t.sourceId === activeTabId) ?? null;
  const hasTabs = tabs.length > 0;

  // No open tabs → preserve the original empty placeholder logic.
  if (!hasTabs || !active) {
    return (
      <section className="panel center">
        {initialized ? (
          <div className="placeholder">
            <h2>No document open</h2>
            <p className="muted">
              Click a source in the Library to open it here, or start writing a
              new document grounded in your corpus.
            </p>
            <button
              className="btn primary"
              onClick={onNewDocument}
              disabled={!onNewDocument}
              title="Create a blank document and open the editor"
            >
              <Sparkle size={16} weight="fill" />
              New Document
            </button>
            <div className="muted small">
              PDF viewer &amp; citation tools arrive next.
            </div>
          </div>
        ) : (
          <div className="placeholder">
            <h1 className="hero">📚 Dissertator</h1>
            <p className="muted">
              Open a research folder to turn 100 documents into a grounded
              dissertation.
            </p>
          </div>
        )}
      </section>
    );
  }

  // Tabs open → top-aligned flex column (tab bar + content fill).
  return (
    <section className="panel center with-tabs">
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <div
            key={t.sourceId}
            className={`tab${t.sourceId === activeTabId ? " active" : ""}`}
            role="tab"
            aria-selected={t.sourceId === activeTabId}
            title={t.title}
            onClick={() => onActivate(t.sourceId)}
          >
            <span className="tab-title">{t.title}</span>
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.sourceId);
              }}
              title="Close tab"
              aria-label={`Close ${t.title}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="tab-content">
        {/* `key={sourceId}` forces a fresh viewer instance per source so
            viewer-local state (e.g. PdfViewer's current page) resets when
            switching between two tabs of the SAME kind (pdf→pdf, text→text).
            Without it React reuses the instance and only updates `sourceId`,
            so e.g. page 5 of PDF A would carry over to PDF B. */}
        {active.kind === "pdf" && (
          <PdfViewer key={active.sourceId} sourceId={active.sourceId} />
        )}
        {active.kind === "image" && (
          <div className="image-viewer">
            <img src={api.fileUrl(active.sourceId)} alt={active.title} />
          </div>
        )}
        {active.kind === "text" && (
          <TextViewer key={active.sourceId} sourceId={active.sourceId} />
        )}
        {active.kind === "doc" && (
          <ManuscriptEditor key={active.sourceId} documentId={active.sourceId} />
        )}
      </div>
    </section>
  );
}
