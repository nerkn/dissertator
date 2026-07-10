// ManuscriptEditor — the writable, Word-like editor for a Dissertation
// `Document` (a paper / thesis being authored). Built on Milkdown 7 (a
// markdown-first WYSIWYG on ProseMirror) so the user sees formatted text and
// never has to know markdown — yet the stored source of truth is the document's
// `body_md` column, which is what the agent contract and pandoc export consume.
//
// Data flow (DESIGN.md §3 + docs/tools.md §4):
//   GET /documents/:id  → Document (with bodyMd)   (load once per documentId)
//   edit the body in Milkdown
//   on every change → debounced (800ms) PUT /documents/:id { bodyMd }   (autosave)
//
// The editor is keyed by `documentId` in CenterPane, so switching documents
// remounts a fresh instance with the right initial markdown — no in-place
// content swapping, no save/replace guard needed.
//
// A Document is ONE body. Markdown headers (`## intro`) are just lines in
// the body, not separate rows — structural stats (line count, header
// positions) are computed by parsing the body, never stored.
//
// Citation tokens `[@citekey:printedPage]` (DESIGN.md §11 #8) are rendered as
// clickable "chips" by a ProseMirror decorations plugin (see
// `citationPlugin`) — the raw token stays editable text so the agent, autosave
// and pandoc export all see clean markdown. Clicking a chip resolves the
// citation (open the linked PDF at the page, or pop up the reference card).
//
// Source-MD toggle: a read-only peek at the underlying markdown for power
// users / debugging (the user-facing surface stays WYSIWYG by default).

import "../lib/milkdown-theme.css";
import "@milkdown/theme-nord/style.css";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Milkdown,
  MilkdownProvider,
  useEditor,
  useInstance,
} from "@milkdown/react";
import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history, undoCommand, redoCommand } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { nord } from "@milkdown/theme-nord";
import { callCommand } from "@milkdown/kit/utils";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  wrapInHeadingCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  wrapInBlockquoteCommand,
  toggleLinkCommand,
} from "@milkdown/kit/preset/commonmark";
import { replaceAll, getHTML, insert } from "@milkdown/kit/utils";
import {
  TextB,
  TextItalic,
  TextHOne,
  TextHTwo,
  TextHThree,
  ListBullets,
  ListNumbers,
  Quotes,
  LinkSimple,
  ArrowCounterClockwise,
  ArrowClockwise,
  Code,
  Eye,
  FileArrowDown,
  Paperclip,
} from "@phosphor-icons/react";
import type { Document } from "@dissertator/shared";
import { api } from "../lib/api";
import {
  importAssetFromPath,
  importAssetFromBlob,
} from "../lib/assetImport";
import {
  citationPlugin,
  type CitationClickHandler,
} from "../lib/citationPlugin";

interface Props {
  documentId: string;
  /** P5: bumps whenever the agent edits this document. The editor refetches
   *  on change and live-swaps the body via `replaceAll` when it has no unsaved
   *  local edits (otherwise it shows a stale banner the user can accept). */
  revision?: number;
  /** Citation-chip click handler. When omitted, chips still render (styled)
   *  but are inert. */
  onCitationClick?: CitationClickHandler;
}

/** Autosave lifecycle, shown as a small status pip in the toolbar. */
type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

const AUTOSAVE_DEBOUNCE_MS = 800;

export function ManuscriptEditor({ documentId, revision = 0, onCitationClick }: Props) {
  const [doc, setDoc] = useState<Document | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    setLoading(true);
    setError(null);
    setDoc(null);
    (async () => {
      try {
        const d = await api.getDocument(documentId);
        if (aborted) return;
        setDoc(d);
        setLoading(false);
      } catch (e) {
        if (aborted) return;
        setError((e as Error)?.message ?? String(e));
        setLoading(false);
      }
    })();
    return () => {
      aborted = true;
    };
  }, [documentId, revision]);

  if (loading) return <div className="editor-status">Loading document…</div>;
  if (error)
    return <div className="editor-error">Failed to load document: {error}</div>;
  if (!doc) return null;

  return (
    <MilkdownProvider>
      <EditorInner
        document={doc}
        initialMarkdown={doc.bodyMd ?? ""}
        onCitationClick={onCitationClick}
      />
    </MilkdownProvider>
  );
}

// ---------------------------------------------------------------------------
// EditorInner — owns the Milkdown instance, the toolbar, autosave, and the
// source-MD toggle. Kept separate so the MilkdownProvider wraps it (the hooks
// below must run inside a provider).
// ---------------------------------------------------------------------------

interface InnerProps {
  document: Document;
  initialMarkdown: string;
  onCitationClick?: CitationClickHandler;
}

function EditorInner({ document, initialMarkdown, onCitationClick }: InnerProps) {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [showSource, setShowSource] = useState<boolean>(false);
  // P5: the agent edited this doc while we had unsaved local changes. Show a
  // banner offering to reload (discard local) — we never auto-clobber edits.
  const [staleExternal, setStaleExternal] = useState<boolean>(false);
  // Live markdown mirror — drives the read-only source view without round-
  // tripping through the editor.
  const [sourceMd, setSourceMd] = useState<string>(initialMarkdown);
  // Word/character count from the markdown
  const [docStats, setDocStats] = useState<{ words: number; chars: number }>({ words: 0, chars: 0 });
  // Undo/redo state (whether they're available)
  const [canUndo, setCanUndo] = useState<boolean>(false);
  const [canRedo, setCanRedo] = useState<boolean>(false);

  // Latest markdown + pending timer, in refs so the Milkdown factory closure
  // (created once) always reads current values without re-creating the editor.
  const latestMd = useRef<string>(initialMarkdown);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialMdRef = useRef<string>(initialMarkdown);
  // The server's current body (from the latest fetch). Updated on every
  // successful autosave and every agent-edit reload; used to decide whether
  // a revision bump is a genuine external change vs. our own just-saved write.
  const serverMdRef = useRef<string>(initialMarkdown);
  // saveState in a ref so the revision effect (created once) reads current.
  const saveStateRef = useRef<SaveState>(saveState);
  saveStateRef.current = saveState;

  const doSave = useCallback(
    async (md: string) => {
      setSaveState("saving");
      try {
        await api.updateDocument(document.id, { bodyMd: md });
        setSaveState("saved");
      } catch {
        setSaveState("error");
      }
    },
    [document.id],
  );

  // Record the freshly-saved body so a revision bump comparing against it can
  // tell our own write apart from a true external (agent) edit.
  const doSaveWithTrack = useCallback(
    async (md: string) => {
      await doSave(md);
      serverMdRef.current = md;
    },
    [doSave],
  );

  // Called from the Milkdown `markdownUpdated` listener on every keystroke.
  const scheduleSave = useCallback(
    (md: string) => {
      latestMd.current = md;
      setSourceMd(md);
      // Update word/char count
      const words = md.trim() ? md.trim().split(/\s+/).length : 0;
      const chars = md.length;
      setDocStats({ words, chars });
      setSaveState("dirty");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        void doSaveWithTrack(latestMd.current);
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [doSaveWithTrack],
  );

  // keep scheduleSave reachable from the (once-created) factory via a ref
  const scheduleSaveRef = useRef(scheduleSave);
  scheduleSaveRef.current = scheduleSave;

  // Flush a pending save on unmount (e.g. switching tabs mid-debounce).
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        void doSaveWithTrack(latestMd.current);
      }
    };
  }, [doSaveWithTrack]);

  // Create the Milkdown editor once. Empty deps + ref-captured callbacks
  // mean the editor is never rebuilt on re-render (which would wipe undo
  // history and content). `useEditor` returns `{ get }`; `get()` yields the
  // Editor (after async init) for the toolbar to drive commands. NOTE: the
  // react binding calls `.create()` internally — the factory returns the
  // made/configured Editor, NOT a promise.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { get } = useEditor((rootEl) =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, rootEl);
        ctx.set(defaultValueCtx, initialMdRef.current);
      })
      .config((ctx) => {
        // Class the editable surface so our theme CSS can scope overrides; keep
        // spellcheck on for a writing tool.
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          attributes: { class: "milkdown-doc", spellcheck: "true" },
        }));
        // Autosave hook. Reads through the ref so the editor is never rebuilt
        // when the callback identity changes.
        ctx.get(listenerCtx).markdownUpdated((_c, md) => {
          scheduleSaveRef.current(md);
        });
      })
      .use(nord as MilkdownPlugin)
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
      .use(citationPlugin),
    [],
  );

  // Track undo/redo state from ProseMirror view
  useEffect(() => {
    const ed = get();
    if (!ed) return;
    const view = (ed as any).editorView;
    if (!view) return;
    
    // Initial check
    const updateUndoRedo = () => {
      const state = view.state;
      // ProseMirror history plugin stores undo/redo depth
      let undoDepth = 0;
      let redoDepth = 0;
      for (const plugin of state.plugins) {
        const pluginState = plugin.getState(state);
        if (pluginState && typeof pluginState === 'object' && 'undo' in pluginState) {
          undoDepth = (pluginState as any).undo.length;
          redoDepth = (pluginState as any).redo.length;
        }
      }
      setCanUndo(undoDepth > 0);
      setCanRedo(redoDepth > 0);
    };
    
    updateUndoRedo();
    
    // Listen to transactions to update state
    const handler = () => {
      updateUndoRedo();
    };
    view.on('transaction', handler);
    return () => {
      view.off('transaction', handler);
    };
  }, [get]);

  // --- Asset import (drag-drop / file-picker / screenshot-paste) ----------
  // A transient toast surfaced top-right of the editor for import feedback.
  const [notice, setNotice] = useState<{ msg: string; kind: "ok" | "err" } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashNotice = useCallback((msg: string, kind: "ok" | "err" = "ok") => {
    setNotice({ msg, kind });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }, []);

  // Insert a markdown fragment (image/link) at the current cursor.
  const insertAtCursor = useCallback(
    (md: string) => {
      get()?.action(insert(md));
    },
    [get],
  );

  // Insert-citation bridge: a note's "cite" action in the LibraryPanel
  // dispatches `dissertator:insert-citation` to drop a `[@citekey:page]`
  // token at the cursor. We claim the (cancelable) event with
  // `preventDefault()` so the sender knows it landed and skips its clipboard
  // fallback. We only mount while our tab is active (CenterPane keeps a single
  // viewer mounted), so when the user is reading a source PDF the event goes
  // unclaimed and the sender copies to the clipboard instead. Re-focus so the
  // caret stays in view.
  useEffect(() => {
    const onInsert = (e: Event) => {
      const detail = (e as CustomEvent<{ token?: string }>).detail;
      if (!detail?.token) return;
      const ed = get();
      if (!ed) return; // not ready yet — let the clipboard fallback run
      e.preventDefault();
      insertAtCursor(detail.token);
      (ed as any)?.editorView?.focus();
      flashNotice(`Inserted ${detail.token}`);
    };
    window.addEventListener("dissertator:insert-citation", onInsert);
    return () =>
      window.removeEventListener("dissertator:insert-citation", onInsert);
  }, [insertAtCursor, get, flashNotice]);

  // Import one real file (path from drag-drop or file picker) and insert the
  // right thing at the cursor: image → ![](images/…), audio → link + note,
  // document → just add to the library (watcher ingests it).
  const handleAssetPath = useCallback(
    async (absPath: string) => {
      const filename = absPath.split(/[/\\]/).pop() || "file";
      try {
        const { relPath, kind } = await importAssetFromPath(absPath, filename);
        const stem = filename.replace(/\.[^.]+$/, "");
        if (kind === "image") {
          insertAtCursor(`\n![${stem}](${relPath})\n`);
          flashNotice(`Inserted image: ${filename}`);
        } else if (kind === "audio") {
          insertAtCursor(`\n[${stem}](${relPath})\n`);
          flashNotice(`Audio saved: ${filename} (transcription coming soon)`);
        } else {
          flashNotice(`Added to library: ${filename}`);
        }
      } catch (e) {
        flashNotice(`✕ ${(e as Error)?.message ?? String(e)}`, "err");
      }
    },
    [insertAtCursor, flashNotice],
  );

  // Screenshot paste: image bytes have no filename — prompt with a sensible
  // default (image-<timestamp>.png), save to images/, insert the markdown.
  const handlePastedImage = useCallback(
    async (file: File) => {
      const fromType = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
      const ext = /^(png|jpe?g|webp|gif|bmp|svg)$/i.test(fromType) ? fromType : "png";
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const def = `image-${ts}.${ext}`;
      const name = window.prompt("Name this image:", def);
      if (!name) return;
      try {
        const { relPath } = await importAssetFromBlob(file, name);
        const stem = name.replace(/\.[^.]+$/, "");
        insertAtCursor(`\n![${stem}](${relPath})\n`);
        flashNotice(`Inserted image: ${name}`);
      } catch (e) {
        flashNotice(`✕ ${(e as Error)?.message ?? String(e)}`, "err");
      }
    },
    [insertAtCursor, flashNotice],
  );

  // Clipboard paste: only intercept actual image content; let plain-text
  // paste fall through to the editor.
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      let imgItem: DataTransferItem | null = null;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === "file" && it.type.startsWith("image/")) {
          imgItem = it;
          break;
        }
      }
      if (!imgItem) return; // plain text → default editor behavior
      e.preventDefault();
      e.stopPropagation(); // keep ProseMirror from also handling the image
      const file = imgItem.getAsFile();
      if (file) void handlePastedImage(file);
    },
    [handlePastedImage],
  );

  // Native Tauri drag-drop: the webview hands us real file paths. The HTML5
  // `drop` event does NOT expose paths in a webview, so this is the channel.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let un: (() => void) | undefined;
    let active = true;
    (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      if (!active) return;
      un = await getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === "drop" && e.payload.paths?.length) {
          for (const p of e.payload.paths) void handleAssetPath(p);
        }
      });
    })();
    return () => {
      active = false;
      un?.();
    };
  }, [handleAssetPath]);

  // File-picker (toolbar 📎 button) — desktop only.
  const pickFile = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const sel = await open({ multiple: true });
      if (!sel) return;
      const paths = Array.isArray(sel) ? sel : [sel];
      for (const p of paths) await handleAssetPath(p);
    } catch (e) {
      flashNotice(`✕ ${(e as Error)?.message ?? String(e)}`, "err");
    }
  }, [handleAssetPath, flashNotice]);

  // Initial stats calculation
  useEffect(() => {
    const words = initialMarkdown.trim() ? initialMarkdown.trim().split(/\s+/).length : 0;
    const chars = initialMarkdown.length;
    setDocStats({ words, chars });
  }, [initialMarkdown]);

  // P5 live reload: when the parent refetches on an agent edit, `initialMarkdown`
  // changes to the new server body. Swap it into the editor IN PLACE (no
  // remount → no undo-wipe, no autosave-flush race) — but only when the editor
  // is clean. If the user has unsaved local edits, show a stale banner instead
  // of clobbering them. Skip the very first run (initial mount already set it).
  const firstServerRun = useRef(true);
  const applyServerMarkdown = useCallback(
    (md: string, force: boolean) => {
      serverMdRef.current = md;
      latestMd.current = md;
      setSourceMd(md);
      get()?.action(replaceAll(md));
      if (force) setStaleExternal(false);
      setSaveState("idle");
    },
    [get],
  );
  // Ref mirror so the server-markdown effect depends ONLY on `initialMarkdown`
  // (the real signal the server body changed). Keeping `applyServerMarkdown`
  // as a dep would re-run the effect whenever the Milkdown `get` identity flips
  // (every re-render) — mid-typing that either wipes the editor back to the
  // pre-edit body via `replaceAll` or falsely flashes the "agent edited"
  // stale banner. Read through the ref instead.
  const applyServerMarkdownRef = useRef(applyServerMarkdown);
  applyServerMarkdownRef.current = applyServerMarkdown;

  useEffect(() => {
    if (firstServerRun.current) {
      firstServerRun.current = false;
      serverMdRef.current = initialMarkdown;
      return;
    }
    // No-op if the server body matches what we already show (e.g. our own
    // just-saved write echoed back, or a no-op edit).
    if (initialMarkdown === latestMd.current) {
      serverMdRef.current = initialMarkdown;
      return;
    }
    const dirty =
      saveStateRef.current === "dirty" || saveStateRef.current === "saving";
    if (dirty) {
      setStaleExternal(true);
      return;
    }
    applyServerMarkdownRef.current(initialMarkdown, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMarkdown]);

  return (
    <div className="manuscript-editor">
      {staleExternal && (
        <div className="editor-stale-banner">
          <span>
            The agent edited this document. You have unsaved changes that would
            be lost.
          </span>
          <button
            type="button"
            className="btn small primary"
            onClick={() => applyServerMarkdown(initialMarkdown, true)}
          >
            Reload agent version
          </button>
          <button
            type="button"
            className="btn small ghost"
            onClick={() => setStaleExternal(false)}
          >
            Keep mine
          </button>
        </div>
      )}
      <Toolbar
        getEditor={get}
        title={document.title}
        saveState={saveState}
        showSource={showSource}
        onToggleSource={() => setShowSource((v) => !v)}
        onInsertFile={pickFile}
        canUndo={canUndo}
        canRedo={canRedo}
      />
      <div className="editor-surface" onPasteCapture={handlePaste}>
        {showSource ? (
          <pre className="editor-source-view">{sourceMd || "(empty)"}</pre>
        ) : (
          <EditorPage onCitationClick={onCitationClick} />
        )}
      </div>
      <StatusBar saveState={saveState} docStats={docStats} />
      {notice && (
        <div className={`editor-toast ${notice.kind}`}>{notice.msg}</div>
      )}
    </div>
  );
}

/** The centered "page" + the Milkdown editable surface. Handles citation-
 *  chip clicks via event delegation: ProseMirror decorations tag chip text
 *  ranges with `data-citekey`/`data-page`, and this onClick walks up from the
 *  click target to the nearest chip and fires the handler with its rect. */
function EditorPage({ onCitationClick }: { onCitationClick?: CitationClickHandler }) {
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onCitationClick) return;
    const chip = (e.target as HTMLElement).closest<HTMLElement>(
      ".cite-chip[data-citekey]",
    );
    if (!chip) return;
    const citekey = chip.getAttribute("data-citekey") ?? "";
    const pageRaw = chip.getAttribute("data-page") ?? "";
    const n = parseInt(pageRaw, 10);
    onCitationClick(
      citekey,
      Number.isFinite(n) && n > 0 ? n : null,
      chip.getBoundingClientRect(),
    );
  };
  return (
    <div className="editor-page" onClick={handleClick}>
      <Milkdown />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar — Word-like formatting buttons. Each fires a Milkdown command via
// `editor.action(callCommand(key, payload?))`. Selection/active-state tracking
// (e.g. highlighting Bold when the cursor is in bold text) is deferred; v1
// buttons are stateless triggers.
// ---------------------------------------------------------------------------

interface ToolbarProps {
  getEditor: () => Editor | undefined;
  title: string;
  saveState: SaveState;
  showSource: boolean;
  onToggleSource: () => void;
  onInsertFile: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

type ExportFormat = "pdf" | "docx" | "doc";

function Toolbar({
  getEditor,
  title,
  saveState,
  showSource,
  onToggleSource,
  onInsertFile,
  canUndo,
  canRedo,
}: ToolbarProps) {
  // `useInstance` re-renders the toolbar once the editor is ready; buttons are
  // disabled until then so a fast click can't call .action() on undefined.
  const [loading] = useInstance();
  const inTauri = "__TAURI_INTERNALS__" in window;
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const exportMenuRef = useRef<HTMLDetailsElement | null>(null);

  // Run a Milkdown command. Spread into `callCommand` so the key + payload
  // are typed exactly as `callCommand` expects (no manual casts).
  const run = (...args: Parameters<typeof callCommand>) => {
    const ed = getEditor();
    if (!ed) return;
    ed.action(callCommand(...args));
  };

  const insertLink = () => {
    const url = window.prompt("Link URL");
    if (url) run(toggleLinkCommand.key, { href: url });
  };

  // Export the current document (as HTML via Milkdown) to PDF/DOCX/DOC. The
  // sidecar drives headless LibreOffice for the conversion. In the Tauri
  // webview we MUST use a Save dialog + write-to-path: a programmatic
  // <a download> of a blob URL is swallowed by the webview and never lands
  // anywhere. The browser fallback keeps the blob download.
  const exportDoc = async (format: ExportFormat) => {
    if (exportMenuRef.current) exportMenuRef.current.open = false;
    const ed = getEditor();
    const html = ed?.action(getHTML());
    if (!html) return;
    setExportErr(null);
    setSavedTo(null);
    setExporting(format);
    const safeTitle = (title || "manuscript").replace(/[^\w\- .()]/g, "_");
    const filename = `${safeTitle}.${format}`;
    try {
      const inTauri = "__TAURI_INTERNALS__" in window;
      if (inTauri) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const outPath = await save({
          defaultPath: filename,
          filters: [{ name: format.toUpperCase(), extensions: [format] }],
        });
        if (!outPath) return; // user cancelled the save dialog
        const res = await api.exportDocumentToPath(html, format, outPath, title);
        setSavedTo(res.path);
      } else {
        const blob = await api.exportDocument(html, format, title);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        setSavedTo("(browser download)");
      }
    } catch (e) {
      setExportErr((e as Error)?.message ?? String(e));
    } finally {
      setExporting(null);
    }
  };

  const Btn = ({
    label,
    onClick,
    children,
    disabled,
  }: {
    label: string;
    onClick: () => void;
    children: ReactNode;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      className="tb"
      title={label}
      aria-label={label}
      disabled={disabled || loading}
      onClick={onClick}
    >
      {children}
    </button>
  );

  const Sep = () => <span className="tb-sep" />;

  return (
    <div className="editor-toolbar">
      <div className="editor-toolbar-doc">{title}</div>
      <Sep />
      <Btn label="Bold (Ctrl+B)" onClick={() => run(toggleStrongCommand.key)}>
        <TextB size={16} weight="bold" />
      </Btn>
      <Btn label="Italic (Ctrl+I)" onClick={() => run(toggleEmphasisCommand.key)}>
        <TextItalic size={16} weight="bold" />
      </Btn>
      <Btn label="Inline code" onClick={() => run(toggleInlineCodeCommand.key)}>
        <Code size={16} weight="bold" />
      </Btn>
      <Sep />
      <Btn label="Heading 1" onClick={() => run(wrapInHeadingCommand.key, { level: 1 })}>
        <TextHOne size={16} weight="bold" />
      </Btn>
      <Btn label="Heading 2" onClick={() => run(wrapInHeadingCommand.key, { level: 2 })}>
        <TextHTwo size={16} weight="bold" />
      </Btn>
      <Btn label="Heading 3" onClick={() => run(wrapInHeadingCommand.key, { level: 3 })}>
        <TextHThree size={16} weight="bold" />
      </Btn>
      <Sep />
      <Btn label="Bulleted list" onClick={() => run(wrapInBulletListCommand.key)}>
        <ListBullets size={16} weight="bold" />
      </Btn>
      <Btn label="Numbered list" onClick={() => run(wrapInOrderedListCommand.key)}>
        <ListNumbers size={16} weight="bold" />
      </Btn>
      <Btn label="Quote" onClick={() => run(wrapInBlockquoteCommand.key)}>
        <Quotes size={16} weight="bold" />
      </Btn>
      <Btn label="Insert link" onClick={insertLink}>
        <LinkSimple size={16} weight="bold" />
      </Btn>
      {inTauri && (
        <Btn label="Insert file / image (drag-drop also works)" onClick={onInsertFile}>
          <Paperclip size={16} weight="bold" />
        </Btn>
      )}
      <Sep />
      <Btn label="Undo (Ctrl+Z)" onClick={() => run(undoCommand.key)} disabled={!canUndo}>
        <ArrowCounterClockwise size={16} weight="bold" />
      </Btn>
      <Btn label="Redo (Ctrl+Shift+Z)" onClick={() => run(redoCommand.key)} disabled={!canRedo}>
        <ArrowClockwise size={16} weight="bold" />
      </Btn>
      <div className="editor-toolbar-spacer" />
      <SavePip state={saveState} />
      <button
        type="button"
        className={`tb${showSource ? " active" : ""}`}
        title={showSource ? "Show formatted view" : "Show markdown source"}
        onClick={onToggleSource}
      >
        <Eye size={16} weight="bold" />
      </button>
      <details className="export-menu" ref={exportMenuRef}>
        <summary className="tb" title="Export document">
          <FileArrowDown size={16} weight="bold" />
          Export
        </summary>
        <div className="export-dropdown">
          <button type="button" disabled={exporting !== null} onClick={() => exportDoc("pdf")}>
            {exporting === "pdf" ? "Exporting…" : "PDF (.pdf)"}
          </button>
          <button type="button" disabled={exporting !== null} onClick={() => exportDoc("docx")}>
            {exporting === "docx" ? "Exporting…" : "Word (.docx)"}
          </button>
          <button type="button" disabled={exporting !== null} onClick={() => exportDoc("doc")}>
            {exporting === "doc" ? "Exporting…" : "Word 97-2003 (.doc)"}
          </button>
          {exportErr && <div className="export-err small">{exportErr}</div>}
          {savedTo && !exportErr && (
            <div className="export-ok small" title={savedTo}>
              Saved: {savedTo}
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

function SavePip({ state }: { state: SaveState }) {
  const map: Record<SaveState, { label: string; cls: string }> = {
    idle: { label: "", cls: "" },
    dirty: { label: "Unsaved", cls: "dirty" },
    saving: { label: "Saving…", cls: "saving" },
    saved: { label: "Saved", cls: "saved" },
    error: { label: "Save failed", cls: "error" },
  };
  const m = map[state];
  if (!m.label) return null;
  return <span className={`save-pip ${m.cls}`}>{m.label}</span>;
}

// ---------------------------------------------------------------------------
// StatusBar — Shows document stats and save state at the bottom of the editor
// ---------------------------------------------------------------------------

interface StatusBarProps {
  saveState: SaveState;
  docStats: { words: number; chars: number };
}

function StatusBar({ saveState, docStats }: StatusBarProps) {
  const map: Record<SaveState, { label: string; icon: string }> = {
    idle: { label: "All changes saved", icon: "✓" },
    dirty: { label: "Unsaved changes", icon: "●" },
    saving: { label: "Saving…", icon: "⟳" },
    saved: { label: "Saved", icon: "✓" },
    error: { label: "Save failed", icon: "✕" },
  };
  const m = map[saveState];
  const statusClass = saveState === "saved" ? "status-saved" : saveState === "error" ? "status-error" : saveState === "dirty" ? "status-dirty" : "status-neutral";

  return (
    <div className="editor-statusbar">
      <div className="statusbar-left">
        <span className={`status-indicator ${statusClass}`}>{m.icon}</span>
        <span className="status-text">{m.label}</span>
      </div>
      <div className="statusbar-right">
        <span className="stat-item">{docStats.words.toLocaleString()} words</span>
        <span className="stat-divider">|</span>
        <span className="stat-item">{docStats.chars.toLocaleString()} characters</span>
      </div>
    </div>
  );
}
