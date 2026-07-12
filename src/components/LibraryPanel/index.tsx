// LibraryPanel — the left sidebar: the corpus browser.
//
// Orchestrates the panel-level search query and renders four collapsible
// groups in a fixed order: 🔵 Sources, 🟡 Documents, 📒 References, 🔖 Lists,
// followed by the AttentionPanel. Each complex group owns its own state and
// fetching (see `_SourcesGroup`, `_ListsGroup`); the Documents + References
// groups are simple enough to stay inline.

import { useState } from "react";
import type {
  Document,
  OcrStrategy,
  ProjectStatus,
  SourceFile,
  SourcesResponse,
} from "@dissertator/shared";
import { AttentionPanel } from "../AttentionPanel";
import { SourcesGroup } from "./_SourcesGroup";
import { ListsGroup } from "./_ListsGroup";
import { ATTENTION_STATUSES } from "./_shared";

interface Props {
  project: ProjectStatus | null;
  /** Live source list + counts from `/sources`. Optional; falls back to
   *  `project.counts.sourceFiles` when absent (e.g. before first fetch). */
  sources?: SourcesResponse | null;
  /** Click handler for the rescan button. */
  onRescan?: () => void;
  /** Fired when an attention item is resolved (OCR ran). Refreshes the
   *  source list. Defaults to `onRescan` when not supplied. */
  onAttentionResolved?: () => void;
  /** While a rescan / OCR call is in flight, disable the rescan button. */
  busy?: boolean;
  /** Provider + strategy forwarded to the AttentionPanel. */
  provider?: string;
  ocrStrategy?: OcrStrategy;
  /** Vision-doc provider key (OCR-vision). Separate from the chat key. */
  visionDocKey?: string;
  /** Vision-image provider key (describe standalone images). */
  visionImageKey?: string;
  /** STT provider key (transcribe). */
  sttKey?: string;
  /** Embedding API key (separate slot from the chat key). When set + there are
   *  pending chunks, the Sources group offers an "Embed now" action. */
  embeddingApiKey?: string;
  /** Open a source in the CenterPane viewer (click-to-open). */
  onOpen?: (src: SourceFile) => void;
  /** Manuscript documents for the 🟡 Documents group. */
  documents?: Document[];
  /** Create + open a new document. */
  onNewDocument?: () => void;
  /** Open an existing document in the editor. */
  onOpenDocument?: (doc: Document) => void;
  /** Open the Settings dialog (used by the embedding no-key nudge). */
  onOpenSettings?: () => void;
  /** Open the bibliography manager as a center-pane tab. Fired by the
   *  📒 References group card. */
  onOpenReferences?: () => void;
  /** Open a note's source in the viewer at the note's page (click-to-open
   *  from the Lists group). */
  onOpenNote?: (sourceId: string, page: number) => void;
}

export function LibraryPanel({
  project,
  sources,
  onRescan,
  onAttentionResolved,
  busy,
  provider,
  ocrStrategy,
  visionDocKey,
  visionImageKey,
  sttKey,
  embeddingApiKey,
  onOpen,
  documents,
  onNewDocument,
  onOpenDocument,
  onOpenSettings,
  onOpenReferences,
  onOpenNote,
}: Props) {
  // Panel-level search query; currently filters the Sources group only.
  const [query, setQuery] = useState("");

  if (!project?.initialized) {
    return (
      <aside className="panel lib">
        <div className="panel-title">Library</div>
        <p className="muted">
          Open a research folder to build your corpus. Files are scanned,
          extracted, OCR'd, and indexed for grounded retrieval.
        </p>
      </aside>
    );
  }

  const c = project.counts;
  const attentionItems = (sources?.items ?? []).filter((i) =>
    ATTENTION_STATUSES.includes(i.textStatus),
  );

  return (
    <aside className="panel lib">
      <div className="panel-title">Library</div>
      <div className="search">
        <input
          placeholder="🔍 search sources…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <SourcesGroup
        project={project}
        sources={sources}
        query={query}
        onRescan={onRescan}
        busy={busy}
        embeddingApiKey={embeddingApiKey}
        onOpen={onOpen}
        onOpenSettings={onOpenSettings}
      />

      <div className="group yellow">
        <div className="group-head group-head-row">
          <span>🟡 Documents</span>
          {onNewDocument && (
            <button
              className="btn ghost tiny-btn"
              onClick={onNewDocument}
              title="Create a new document"
            >
              + New
            </button>
          )}
        </div>
        <div className="count">{(documents ?? []).length} drafts</div>
        <div className="muted small">Your papers &amp; dissertations</div>
        {(documents ?? []).length > 0 && (
          <div className="source-tree">
            {(documents ?? []).map((d) => (
              <div
                key={d.id}
                className="source-row"
                title={d.title}
                onClick={() => onOpenDocument?.(d)}
              >
                <span className="source-dot doc" />
                <span className="source-name">{d.title}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div
        className="group purple clickable"
        onClick={onOpenReferences}
        title={onOpenReferences ? "Open the bibliography manager" : ""}
      >
        <div className="group-head">📒 References</div>
        <div className="count">{c.references} entries</div>
        <div className="muted small">APA bibliography (citeproc)</div>
      </div>

      <ListsGroup sources={sources} onOpenNote={onOpenNote} />

      <AttentionPanel
        items={attentionItems}
        visionDocKey={visionDocKey}
        visionImageKey={visionImageKey}
        sttKey={sttKey}
        provider={provider}
        ocrStrategy={ocrStrategy ?? "tesseract"}
        onResolved={() => (onAttentionResolved ?? onRescan)?.()}
      />
    </aside>
  );
}
