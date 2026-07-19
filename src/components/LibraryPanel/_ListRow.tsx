import { CaretDown, CaretRight, Trash } from "@phosphor-icons/react";
import type { List, Note } from "@dissertator/shared";
import { NoteRow } from "./_NoteRow";

interface Props {
  list: List;
  notes: Note[];
  isOpen: boolean;
  filenameById: Map<string, string>;
  onToggle: () => void;
  onRemoveList: () => void;
  onOpenNote?: (sourceId: string, page: number) => void;
  onCopyCite: (note: Note) => Promise<void>;
  onRemoveNote: (note: Note) => void;
}

export function ListRow({
  list,
  notes,
  isOpen,
  filenameById,
  onToggle,
  onRemoveList,
  onOpenNote,
  onCopyCite,
  onRemoveNote,
}: Props) {
  return (
    <div className="list-group">
      <div
        className="list-head"
        role="button"
        aria-expanded={isOpen}
        onClick={onToggle}
        title={isOpen ? "Collapse" : "Expand"}
      >
        {isOpen ? (
          <CaretDown size={12} weight="bold" />
        ) : (
          <CaretRight size={12} weight="bold" />
        )}
        <span className="list-dot" style={{ background: list.color }} />
        <span className="list-label">{list.label}</span>
        <span className="list-count">{notes.length}</span>
        {!list.system && (
          <button
            className="list-del"
            title={`Delete “${list.label}”`}
            onClick={(e) => {
              e.stopPropagation();
              onRemoveList();
            }}
          >
            <Trash size={12} weight="bold" />
          </button>
        )}
      </div>
      {isOpen && (
        <div className="list-notes">
          {notes.length === 0 ? (
            <div className="muted small source-tree-empty">
              No notes in this list.
            </div>
          ) : (
            notes.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                filename={filenameById.get(note.sourceId)}
                onOpen={onOpenNote}
                onCopyCite={onCopyCite}
                onRemove={onRemoveNote}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
