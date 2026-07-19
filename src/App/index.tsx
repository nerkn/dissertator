import {
  Gear,
  FolderOpen,
  Books,
  PencilSimpleLine,
  ChatCircleDots,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { isKeylessProviderType } from "@dissertator/shared";
import { LibraryPanel } from "../components/LibraryPanel";
import { CenterPane } from "../components/CenterPane";
import { ChatPanel } from "../components/ChatPanel";
import { SettingsDialog } from "../components/SettingsDialog";
import { CitationPopup } from "../components/CitationPopup";
import { WindowControls } from "../components/WindowControls";
import { ResizeHandle } from "../components/ResizeHandle";
import { PanelDivider } from "../components/PanelDivider";
import { useLayoutStore } from "../lib/stores/layout";
import { SystemDialog } from "../components/SystemDialog";
import { OnboardingDialog } from "../components/OnboardingDialog";
import { useApp } from "./useApp";
import { useExternalLinks } from "../lib/useExternalLinks";
import { useSessionStore } from "../lib/stores/session";
import { useProviderStore } from "../lib/stores/providers";

export default function App() {
  useExternalLinks();
  const health = useSessionStore((s) => s.health);
  const project = useSessionStore((s) => s.project);
  const showSettings = useSessionStore((s) => s.showSettings);
  const busy = useSessionStore((s) => s.busy);
  const error = useSessionStore((s) => s.error);
  const setShowSettings = useSessionStore((s) => s.setShowSettings);
  const setError = useSessionStore((s) => s.setError);
  const initialized = !!project?.initialized;

  const providers = useProviderStore((s) => s.providers);
  const keys = useProviderStore((s) => s.keys);
  const providersLoaded = useProviderStore((s) => s.loaded);
  const libraryWidth = useLayoutStore((s) => s.libraryWidth);
  const chatWidth = useLayoutStore((s) => s.chatWidth);
  const adjustLibrary = useLayoutStore((s) => s.adjustLibrary);
  const adjustChat = useLayoutStore((s) => s.adjustChat);

  useEffect(() => {
    const onResize = () => adjustLibrary(0);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [adjustLibrary]);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const hasChatKey = providers.some(
    (p) => !isKeylessProviderType(p.type) && !!keys[p.keyUser],
  );
  const showOnboarding =
    health === "up" && providersLoaded && !hasChatKey && !onboardingDismissed;

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

      <main
        className="body"
        style={{
          gridTemplateColumns: `${libraryWidth}px 6px minmax(0, 1fr) 6px ${chatWidth}px`,
        }}
      >
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
        <PanelDivider
          onDelta={adjustLibrary}
          label="Resize library panel"
        />
        <CenterPane
          onNewDocument={handleNewDocument}
          onCitationClick={handleCitationClick}
        />
        <PanelDivider
          onDelta={adjustChat}
          label="Resize chat panel"
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

      {showOnboarding && (
        <OnboardingDialog onClose={() => setOnboardingDismissed(true)} />
      )}
    </div>
  );
}
