// ListsGroup — the 🔖 Lists section of the Library panel.
//
// Self-fetched: the Library is the only browser of saved notes. Owns the
// lists + notes state, the `dissertator:notes-changed` refresh listener, and
// every list/note action (create/delete list, delete note, copy-cite). A note
// saved in the PDF viewer (which fires that CustomEvent) appears here without
// any App-level plumbing.

import { useCallback, useEffect, useState } from "react";
import {
  CaretDown,
  CaretRight,
  ClipboardText,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import type { List, Note, SourcesResponse } from "@dissertator/shared";
import { api } from "../../lib/api";
import { useSessionStore } from "../../lib/stores/session";
import { notifyNotesChanged, insertCitation } from "../NotePopup";
import { promptDialog, confirmDialog } from "../../lib/stores/dialogs";

interface Props {
  /** Source list — used to label note rows with their source's filename. */
  sources?: SourcesResponse | null;
  /** Open a note's source in the viewer at the note's page. */
  onOpenNote?: (sourceId: string, page: number) => void;
}

export function ListsGroup({ sources, onOpenNote }: Props) {
  // Lists/notes live in the per-project DB; reload on project switch.
  const projectPath = useSessionStore((s) => s.project?.projectPath ?? null);
  const [lists, setLists] = useState<List[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [openLists, setOpenLists] = useState<Set<number>>(() => new Set());
  const [copiedNote, setCopiedNote] = useState<string | null>(null);

  const refreshListsNotes = useCallback(async () => {
    try {
      const [ls, ns] = await Promise.all([
        api.listLists(),
        api.listNotes(),
      ]);
      setLists(ls);
      setNotes(ns);
    } catch {
      /* sidecar mid-restart; the event listener will retry on next change */
    }
  }, []);

  useEffect(() => {
    void refreshListsNotes();
    const onChange = () => void refreshListsNotes();
    window.addEventListener("dissertator:notes-changed", onChange);
    return () =>
      window.removeEventListener("dissertator:notes-changed", onChange);
  }, [refreshListsNotes, projectPath]);

  // source id → filename, for labelling note rows (notes cascade-delete with
  // their source, so every note's source is present here).
  const filenameById = new Map<string, string>(
    (sources?.items ?? []).map((s) => [s.id, s.filename]),
  );

  const toggleList = (id: number) =>
    setOpenLists((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const addList = async () => {
    const label = await promptDialog({
      title: "New list",
      label: "List name",
      placeholder: "e.g. Methods",
      okLabel: "Create",
    });
    if (!label?.trim()) return;
    try {
      await api.createList({ label: label.trim() });
      notifyNotesChanged();
    } catch {
      /* best-effort; refresh on next notes-changed */
    }
  };

  const removeList = async (id: number, label: string) => {
    const ok = await confirmDialog({
      title: "Delete list",
      message: `Delete list “${label}” and its notes?`,
      okLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteList(id);
      notifyNotesChanged();
    } catch {
      /* built-in lists refuse server-side; ignore here */
    }
  };

  const removeNote = async (note: Note) => {
    try {
      await api.deleteNote(note.id);
      notifyNotesChanged();
    } catch {
      /* sidecar mid-restart */
    }
  };

  const copyCite = async (note: Note) => {
    if (!note.citekey) return;
    const token = `[@${note.citekey}:${note.page}]`;
    // Bring the fav INTO the manuscript: the highlighted excerpt (or the
    // user's own note as a fallback) followed by its source token, so the
    // passage lands with its citation attached. Falls back to the bare token
    // when the note has no text. Inserts at the manuscript cursor when an
    // editor is open; otherwise copies to the clipboard for manual paste.
    const text = (note.excerpt ?? note.body ?? "").trim();
    const snippet = text ? `${text} ${token}` : token;
    if (!insertCitation(snippet)) {
      try {
        await navigator.clipboard.writeText(snippet);
      } catch {
        /* clipboard blocked (e.g. not focused) — silently ignore */
      }
    }
    setCopiedNote(note.id);
    setTimeout(() => setCopiedNote((cur) => (cur === note.id ? null : cur)), 1200);
  };

  return (
    <div className="group green">
      <div className="group-head group-head-row">
        <span>🔖 Lists</span>
        <button
          className="btn ghost tiny-btn"
          onClick={addList}
          title="Create a new list"
        >
          <Plus size={13} weight="bold" />
          New
        </button>
      </div>
      <div className="count">{notes.length} notes</div>
      <div className="muted small">
        Select text in a PDF → save a note. Copy a citation while writing.
      </div>
      {lists.length === 0 ? (
        <div className="muted small source-tree-empty">No lists yet.</div>
      ) : (
        <div className="lists-tree">
          {lists.map((list) => {
            const listNotes = notes.filter((n) => n.listId === list.id);
            const isOpen = openLists.has(list.id);
            return (
              <div key={list.id} className="list-group">
                <div
                  className="list-head"
                  role="button"
                  aria-expanded={isOpen}
                  onClick={() => toggleList(list.id)}
                  title={isOpen ? "Collapse" : "Expand"}
                >
                  {isOpen ? (
                    <CaretDown size={12} weight="bold" />
                  ) : (
                    <CaretRight size={12} weight="bold" />
                  )}
                  <span
                    className="list-dot"
                    style={{ background: list.color }}
                  />
                  <span className="list-label">{list.label}</span>
                  <span className="list-count">{listNotes.length}</span>
                  {!list.system && (
                    <button
                      className="list-del"
                      title={`Delete “${list.label}”`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeList(list.id, list.label);
                      }}
                    >
                      <Trash size={12} weight="bold" />
                    </button>
                  )}
                </div>
                {isOpen && (
                  <div className="list-notes">
                    {listNotes.length === 0 ? (
                      <div className="muted small source-tree-empty">
                        No notes in this list.
                      </div>
                    ) : (
                      listNotes.map((note) => (
                        <div key={note.id} className="note-row">
                          <div
                            className="note-row-main"
                            title={`${filenameById.get(note.sourceId) ?? "source"} · p.${note.page}`}
                            onClick={() =>
                              onOpenNote?.(note.sourceId, note.page)
                            }
                          >
                            <span className="note-page">p.{note.page}</span>
                            <span className="note-excerpt">
                              {note.excerpt
                                ? note.excerpt
                                : note.body
                                  ? note.body
                                  : "(empty note)"}
                            </span>
                          </div>
                          <div className="note-row-actions">
                            <button
                              className="note-act"
                              disabled={!note.citekey}
                              title={
                                note.citekey
                                  ? `Insert excerpt + [@${note.citekey}:${note.page}] at cursor — copies if no manuscript is open`
                                  : "Link a reference to this source first"
                              }
                              onClick={() => void copyCite(note)}
                            >
                              {copiedNote === note.id ? (
                                "✓"
                              ) : (
                                <ClipboardText size={12} weight="bold" />
                              )}
                            </button>
                            <button
                              className="note-act"
                              title="Delete note"
                              onClick={() => void removeNote(note)}
                            >
                              <Trash size={12} weight="bold" />
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
