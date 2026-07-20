// LibraryPanel — the left sidebar: the corpus browser.
//
// Orchestrates the panel-level search query and renders collapsible groups
// in a fixed order: 🟡 Manuscripts, 🔵 Documents, 🔖 Favorites, 📒 References,
// followed by the AttentionPanel. Each complex group owns its own state and
// fetching (see `_SourcesGroup`, `_ListsGroup`); the References group is a
// simple singleton launcher. Manuscripts mixes DB documents with markdown
// source files (both editable in the ManuscriptEditor).

import { useState } from "react";
import type {
  Document,
  OcrStrategy,
  SourceFile,
} from "@dissertator/shared";
import { useContentStore } from "../../lib/stores/content";
import { useSessionStore } from "../../lib/stores/session";
import { AttentionPanel } from "../AttentionPanel";
import { SourcesGroup } from "./_SourcesGroup";
import { ManuscriptsGroup } from "./_ManuscriptsGroup";
import { ListsGroup } from "./_ListsGroup";
import { ATTENTION_STATUSES, isMdSource } from "./_shared";

interface Props {
  /** Click handler for the rescan button. */
  onRescan?: () => void;
  /** Fired when an attention item is resolved (OCR ran). Refreshes the
   *  source list. Defaults to `onRescan` when not supplied. */
  onAttentionResolved?: () => void;
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
  chatKey?: string;
  /** Open a source in the CenterPane viewer (click-to-open). */
  onOpen?: (src: SourceFile) => void;
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
  onRescan,
  onAttentionResolved,
  provider,
  ocrStrategy,
  visionDocKey,
  visionImageKey,
  sttKey,
  embeddingApiKey,
  chatKey,
  onOpen,
  onNewDocument,
  onOpenDocument,
  onOpenSettings,
  onOpenReferences,
  onOpenNote,
}: Props) {
  // Panel-level search query; currently filters the Documents group only.
  const [query, setQuery] = useState("");

  const sources = useContentStore((s) => s.sources);
  const documents = useContentStore((s) => s.documents);
  const project = useSessionStore((s) => s.project);
  const busy = useSessionStore((s) => s.busy);

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

  const mdSources = (sources?.items ?? []).filter(isMdSource);
  const attentionItems = (sources?.items ?? []).filter((i) =>
    ATTENTION_STATUSES.includes(i.textStatus),
  );

  return (
    <aside className="panel lib">
      <div className="panel-title">Library</div>
      <div className="search">
        <input
          placeholder="🔍 search documents…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <ManuscriptsGroup
        documents={documents ?? []}
        mdSources={mdSources}
        onOpenDocument={onOpenDocument}
        onOpenMd={onOpen}
        onNewDocument={onNewDocument}
      />

      <SourcesGroup
        project={project}
        sources={sources}
        query={query}
        onRescan={onRescan}
        busy={busy}
        embeddingApiKey={embeddingApiKey}
        chatKey={chatKey}
        onOpen={onOpen}
        onOpenSettings={onOpenSettings}
      />

      <ListsGroup sources={sources} onOpenNote={onOpenNote} />

      <div className="group purple">
        <div className="group-head group-head-row">
          <span title="APA bibliography (citeproc)">References</span>
          {onOpenReferences && (
            <button
              className="btn ghost tiny-btn"
              onClick={onOpenReferences}
              title="Open the bibliography manager"
            >
              Open
            </button>
          )}
        </div>
      </div>

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
