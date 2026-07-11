// ---------------------------------------------------------------------------
// EditorInner — owns the Milkdown instance, the toolbar, autosave, and the
// source-MD toggle. Kept separate so the MilkdownProvider wraps it (the hooks
// below must run inside a provider).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { Milkdown, useEditor } from "@milkdown/react";
import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { nord } from "@milkdown/theme-nord";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { replaceAll, insert } from "@milkdown/kit/utils";
import type { Document } from "@dissertator/shared";
import { api } from "../../lib/api";
import {
  importAssetFromPath,
  importAssetFromBlob,
} from "../../lib/assetImport";
import { citationPlugin } from "../../lib/citationPlugin";
import { Toolbar } from "./Toolbar";
import { StatusBar } from "./StatusBar";
import type { CitationClickHandler, SaveState } from "./_shared";

interface InnerProps {
  document: Document;
  initialMarkdown: string;
  onCitationClick?: CitationClickHandler;
}

const AUTOSAVE_DEBOUNCE_MS = 800;

export function EditorInner({ document, initialMarkdown, onCitationClick }: InnerProps) {
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
