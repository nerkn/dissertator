import { useCallback, useEffect, useState } from "react";
import type { List, Note } from "@dissertator/shared";
import { api } from "../../lib/api";
import { useSessionStore } from "../../lib/stores/session";
import { notifyNotesChanged, insertCitation } from "../NotePopup";
import { promptDialog, confirmDialog } from "../../lib/stores/dialogs";

export function useListsNotes() {
  const projectPath = useSessionStore((s) => s.project?.projectPath ?? null);
  const [lists, setLists] = useState<List[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [openLists, setOpenLists] = useState<Set<number>>(() => new Set());

  const refresh = useCallback(async () => {
    try {
      const [ls, ns] = await Promise.all([api.listLists(), api.listNotes()]);
      setLists(ls);
      setNotes(ns);
    } catch {
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener("dissertator:notes-changed", onChange);
    return () =>
      window.removeEventListener("dissertator:notes-changed", onChange);
  }, [refresh, projectPath]);

  const toggleList = useCallback((id: number) => {
    setOpenLists((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const addList = useCallback(async () => {
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
    }
  }, []);

  const removeList = useCallback(async (id: number, label: string) => {
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
    }
  }, []);

  const removeNote = useCallback(async (note: Note) => {
    try {
      await api.deleteNote(note.id);
      notifyNotesChanged();
    } catch {
    }
  }, []);

  const copyCite = useCallback(async (note: Note) => {
    if (!note.citekey) return;
    const token = `[@${note.citekey}:${note.page}]`;
    const text = (note.excerpt ?? note.body ?? "").trim();
    const snippet = text ? `${text} ${token}` : token;
    if (!insertCitation(snippet)) {
      try {
        await navigator.clipboard.writeText(snippet);
      } catch {
      }
    }
  }, []);

  return {
    lists,
    notes,
    openLists,
    toggleList,
    addList,
    removeList,
    removeNote,
    copyCite,
  };
}
