import {
  Gear,
  FolderOpen,
  Books,
  PencilSimpleLine,
  ChatCircleDots,
} from "@phosphor-icons/react";
import { LibraryPanel } from "../components/LibraryPanel";
import { CenterPane } from "../components/CenterPane";
import { ChatPanel } from "../components/ChatPanel";
import { SettingsDialog } from "../components/SettingsDialog";
import { CitationPopup } from "../components/CitationPopup";
import { WindowControls } from "../components/WindowControls";
import { ResizeHandle } from "../components/ResizeHandle";
import { SystemDialog } from "../components/SystemDialog";
import { useApp } from "./useApp";
import { useSessionStore } from "../lib/stores/session";

export default function App() {
  const health = useSessionStore((s) => s.health);
  const project = useSessionStore((s) => s.project);
  const showSettings = useSessionStore((s) => s.showSettings);
  const busy = useSessionStore((s) => s.busy);
  const error = useSessionStore((s) => s.error);
  const setShowSettings = useSessionStore((s) => s.setShowSettings);
  const setError = useSessionStore((s) => s.setError);
  const initialized = !!project?.initialized;

  const {
    settings,
    citationPopup,
    chatPanelRef,
    configured,
    apiKey,
    embeddingApiKey,
    visionDocKey,
    visionImageKey,
    sttKey,
    setCitationPopup,
    onOpenFolder,
    handleRescan,
    handleNewDocument,
    openSource,
    openDocument,
    openReferencesView,
    openSourceByIdAtPage,
    handleCitationClick,
    handleDocumentEdited,
    handleOpenSourceById,
    handleOpenDocumentById,
    handleSettingsChange,
    refreshSources,
  } = useApp();
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" data-tauri-drag-region>📚 Dissertator</div>
        <div className="project-name" data-tauri-drag-region title={project?.projectPath ?? ""}>
          {initialized ? project!.projectPath : "no project open"}
        </div>
        <div className="spacer" data-tauri-drag-region />
        <span className={`health-dot ${health}`} title={`sidecar: ${health}`} />
        <button
          className="btn ghost"
          onClick={onOpenFolder}
          disabled={busy || health !== "up"}
          title="Open a research folder"
        >
          <FolderOpen size={16} weight="bold" />
          Open Folder
        </button>
        <button
          className="btn ghost"
          onClick={() => setShowSettings(true)}
          disabled={!initialized}
          title={initialized ? "Provider & API key" : "Open a folder first"}
        >
          <Gear size={16} weight="bold" />
          Settings
        </button>
        <WindowControls />
      </header>
      <ResizeHandle />

      <main className="body">
        <LibraryPanel
          onRescan={handleRescan}
          onAttentionResolved={refreshSources}
          provider={settings?.resolved?.vision_doc?.type}
          ocrStrategy={settings?.ocrStrategy}
          visionDocKey={visionDocKey}
          visionImageKey={visionImageKey}
          sttKey={sttKey}
          embeddingApiKey={embeddingApiKey}
          chatKey={apiKey}
          onOpen={openSource}
          onNewDocument={handleNewDocument}
          onOpenDocument={openDocument}
          onOpenSettings={() => setShowSettings(true)}
          onOpenReferences={openReferencesView}
          onOpenNote={openSourceByIdAtPage}
        />
        <CenterPane
          onNewDocument={handleNewDocument}
          onCitationClick={handleCitationClick}
        />
        <ChatPanel
          ref={chatPanelRef}
          configured={configured}
          apiKey={apiKey}
          embeddingApiKey={embeddingApiKey}
          onDocumentEdited={handleDocumentEdited}
          onOpenSource={handleOpenSourceById}
          onOpenDocument={handleOpenDocumentById}
          onOpenSettings={() => setShowSettings(true)}
        />
      </main>

      <footer className="statusbar">
        <Books size={14} /> corpus &middot; <PencilSimpleLine size={14} />{" "}
        documents &middot; <ChatCircleDots size={14} /> agent
      </footer>

      {error && (
        <div className="toast error" onClick={() => setError(null)}>
          {error} <span className="muted">(click to dismiss)</span>
        </div>
      )}

      {showSettings && settings && (
        <SettingsDialog
          settings={settings}
          onSettingsChange={handleSettingsChange}
          onClose={() => setShowSettings(false)}
        />
      )}
      {citationPopup && (
        <CitationPopup
          citekey={citationPopup.citekey}
          page={citationPopup.page}
          rect={citationPopup.rect}
          onLinkOpen={openSourceByIdAtPage}
          onClose={() => setCitationPopup(null)}
        />
      )}

      {/* In-app prompt/confirm/alert renderer (replaces window.prompt etc.) */}
      <SystemDialog />
    </div>
  );
}
