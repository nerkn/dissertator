// CenterPane — the middle document area.
//
// When no tabs are open it shows the empty placeholder (hero on a fresh
// project load, or the "No document open" wizard stub once initialized).
// When tabs ARE open it switches to a flex-column layout: a tab bar pinned
// at the top and the active tab's viewer filling the rest. Read-only viewers
// (pdf/image/text/references) mount only while active — they're cheap to
// refetch. Manuscript editors are the exception: they're kept mounted (just
// hidden) across tab switches so the caret, scroll position, and undo
// history survive — see the keep-alive block below.

import { Sparkle, CaretLeft, CaretRight } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTabsStore } from "../lib/stores/tabs";
import { api } from "../lib/api";
import { useContentStore, useSourceItems } from "../lib/stores/content";
import { useSessionStore } from "../lib/stores/session";
import { PdfViewer } from "./PdfViewer";
import { TextViewer } from "./TextViewer";
import { ManuscriptEditor } from "./ManuscriptEditor";
import { ReferencesView } from "./ReferencesView";
import type { CitationClickHandler } from "../lib/citationPlugin";

interface Props {
  /** Create + open a new document. Replaces the disabled "Start Wizard"
   *  placeholder until the P4 wizard lands. */
  onNewDocument?: () => void;
  /** Citation-chip click handler (manuscript editor → App resolves + opens). */
  onCitationClick?: CitationClickHandler;
}

export function CenterPane({
  onNewDocument,
  onCitationClick,
}: Props) {
  const initialized = useSessionStore((s) => !!s.project?.initialized);
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const onActivate = useTabsStore((s) => s.setActiveTabId);
  const onClose = useTabsStore((s) => s.closeTab);
  const openSource = useTabsStore((s) => s.openSource);
  const sources = useSourceItems();
  const docRevisions = useContentStore((s) => s.docRevisions);

  const active = tabs.find((t) => t.sourceId === activeTabId) ?? null;
  const hasTabs = tabs.length > 0;
  const refsById = useContentStore((s) => s.referencesBySource);

  const tabsRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState({ left: false, right: false });

  const updateScrollState = useCallback(() => {
    const el = tabsRef.current;
    if (!el) return;
    setScrollState({
      left: el.scrollLeft > 4,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    });
  }, []);

  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    updateScrollState();
    const onScroll = () => updateScrollState();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => updateScrollState());
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [updateScrollState, tabs.length]);

  useEffect(() => {
    const el = tabsRef.current;
    if (!el || !activeTabId) return;
    el.querySelector<HTMLElement>(".tab.active")?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeTabId, tabs.length]);

  const scrollByDir = useCallback((dir: 1 | -1) => {
    const el = tabsRef.current;
    if (!el) return;
    el.scrollBy({
      left: dir * Math.max(140, el.clientWidth * 0.7),
      behavior: "smooth",
    });
  }, []);

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
      <div className="tabs-wrap">
        {scrollState.left && (
          <button
            className="tab-scroll-btn left"
            onClick={() => scrollByDir(-1)}
            aria-label="Scroll tabs left"
            title="Scroll left"
          >
            <CaretLeft size={14} weight="bold" />
          </button>
        )}
        <div className="tabs" role="tablist" ref={tabsRef}>
          {tabs.map((t) => {
            const refTitle = refsById?.get(t.sourceId)?.title?.trim();
            const displayTitle = refTitle || t.title;
            return (
            <div
              key={t.sourceId}
              className={`tab${t.sourceId === activeTabId ? " active" : ""}`}
              role="tab"
              aria-selected={t.sourceId === activeTabId}
              title={t.filename ?? t.title}
              onClick={() => onActivate(t.sourceId)}
            >
              <span className="tab-title">{displayTitle}</span>
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.sourceId);
                }}
                title="Close tab"
                aria-label={`Close ${displayTitle}`}
              >
                ×
              </button>
            </div>
            );
          })}
        </div>
        {scrollState.right && (
          <button
            className="tab-scroll-btn right"
            onClick={() => scrollByDir(1)}
            aria-label="Scroll tabs right"
            title="Scroll right"
          >
            <CaretRight size={14} weight="bold" />
          </button>
        )}
      </div>
      <div className="tab-content">
        {/* `key={sourceId}` forces a fresh viewer instance per source so
            viewer-local state (e.g. PdfViewer's current page) resets when
            switching between two tabs of the SAME kind (pdf→pdf, text→text).
            Without it React reuses the instance and only updates `sourceId`,
            so e.g. page 5 of PDF A would carry over to PDF B. */}
        {active.kind === "pdf" && (
          <PdfViewer
            key={active.sourceId}
            sourceId={active.sourceId}
            initialPage={active.initialPage}
          />
        )}
        {active.kind === "image" && (
          <div className="image-viewer">
            <img src={api.fileUrl(active.sourceId)} alt={active.title} />
          </div>
        )}
        {active.kind === "text" && (
          <TextViewer key={active.sourceId} sourceId={active.sourceId} />
        )}
        {active.kind === "references" && (
          <ReferencesView
            key={active.sourceId}
            sources={sources ?? []}
            onOpenSource={openSource}
          />
        )}

        {/* Manuscript editors are stateful and expensive to rebuild
            (Milkdown/ProseMirror instance, undo history, caret, scroll
            position). Keep every open document mounted and hide the inactive
            ones with `display:none`, so switching to a PDF and back preserves
            cursor, scroll, and undo history. Closing a tab removes it from
            this list, which unmounts it (ManuscriptEditor flushes any pending
            autosave on unmount).

            Both `doc` (a Document in the DB) and `md-source` (a .md source
            file edited in place on disk) render through ManuscriptEditor —
            only the load/save backend differs. */}
        {tabs
          .filter((t) => t.kind === "doc" || t.kind === "md-source")
          .map((t) => {
            const visible = t.sourceId === activeTabId;
            return (
              <div
                key={t.sourceId}
                className="keepalive-pane"
                hidden={!visible}
                aria-hidden={!visible}
              >
                <ManuscriptEditor
                  mode={t.kind === "md-source" ? "source" : "document"}
                  documentId={t.sourceId}
                  revision={docRevisions?.[t.sourceId] ?? 0}
                  onCitationClick={onCitationClick}
                />
              </div>
            );
          })}
      </div>
    </section>
  );
}
