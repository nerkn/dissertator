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
import { useApp } from "./useApp";

export default function App() {
  const {
    health,
    project,
    settings,
    sources,
    showSettings,
    busy,
    error,
    tabs,
    activeTabId,
    documents,
    docRevisions,
    providers,
    keys,
    citationPopup,
    chatPanelRef,
    initialized,
    configured,
    apiKey,
    embeddingApiKey,
    visionDocKey,
    visionImageKey,
    sttKey,
    activeDocumentId,
    setShowSettings,
    setError,
    setCitationPopup,
    setActiveTabId,
    onOpenFolder,
    handleRescan,
    handleNewDocument,
    openSource,
    openDocument,
    openReferencesView,
    openSourceByIdAtPage,
    closeTab,
    handleCitationClick,
    handleDocumentEdited,
    handleOpenSourceById,
    handleOpenDocumentById,
    handleProvidersChange,
    handleSettingsChange,
    handleKeyChange,
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
          project={project}
          sources={sources}
          documents={documents}
          onRescan={handleRescan}
          onAttentionResolved={refreshSources}
          busy={busy}
          provider={settings?.resolved?.vision_doc?.type}
          ocrStrategy={settings?.ocrStrategy}
          visionDocKey={visionDocKey}
          visionImageKey={visionImageKey}
          sttKey={sttKey}
          embeddingApiKey={embeddingApiKey}
          onOpen={openSource}
          onNewDocument={handleNewDocument}
          onOpenDocument={openDocument}
          onOpenSettings={() => setShowSettings(true)}
          onOpenReferences={openReferencesView}
          onOpenNote={openSourceByIdAtPage}
        />
        <CenterPane
          initialized={initialized}
          tabs={tabs}
          activeTabId={activeTabId}
          docRevisions={docRevisions}
          sources={sources?.items ?? []}
          onActivate={setActiveTabId}
          onClose={closeTab}
          onOpen={openSource}
          onNewDocument={handleNewDocument}
          onCitationClick={handleCitationClick}
        />
        <ChatPanel
          ref={chatPanelRef}
          health={health}
          configured={configured}
          apiKey={apiKey}
          sources={sources?.items ?? []}
          activeDocumentId={activeDocumentId}
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
          providers={providers}
          keys={keys}
          onProvidersChange={handleProvidersChange}
          onSettingsChange={handleSettingsChange}
          onKeyChange={handleKeyChange}
          onClose={() => setShowSettings(false)}
        />
      )}
      {citationPopup && (
        <CitationPopup
          citekey={citationPopup.citekey}
          page={citationPopup.page}
          rect={citationPopup.rect}
          sources={sources?.items ?? []}
          onLinkOpen={openSourceByIdAtPage}
          onClose={() => setCitationPopup(null)}
        />
      )}
    </div>
  );
}
