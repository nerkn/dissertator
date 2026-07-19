import { useState } from "react";
import { ClipboardText, Trash } from "@phosphor-icons/react";
import type { Note } from "@dissertator/shared";

interface Props {
  note: Note;
  filename?: string;
  onOpen?: (sourceId: string, page: number) => void;
  onCopyCite: (note: Note) => Promise<void>;
  onRemove: (note: Note) => void;
}

export function NoteRow({
  note,
  filename,
  onOpen,
  onCopyCite,
  onRemove,
}: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await onCopyCite(note);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="note-row">
      <div
        className="note-row-main"
        title={`${filename ?? "source"} · p.${note.page}`}
        onClick={() => onOpen?.(note.sourceId, note.page)}
      >
        <span className="note-page">p.{note.page}</span>
        <span className="note-excerpt">
          {note.excerpt ? note.excerpt : note.body ? note.body : "(empty note)"}
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
          onClick={() => void handleCopy()}
        >
          {copied ? (
            "✓"
          ) : (
            <ClipboardText size={12} weight="bold" />
          )}
        </button>
        <button
          className="note-act"
          title="Delete note"
          onClick={() => onRemove(note)}
        >
          <Trash size={12} weight="bold" />
        </button>
      </div>
    </div>
  );
}
