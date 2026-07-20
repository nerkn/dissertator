import { useState } from "react";
import { CaretDown, CaretRight, Plus } from "@phosphor-icons/react";
import type { SourcesResponse } from "@dissertator/shared";
import { useListsNotes } from "./useListsNotes";
import { ListRow } from "./_ListRow";

interface Props {
  sources?: SourcesResponse | null;
  onOpenNote?: (sourceId: string, page: number) => void;
}

export function ListsGroup({ sources, onOpenNote }: Props) {
  const [expanded, setExpanded] = useState(false);
  const {
    lists,
    notes,
    openLists,
    toggleList,
    addList,
    removeList,
    removeNote,
    copyCite,
  } = useListsNotes();

  const filenameById = new Map<string, string>(
    (sources?.items ?? []).map((s) => [s.id, s.filename]),
  );

  return (
    <div className="group green">
      <div className="group-head group-head-row">
        <span
          className="group-head-toggle"
          onClick={() => setExpanded((v) => !v)}
          title="Select text in a PDF → save a note. Copy a citation while writing."
        >
          {expanded ? (
            <CaretDown size={13} weight="bold" />
          ) : (
            <CaretRight size={13} weight="bold" />
          )}
          Favorites
        </span>
        <button
          className="btn ghost tiny-btn"
          onClick={addList}
          title="Create a new list"
        >
          <Plus size={13} weight="bold" />
          New
        </button>
      </div>
      {expanded &&
        (lists.length === 0 ? (
          <div className="muted small source-tree-empty">No lists yet.</div>
        ) : (
          <div className="lists-tree">
            {lists.map((list) => (
              <ListRow
                key={list.id}
                list={list}
                notes={notes.filter((n) => n.listId === list.id)}
                isOpen={openLists.has(list.id)}
                filenameById={filenameById}
                onToggle={() => toggleList(list.id)}
                onRemoveList={() => removeList(list.id, list.label)}
                onOpenNote={onOpenNote}
                onCopyCite={copyCite}
                onRemoveNote={removeNote}
              />
            ))}
          </div>
        ))}
    </div>
  );
}
