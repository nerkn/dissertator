import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Gear,
  FolderOpen,
  Books,
  PencilSimpleLine,
  ChatCircleDots,
} from "@phosphor-icons/react";
import { api, SIDECAR_BASE } from "./lib/api";
import { ipc } from "./ipc";
import type { ProjectStatus, Settings, SourcesResponse } from "@dissertator/shared";
import { PROVIDER_DEFAULTS } from "@dissertator/shared";
import { LibraryPanel } from "./components/LibraryPanel";
import { CenterPane } from "./components/CenterPane";
import { ChatPanel } from "./components/ChatPanel";
import { SettingsDialog } from "./components/SettingsDialog";

type Health = "checking" | "up" | "down";

export default function App() {
  const [health, setHealth] = useState<Health>("checking");
  const [project, setProject] = useState<ProjectStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [apiKey, setApiKey] = useState<string>("");
  const [sources, setSources] = useState<SourcesResponse | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await api.projectStatus();
      setProject(status);
      if (status.initialized) {
        try {
          setSettings(await api.getSettings());
        } catch {
          /* settings unavailable */
        }
      }
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  }, []);

  // Fetch the live source list + counts. No-op until a project is open.
  const refreshSources = useCallback(async () => {
    if (!project?.initialized) return;
    try {
      setSources(await api.getSources());
    } catch (e) {
      // Surface but don't block — the poll loop will retry health.
      setError((e as Error)?.message ?? String(e));
    }
  }, [project?.initialized]);

  // Poll the sidecar until it's up (it may start after the frontend in dev),
  // then load project status + any stored API key.
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      while (!stopped) {
        try {
          await api.health();
          if (stopped) break;
          setHealth("up");
          await refreshStatus();
          try {
            const k = await ipc.getSecret(PROVIDER_DEFAULTS.openai.keyUser);
            if (!stopped) setApiKey(k ?? "");
          } catch {
            /* keychain unavailable (e.g. no daemon on linux) */
          }
          return;
        } catch {
          if (!stopped) setHealth("down");
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    };
    poll();
    return () => {
      stopped = true;
    };
  }, [refreshStatus]);

  // Refresh the source list whenever status lands an initialized project,
  // (covers first init and project switches).
  useEffect(() => {
    if (project?.initialized) refreshSources();
  }, [project?.initialized, project?.projectPath, refreshSources]);

  // --- SSE: live updates as files ingest -----------------------------------
  // Open a single EventSource once the sidecar is up and a project is open.
  // Re-bursts of `ingest` events are debounced so a scan of N files doesn't
  // fire N back-to-back fetches.
  const esRef = useRef<EventSource | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const initialized = !!project?.initialized;
    if (health !== "up" || !initialized) return;

    // Guard against duplicate connections (React 18 StrictMode double-invokes
    // effects in dev).
    if (esRef.current) return;

    const es = new EventSource(`${SIDECAR_BASE}/events`);
    esRef.current = es;

    const scheduleRefresh = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        refreshSources();
      }, 300);
    };

    es.addEventListener("ingest", scheduleRefresh);
    // EventSource auto-reconnects on drop; we just log errors quietly.
    es.onerror = () => {
      /* browser will reconnect; nothing to surface here */
    };

    return () => {
      es.close();
      esRef.current = null;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [health, project?.initialized, project?.projectPath, refreshSources]);

  const onOpenFolder = async () => {
    setError(null);
    try {
      const dir = await open({ directory: true, multiple: false });
      if (!dir || Array.isArray(dir)) return;
      setBusy(true);
      await api.initProject(dir as string);
      await refreshStatus();
      await refreshSources();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleRescan = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.rescan();
      await refreshSources();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSaveSettings = async (s: Settings, key: string) => {
    await api.saveSettings(s);
    setSettings(s);
    const keyUser = PROVIDER_DEFAULTS[s.provider].keyUser;
    if (key) await ipc.setSecret(keyUser, key);
    else await ipc.deleteSecret(keyUser);
    setApiKey(key);
    setShowSettings(false);
  };

  const initialized = !!project?.initialized;
  const configured = !!settings && !!apiKey;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">📚 Dissertator</div>
        <div className="project-name" title={project?.projectPath ?? ""}>
          {initialized ? project!.projectPath : "no project open"}
        </div>
        <div className="spacer" />
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
      </header>

      <main className="body">
        <LibraryPanel
          project={project}
          sources={sources}
          onRescan={handleRescan}
          onAttentionResolved={refreshSources}
          busy={busy}
          provider={settings?.provider}
          ocrStrategy={settings?.ocrStrategy}
          apiKey={apiKey}
        />
        <CenterPane initialized={initialized} />
        <ChatPanel health={health} configured={configured} />
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
          apiKey={apiKey}
          onClose={() => setShowSettings(false)}
          onSave={onSaveSettings}
        />
      )}
    </div>
  );
}
