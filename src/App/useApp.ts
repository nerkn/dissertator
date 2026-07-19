import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, resolveSidecarBase, resetSidecarBase, sidecarBase } from "../lib/api";
import { useProviderStore } from "../lib/stores/providers";
import { isKeylessProviderType } from "@dissertator/shared";
import type {
  AiFunction,
  Reference,
} from "@dissertator/shared";
import type { ChatPanelHandle } from "../components/ChatPanel";
import type { Tab } from "../lib/tabs";
import { useTabsStore } from "../lib/stores/tabs";
import { useContentStore } from "../lib/stores/content";
import { useSessionStore } from "../lib/stores/session";
import { promptDialog } from "../lib/stores/dialogs";
import type { CitationClickHandler } from "../lib/citationPlugin";

// All application state + handlers live here; App() is a thin JSX shell.
// Lifted verbatim from the original App() body — hook call order preserved.

export function useApp() {
  const health = useSessionStore((s) => s.health);
  const project = useSessionStore((s) => s.project);
  const setHealth = useSessionStore((s) => s.setHealth);
  const setProject = useSessionStore((s) => s.setProject);
  const setError = useSessionStore((s) => s.setError);
  const setBusy = useSessionStore((s) => s.setBusy);

  // --- Open-document tab model (P3 Workstream 2) ---------------------------
  // The tab model (one tab per source/doc id) lives in the tabs store (split
  // out of this hook). We subscribe to the data + actions here: the data is
  // needed for working-set persistence below, and the open/close actions are
  // returned to the shell + used by the composition handlers further down.
  // CenterPane reads tabs/activeTabId + the navigation actions from the store
  // directly; ChatPanel derives activeDocumentId via its own hook.
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const setTabs = useTabsStore((s) => s.setTabs);
  const setActiveTabId = useTabsStore((s) => s.setActiveTabId);
  const openSource = useTabsStore((s) => s.openSource);
  const openSourceAtPage = useTabsStore((s) => s.openSourceAtPage);
  const openDocument = useTabsStore((s) => s.openDocument);
  const openReferencesView = useTabsStore((s) => s.openReferencesView);
  // The open project's content (settings/sources/documents + per-doc
  // revision counters) lives in the content store (split out of this hook).
  // We subscribe to the data + raw setters here; refreshSources /
  // refreshDocuments stay in this orchestrator (they need the project guard
  // + setError), and handleDocumentEdited / handleSettingsChange are store
  // actions. The panels read sources/documents/docRevisions from the store
  // directly; settings stays returned for the Settings dialog + provider chips.
  const settings = useContentStore((s) => s.settings);
  const sources = useContentStore((s) => s.sources);
  const documents = useContentStore((s) => s.documents);
  const setSettings = useContentStore((s) => s.setSettings);
  const setSources = useContentStore((s) => s.setSources);
  const setDocuments = useContentStore((s) => s.setDocuments);
  const setReferences = useContentStore((s) => s.setReferences);
  const handleDocumentEdited = useContentStore((s) => s.handleDocumentEdited);
  const handleSettingsChange = useContentStore((s) => s.handleSettingsChange);
  // P6: provider rows + their API keys live in the provider store (split out
  // of this hook). We subscribe to the data here so the derived per-function
  // keys below recompute; the Settings dialog reads the store directly, and
  // the lifecycle effects (refresh on project open, key load) call the
  // store actions further down.
  const providers = useProviderStore((s) => s.providers);
  const keys = useProviderStore((s) => s.keys);
  const refreshProviders = useProviderStore((s) => s.refreshProviders);
  const loadKeys = useProviderStore((s) => s.loadKeys);
  // Citation card state: set when a manuscript chip is clicked but the
  // reference has no linked source file (fileless / unknown). Null otherwise.
  const [citationPopup, setCitationPopup] = useState<{
    citekey: string;
    page: number | null;
    rect: DOMRect;
  } | null>(null);


  // --- Working-docs persistence (P6) --------------------------------------
  // Restore the user's open tabs + active tab when a project opens, then
  // persist any change (debounced) so reopening lands on the same working
  // set. Tabs whose source/document no longer exists are dropped.
  //
  // On a project SWITCH: reset the restore guard and clear any tabs left
  // from the previous project, then load the new project's saved working
  // set. Without this, `uiTabsRestored` stays `true` (set on the first
  // restore) so the new project never reloads, and old ManuscriptEditor
  // instances stay mounted in the center pane.
  const uiTabsRestored = useRef(false);
  const lastProjectPath = useRef<string | null>(null);
  useEffect(() => {
    if (!project?.initialized) return;
    if (lastProjectPath.current !== project?.projectPath) {
      lastProjectPath.current = project?.projectPath ?? null;
      uiTabsRestored.current = false;
      setTabs([]);
      setActiveTabId(null);
    }
    if (uiTabsRestored.current) return;
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
        // Always setTabs — even when empty — so a project with no saved
        // working set clears the previous project's tabs instead of
        // leaving them mounted.
        setTabs(restored);
        const activeValid =
          restored.length > 0 &&
          saved.activeTabId &&
          restored.some((t) => t.sourceId === saved.activeTabId)
            ? saved.activeTabId
            : restored.length > 0
              ? restored[restored.length - 1].sourceId
              : null;
        setActiveTabId(activeValid);
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
  }, [project?.initialized, setSources]);

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

  // LAST-OPENED PROJECT — auto-reopen once the sidecar is up, providers are
  // loaded, AND a chat key exists. Without a chat key the onboarding dialog
  // is showing — defer the reopen until the user provides a key, so the
  // first thing they see is the key prompt, not a half-loaded project.
  // Runs at most once per app launch (`autoInitTried`) so it doesn't fight
  // the user if they manually open a different folder.
  // On failure (path gone, or it's a data dir — now rejected by initProject)
  // we clear the stored entry so the next launch starts clean instead of
  // looping on a bad path.
  const LAST_PROJECT_KEY = "dissertator.lastProjectPath";
  const providersLoaded = useProviderStore((s) => s.loaded);
  const hasChatKey = providers.some(
    (p) => !isKeylessProviderType(p.type) && !!keys[p.keyUser],
  );
  useEffect(() => {
    if (autoInitTried.current) return;
    if (health !== "up") return;
    if (!providersLoaded) return;
    if (!hasChatKey) return;
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
  }, [health, providersLoaded, hasChatKey, project?.initialized, refreshStatus]);

  // Refresh the document list (same triggers as sources).
  const refreshDocuments = useCallback(async () => {
    if (!project?.initialized) return;
    try {
      setDocuments(await api.listDocuments());
    } catch {
      /* sidecar mid-restart; UI degrades to an empty list */
    }
  }, [project?.initialized, setDocuments]);
  useEffect(() => {
    if (project?.initialized) refreshDocuments();
  }, [project?.initialized, project?.projectPath, refreshDocuments]);

  // Refresh the reference list (same triggers as sources/documents). The
  // map is keyed by source_file_id and powers tab-title resolution in the
  // CenterPane (PDF tab shows the paper title, not the filename).
  const refreshReferences = useCallback(async () => {
    if (!project?.initialized) return;
    try {
      setReferences(await api.listReferences());
    } catch {
      /* sidecar mid-restart */
    }
  }, [project?.initialized, setReferences]);
  useEffect(() => {
    if (project?.initialized) refreshReferences();
  }, [project?.initialized, project?.projectPath, refreshReferences]);

  // P6: provider rows + keys are GLOBAL (sidecar app DB), so load them as
  // soon as the sidecar is up — not gated on a project. This lets the
  // startup onboarding check for a chat key before any folder is opened.
  useEffect(() => {
    if (health === "up") void refreshProviders();
  }, [health, refreshProviders]);

  useEffect(() => {
    if (providers.length === 0) return;
    void loadKeys();
  }, [providers, loadKeys]);

  // Derived: per-function API keys. Each function's binding points at a
  // provider whose `keyUser` slot holds its key. `apiKey`/`embeddingApiKey`
  // are kept as chat/embed aliases for the existing ChatPanel / LibraryPanel
  // consumers; the vision/stt keys route the correct key to OCR + transcribe.
  const keyFor = useCallback(
    (fn: AiFunction): string => {
      const pid = settings?.bindings?.[fn]?.providerId;
      if (!pid) return "";
      const p = providers.find((x) => x.id === pid);
      return p ? keys[p.keyUser] ?? "" : "";
    },
    [settings?.bindings, providers, keys],
  );
  const apiKey = useMemo(() => keyFor("chat"), [keyFor]);
  const embeddingApiKey = useMemo(() => keyFor("embed"), [keyFor]);
  const visionDocKey = useMemo(() => keyFor("vision_doc"), [keyFor]);
  const visionImageKey = useMemo(() => keyFor("vision_image"), [keyFor]);
  const sttKey = useMemo(() => keyFor("stt"), [keyFor]);

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

  // Create a blank manuscript and open it. Title via the in-app prompt with
  // a sensible default; empty/cancel aborts. Replaces the P4 wizard for now.
  const handleNewDocument = async () => {
    setError(null);
    const title = await promptDialog({
      title: "New document",
      label: "Document title",
      defaultValue: "Untitled document",
      okLabel: "Create",
    });
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

  // Composition handlers below read sources/documents (content store) and
  // the tab actions (tabs store) to open viewers/editors.

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
          setDocuments(
            documents.some((x) => x.id === d.id)
              ? documents
              : [...documents, d],
          );
          openDocument(d);
        })
        .catch(() => {
          /* ignore — the doc may not exist */
        });
    },
    [documents, openDocument],
  );

  const configured = !!settings && !!apiKey;

  return {
    // state
    settings,
    citationPopup,
    // refs
    chatPanelRef,
    // derived
    configured,
    apiKey,
    embeddingApiKey,
    visionDocKey,
    visionImageKey,
    sttKey,
    // setters used directly by the shell
    setCitationPopup,
    // handlers
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
  };
}
