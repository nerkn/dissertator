// ---------------------------------------------------------------------------
// Toolbar — Word-like formatting buttons. Each fires a Milkdown command via
// `editor.action(callCommand(key, payload?))`. Selection/active-state tracking
// (e.g. highlighting Bold when the cursor is in bold text) is deferred; v1
// buttons are stateless triggers.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useInstance } from "@milkdown/react";
import type { Editor } from "@milkdown/kit/core";
import { callCommand, getHTML } from "@milkdown/kit/utils";
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
import { undoCommand, redoCommand } from "@milkdown/kit/plugin/history";
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
import { api } from "../../lib/api";
import { promptDialog } from "../../lib/stores/dialogs";
import { SavePip } from "./StatusBar";
import type { SaveState } from "./_shared";

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

export function Toolbar({
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

  useEffect(() => {
    const details = exportMenuRef.current;
    if (!details) return;
    const onDown = (e: MouseEvent) => {
      if (details.open && !details.contains(e.target as Node)) details.open = false;
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // Run a Milkdown command. Spread into `callCommand` so the key + payload
  // are typed exactly as `callCommand` expects (no manual casts).
  const run = (...args: Parameters<typeof callCommand>) => {
    const ed = getEditor();
    if (!ed) return;
    ed.action(callCommand(...args));
  };

  const insertLink = async () => {
    const url = await promptDialog({
      title: "Insert link",
      label: "URL",
      placeholder: "https://…",
      okLabel: "Insert",
    });
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
