import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Gear,
  FolderOpen,
  Books,
  PencilSimpleLine,
  ChatCircleDots,
} from "@phosphor-icons/react";
import { api, resolveSidecarBase, resetSidecarBase, sidecarBase } from "./lib/api";
import { ipc } from "./ipc";
import type {
  Document,
  ProjectStatus,
  ProviderConfig,
  Reference,
  Settings,
  SourceFile,
  SourcesResponse,
} from "@dissertator/shared";
import { LibraryPanel } from "./components/LibraryPanel";
import { CenterPane } from "./components/CenterPane";
import { ChatPanel } from "./components/ChatPanel";
import type { ChatPanelHandle } from "./components/ChatPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { CitationPopup } from "./components/CitationPopup";
import { WindowControls } from "./components/WindowControls";
import type { Tab } from "./lib/tabs";
import { kindForSource, REFERENCES_TAB_ID } from "./lib/tabs";
import type { CitationClickHandler } from "./lib/citationPlugin";

type Health = "checking" | "up" | "down";

export default function App() {
  const [health, setHealth] = useState<Health>("checking");
  const [project, setProject] = useState<ProjectStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [sources, setSources] = useState<SourcesResponse | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Open-document tab model (P3 Workstream 2) ---------------------------
  // One tab per source id; opening an already-open source just activates its
  // existing tab. Closing the active tab falls through to the last remaining
  // one (or null) so the pane never shows a stale viewer.
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // Manuscript documents (the writable output). Fetched alongside sources so
  // the Library can list them and the editor can be opened from there.
  const [documents, setDocuments] = useState<Document[]>([]);
  // P5: per-document revision counters. Bumped whenever the agent edits a
  // document so its editor live-reloads the new body. Keyed by document id.
  const [docRevisions, setDocRevisions] = useState<Record<string, number>>({});
  // P6: named provider rows (chat + embedding). The Functions tab assigns
  // one chat-kind row to `chat` and one embedding-kind row to `vectorizer`.
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  // P6: in-memory API-key store, keyed by a provider's `keyUser` slot. Loaded
  // from the OS keychain on startup / when providers change; the Settings
  // dialog writes here as the user edits key fields. apiKey / embeddingApiKey
  // below are DERIVED from this + the selected provider ids.
  const [keys, setKeys] = useState<Record<string, string>>({});
  // Citation card state: set when a manuscript chip is clicked but the
  // reference has no linked source file (fileless / unknown). Null otherwise.
  const [citationPopup, setCitationPopup] = useState<{
    citekey: string;
    page: number | null;
    rect: DOMRect;
  } | null>(null);

  const openSource = useCallback((src: SourceFile) => {
    setTabs((prev) => {
      if (prev.some((t) => t.sourceId === src.id)) return prev;
      return [
        ...prev,
        {
          sourceId: src.id,
          kind: kindForSource(src.kind),
          title: src.filename,
        },
      ];
    });
    setActiveTabId(src.id);
  }, []);

  // Open (or focus) a source tab AND jump its viewer to a page. Used by
  // citation clicks `[@citekey:page]`: if the tab already exists, its
  // `initialPage` is bumped so the PdfViewer's nav effect fires; otherwise a
  // new tab is created seeded with the page. A missing page leaves any
  // existing initialPage untouched.
  const openSourceAtPage = useCallback((src: SourceFile, page?: number) => {
    setTabs((prev) => {
      const existing = prev.find((t) => t.sourceId === src.id);
      if (existing) {
        return prev.map((t) =>
          t.sourceId === src.id
            ? { ...t, initialPage: page ?? t.initialPage }
            : t,
        );
      }
      return [
        ...prev,
        {
          sourceId: src.id,
          kind: kindForSource(src.kind),
          title: src.filename,
          initialPage: page,
        } as Tab,
      ];
    });
    setActiveTabId(src.id);
  }, []);

  // Open a manuscript document in a new editor tab (one tab per document id).
  const openDocument = useCallback((doc: Document) => {
    setTabs((prev) => {
      if (prev.some((t) => t.sourceId === doc.id)) return prev;
      return [
        ...prev,
        { sourceId: doc.id, kind: "doc" as const, title: doc.title },
      ];
    });
    setActiveTabId(doc.id);
  }, []);

  // Open the bibliography manager as a singleton center-pane tab. Idempotent:
  // clicking the References card again just re-activates the existing tab.
  const openReferencesView = useCallback(() => {
    setTabs((prev) =>
      prev.some((t) => t.sourceId === REFERENCES_TAB_ID)
        ? prev
        : [
            ...prev,
            {
              sourceId: REFERENCES_TAB_ID,
              kind: "references" as const,
              title: "References",
            },
          ],
    );
    setActiveTabId(REFERENCES_TAB_ID);
  }, []);

  const closeTab = useCallback(
    (sourceId: string) => {
      setTabs((prev) => prev.filter((t) => t.sourceId !== sourceId));
      // Closing the active tab → activate the last remaining one (or null).
      // `tabs` here is the render-time value, which matches the `prev` the
      // setTabs updater starts from, so `remaining` is consistent with the
      // filter applied above.
      setActiveTabId((cur) => {
        if (cur !== sourceId) return cur;
        const remaining = tabs.filter((t) => t.sourceId !== sourceId);
        return remaining.length > 0
          ? remaining[remaining.length - 1].sourceId
          : null;
      });
    },
    [tabs],
  );

  // --- Working-docs persistence (P6) --------------------------------------
  // Restore the user's open tabs + active tab when a project opens, then
  // persist any change (debounced) so reopening lands on the same working
  // set. Tabs whose source/document no longer exists are dropped.
  const uiTabsRestored = useRef(false);
  useEffect(() => {
    if (!project?.initialized || uiTabsRestored.current) return;
    uiTabsRestored.current = true;
    let stopped = false;
    (async () => {
      try {
        // Validate against a FRESH fetch so we don't race the reactive
        // sources/documents loads (which may land in either order).
        const [saved, srcs, docs] = await Promise.all([
          api.getUiTabs(),
          api.getSources(),
          api.listDocuments(),
        ]);
        if (stopped) return;
        const validIds = new Set<string>([
          ...srcs.items.map((s) => s.id),
          ...docs.map((d) => d.id),
        ]);
        const restored = saved.tabs.filter((t) =>
          validIds.has(t.sourceId),
        ) as Tab[];
        if (restored.length > 0) {
          setTabs(restored);
          const activeValid =
            saved.activeTabId &&
            restored.some((t) => t.sourceId === saved.activeTabId)
              ? saved.activeTabId
              : restored[restored.length - 1].sourceId;
          setActiveTabId(activeValid);
        }
      } catch {
        /* sidecar mid-restart; allow a retry on next render */
        uiTabsRestored.current = false;
      }
    })();
    return () => {
      stopped = true;
    };
  }, [project?.initialized, project?.projectPath]);

  // Debounced save of the working set. Skips until after the initial restore
  // so we never overwrite saved tabs with the empty pre-restore state.
  useEffect(() => {
    if (!project?.initialized) return;
    if (!uiTabsRestored.current) return;
    const id = setTimeout(() => {
      void api
        .saveUiTabs(
          tabs.map((t) => ({
            sourceId: t.sourceId,
            kind: t.kind,
            title: t.title,
          })),
          activeTabId,
        )
        .catch(() => {
          /* sidecar mid-restart */
        });
    }, 500);
    return () => clearTimeout(id);
  }, [project?.initialized, tabs, activeTabId]);

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
  //
  // LAST-OPENED PROJECT: the sidecar's `current` project is in-memory and
  // resets on every restart, so a fresh launch always reports
  // `initialized:false` even for a project the user opened yesterday. We
  // remember the last opened path in localStorage and re-init it once the
  // sidecar is up (see the auto-init effect below), so the app reopens to
  // the user's project automatically. The guard in `initProject` (db.ts)
  // rejects a stored data-dir path, so a bad stored value self-heals: the
  // re-init throws, we clear the entry, and the user is prompted to pick.
  const autoInitTried = useRef(false);
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      while (!stopped) {
        try {
          // Discover the sidecar's actual port (it may have shifted if the
          // preferred port was busy) before probing /health.
          await resolveSidecarBase();
          await api.health();
          if (stopped) break;
          setHealth("up");
          await refreshStatus();
          return;
        } catch {
          if (!stopped) setHealth("down");
          // Sidecar may have moved ports (restart / crash); drop the cached
          // base so the next loop re-scans and rediscovers it.
          resetSidecarBase();
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

  // LAST-OPENED PROJECT — auto-reopen once the sidecar is up and we know no
  // project is active yet. Runs at most once per app launch (`autoInitTried`)
  // so it doesn't fight the user if they manually open a different folder.
  // On failure (path gone, or it's a data dir — now rejected by initProject)
  // we clear the stored entry so the next launch starts clean instead of
  // looping on a bad path.
  const LAST_PROJECT_KEY = "dissertator.lastProjectPath";
  useEffect(() => {
    if (autoInitTried.current) return;
    if (health !== "up") return;
    if (project?.initialized) {
      autoInitTried.current = true;
      return;
    }
    autoInitTried.current = true;
    const path = localStorage.getItem(LAST_PROJECT_KEY);
    if (!path) return;
    (async () => {
      try {
        await api.initProject(path);
        await refreshStatus();
      } catch (e) {
        // Stored path is bad (deleted, or a data dir). Drop it so we don't
        // retry forever; surface the message via the normal error banner.
        localStorage.removeItem(LAST_PROJECT_KEY);
        setError((e as Error)?.message ?? String(e));
      }
    })();
  }, [health, project?.initialized, refreshStatus]);

  // Refresh the document list (same triggers as sources).
  const refreshDocuments = useCallback(async () => {
    if (!project?.initialized) return;
    try {
      setDocuments(await api.listDocuments());
    } catch {
      /* sidecar mid-restart; UI degrades to an empty list */
    }
  }, [project?.initialized]);
  useEffect(() => {
    if (project?.initialized) refreshDocuments();
  }, [project?.initialized, project?.projectPath, refreshDocuments]);

  // P6: load provider rows + their API keys whenever a project is open. Keys
  // are read from the OS keychain by each provider's `keyUser` slot (legacy
  // slots for seeded defaults, per-id slots for user-added rows). A missing
  // keychain (e.g. no daemon on linux) degrades to empty strings — the
  // in-memory map is the source of truth for the running session.
  const refreshProviders = useCallback(async () => {
    if (!project?.initialized) return;
    try {
      setProviders(await api.listProviders());
    } catch {
      /* sidecar mid-restart */
    }
  }, [project?.initialized]);
  useEffect(() => {
    if (project?.initialized) refreshProviders();
  }, [project?.initialized, project?.projectPath, refreshProviders]);

  useEffect(() => {
    if (providers.length === 0) return;
    let stopped = false;
    (async () => {
      const fetched: Record<string, string> = {};
      await Promise.all(
        providers.map(async (p) => {
          try {
            const k = await ipc.getSecret(p.keyUser);
            fetched[p.keyUser] = k ?? "";
          } catch {
            fetched[p.keyUser] = "";
          }
        }),
      );
      if (stopped) return;
      // Merge, don't replace: the in-memory map is the source of truth for
      // the running session. The OS keychain may be unavailable (no unlocked
      // gnome-keyring/kwallet on Linux, or running under dev:web with no
      // Tauri runtime), in which case the optimistic value the user just
      // typed is the ONLY copy — a blind re-read would wipe it and the chat
      // panel would flip back to "no provider". Keep any non-empty in-memory
      // value; fill in the rest from the keychain.
      setKeys((prev) => {
        const merged = { ...fetched };
        for (const [k, v] of Object.entries(prev)) {
          if (v) merged[k] = v;
        }
        return merged;
      });
    })();
    return () => {
      stopped = true;
    };
  }, [providers]);

  // Derived: the chat + embedding keys for the currently-selected function
  // providers. These feed the ChatPanel / LibraryPanel / agent loop unchanged.
  const apiKey = useMemo(() => {
    const cp = providers.find((p) => p.id === settings?.chatProviderId);
    return cp ? keys[cp.keyUser] ?? "" : "";
  }, [providers, settings?.chatProviderId, keys]);
  const embeddingApiKey = useMemo(() => {
    const ep = providers.find((p) => p.id === settings?.embeddingProviderId);
    return ep ? keys[ep.keyUser] ?? "" : "";
  }, [providers, settings?.embeddingProviderId, keys]);

  // --- SSE: live updates as files ingest -----------------------------------
  // Open a single EventSource once the sidecar is up and a project is open.
  // Re-bursts of `ingest` events are debounced so a scan of N files doesn't
  // fire N back-to-back fetches.
  const esRef = useRef<EventSource | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatPanelRef = useRef<ChatPanelHandle>(null);

  useEffect(() => {
    const initialized = !!project?.initialized;
    if (health !== "up" || !initialized) return;

    // Guard against duplicate connections (React 18 StrictMode double-invokes
    // effects in dev).
    if (esRef.current) return;

    const es = new EventSource(`${sidecarBase()}/events`);
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
      // Remember the last opened project so the next launch reopens it.
      localStorage.setItem("dissertator.lastProjectPath", dir as string);
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

  // Create a blank manuscript and open it. Title via prompt with a sensible
  // default; empty/cancel aborts. Replaces the P4 wizard for now.
  const handleNewDocument = async () => {
    setError(null);
    const title = window.prompt("Document title", "Untitled document");
    if (title == null) return; // cancelled
    const trimmed = title.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const doc = await api.createDocument({ title: trimmed });
      await refreshDocuments();
      openDocument(doc);
      // Kick off a fresh chat seeded with the New Document planning prompt
      // so the user can talk through structure with the agent.
      void chatPanelRef.current?.startNewDocumentChat();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  // P6: Settings dialog callbacks. The dialog persists provider rows +
  // function selections + prompts itself via the api; these keep App's
  // derived state in sync so apiKey/embeddingApiKey recompute and the
  // Library / Chat panels see the new selections immediately.
  const handleProvidersChange = useCallback(async () => {
    try {
      setProviders(await api.listProviders());
    } catch {
      /* sidecar mid-restart */
    }
  }, []);

  const handleSettingsChange = useCallback(async () => {
    try {
      setSettings(await api.getSettings());
    } catch {
      /* sidecar mid-restart */
    }
  }, []);

  // A key field changed in the dialog. Persist to the keychain (best-effort;
  // a missing daemon must not break the session) and update the in-memory
  // keys map so apiKey/embeddingApiKey recompute live.
  const handleKeyChange = useCallback(
    async (keyUser: string, value: string) => {
      setKeys((prev) => ({ ...prev, [keyUser]: value }));
      try {
        if (value) await ipc.setSecret(keyUser, value);
        else await ipc.deleteSecret(keyUser);
      } catch (e) {
        console.warn("[settings] key not persisted:", e);
      }
    },
    [],
  );

  // P5 callbacks: the agent edited a document, or asked the UI to open a
  // viewer/editor. Document edits bump the per-doc revision so its editor
  // live-reloads; the Library list refreshes for title changes.
  const handleDocumentEdited = useCallback(
    (doc: Document) => {
      setDocuments((prev) =>
        prev.some((d) => d.id === doc.id)
          ? prev.map((d) => (d.id === doc.id ? { ...d, ...doc } : d))
          : [...prev, doc],
      );
      setDocRevisions((prev) => ({
        ...prev,
        [doc.id]: (prev[doc.id] ?? 0) + 1,
      }));
    },
    [],
  );

  const handleOpenSourceById = useCallback(
    (sourceId: string) => {
      const src = sources?.items.find((s) => s.id === sourceId);
      if (src) openSource(src);
    },
    [sources, openSource],
  );

  // Citation chip click (`[@citekey:page]` in the manuscript). Resolves the
  // citekey → reference; if it links to a source file, open that PDF at the
  // page; otherwise pop up the reference card (fileless / unknown citation).
  const handleCitationClick = useCallback<CitationClickHandler>(
    async (citekey, page, rect) => {
      let ref: Reference | null = null;
      try {
        ref = await api.getReference(citekey);
      } catch {
        ref = null;
      }
      const srcId = ref?.source_file_id;
      if (srcId) {
        const src = sources?.items.find((s) => s.id === srcId);
        if (src) {
          openSourceAtPage(src, page ?? undefined);
          return;
        }
      }
      setCitationPopup({ citekey, page, rect });
    },
    [sources, openSourceAtPage],
  );

  // Open a source by id at a page (used after linking a reference from the
  // citation card). Falls back to no-page if the id isn't in the loaded list.
  const openSourceByIdAtPage = useCallback(
    (sourceId: string, page: number | null) => {
      const src = sources?.items.find((s) => s.id === sourceId);
      if (src) openSourceAtPage(src, page ?? undefined);
    },
    [sources, openSourceAtPage],
  );

  const handleOpenDocumentById = useCallback(
    (documentId: string) => {
      const doc = documents.find((d) => d.id === documentId);
      if (doc) {
        openDocument(doc);
        return;
      }
      // Not in the loaded list yet (e.g. the agent just created it) — fetch.
      void api
        .getDocument(documentId)
        .then((d) => {
          setDocuments((prev) =>
            prev.some((x) => x.id === d.id) ? prev : [...prev, d],
          );
          openDocument(d);
        })
        .catch(() => {
          /* ignore — the doc may not exist */
        });
    },
    [documents, openDocument],
  );

  // The document the user is currently editing (active doc tab), if any. Sent
  // each chat turn as the default target for the agent's p_* tools.
  const activeDocumentId = useMemo(() => {
    if (!activeTabId) return undefined;
    const tab = tabs.find((t) => t.sourceId === activeTabId);
    return tab && tab.kind === "doc" ? tab.sourceId : undefined;
  }, [activeTabId, tabs]);

  const initialized = !!project?.initialized;
  const configured = !!settings && !!apiKey;

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

      <main className="body">
        <LibraryPanel
          project={project}
          sources={sources}
          documents={documents}
          onRescan={handleRescan}
          onAttentionResolved={refreshSources}
          busy={busy}
          provider={settings?.provider}
          ocrStrategy={settings?.ocrStrategy}
          apiKey={apiKey}
          embeddingApiKey={embeddingApiKey}
          onOpen={openSource}
          onNewDocument={handleNewDocument}
          onOpenDocument={openDocument}
          onOpenSettings={() => setShowSettings(true)}
          onOpenReferences={openReferencesView}
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
