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
// Citation tokens `[@citekey:printedPage]` (DESIGN.md §11 #8) are currently
// preserved verbatim as editable text. A visual "chip" inline node (resolved
// to "Smith 2020, p.42") + an insert-citation popup arrive in the next
// increment — the remark/ProseMirror round-trip is the hard part and is
// deliberately staged after the core editor works end-to-end.
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
} from "@phosphor-icons/react";
import type { Document } from "@dissertator/shared";
import { api } from "../lib/api";

interface Props {
  documentId: string;
}

/** Autosave lifecycle, shown as a small status pip in the toolbar. */
type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

const AUTOSAVE_DEBOUNCE_MS = 800;

export function ManuscriptEditor({ documentId }: Props) {
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
  }, [documentId]);

  if (loading) return <div className="editor-status">Loading document…</div>;
  if (error)
    return <div className="editor-error">Failed to load document: {error}</div>;
  if (!doc) return null;

  return (
    <MilkdownProvider>
      <EditorInner document={doc} initialMarkdown={doc.bodyMd ?? ""} />
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
}

function EditorInner({ document, initialMarkdown }: InnerProps) {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [showSource, setShowSource] = useState<boolean>(false);
  // Live markdown mirror — drives the read-only source view without round-
  // tripping through the editor.
  const [sourceMd, setSourceMd] = useState<string>(initialMarkdown);

  // Latest markdown + pending timer, in refs so the Milkdown factory closure
  // (created once) always reads current values without re-creating the editor.
  const latestMd = useRef<string>(initialMarkdown);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialMdRef = useRef<string>(initialMarkdown);

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

  // Called from the Milkdown `markdownUpdated` listener on every keystroke.
  const scheduleSave = useCallback(
    (md: string) => {
      latestMd.current = md;
      setSourceMd(md);
      setSaveState("dirty");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        void doSave(latestMd.current);
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [doSave],
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
        void doSave(latestMd.current);
      }
    };
  }, [doSave]);

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
      .use(listener),
    [],
  );

  return (
    <div className="manuscript-editor">
      <Toolbar
        getEditor={get}
        title={document.title}
        saveState={saveState}
        showSource={showSource}
        onToggleSource={() => setShowSource((v) => !v)}
      />
      <div className="editor-surface">
        {showSource ? (
          <pre className="editor-source-view">{sourceMd || "(empty)"}</pre>
        ) : (
          <EditorPage />
        )}
      </div>
    </div>
  );
}

/** The centered "page" + the Milkdown editable surface. */
function EditorPage() {
  return (
    <div className="editor-page">
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
}

function Toolbar({
  getEditor,
  title,
  saveState,
  showSource,
  onToggleSource,
}: ToolbarProps) {
  // `useInstance` re-renders the toolbar once the editor is ready; buttons are
  // disabled until then so a fast click can't call .action() on undefined.
  const [loading] = useInstance();

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
      <Sep />
      <Btn label="Undo (Ctrl+Z)" onClick={() => run(undoCommand.key)}>
        <ArrowCounterClockwise size={16} weight="bold" />
      </Btn>
      <Btn label="Redo (Ctrl+Shift+Z)" onClick={() => run(redoCommand.key)}>
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
