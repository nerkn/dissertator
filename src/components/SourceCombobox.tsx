// SourceCombobox — a "writable dropdown": a text input that filters the source
// list as you type, with a results list you click (or pick via arrows + Enter)
// to select. Used in CitationPopup so an unresolved `[@citekey:page]` chip can
// be mapped to a source straight from the manuscript, instead of bouncing to
// the References tab.
//
// Closes on outside-click / Escape; resets after a pick.

import { useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, FilePdf, MagnifyingGlass } from "@phosphor-icons/react";
import type { SourceFile } from "@dissertator/shared";

interface Props {
  sources: SourceFile[];
  disabled?: boolean;
  placeholder?: string;
  onSelect: (source: SourceFile) => void;
}

export function SourceCombobox({
  sources,
  disabled,
  placeholder,
  onSelect,
}: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? sources.filter((s) => s.filename.toLowerCase().includes(q))
      : sources;
    return list.slice(0, 50);
  }, [sources, query]);

  // Reset highlight whenever the filter changes.
  useEffect(() => setActive(0), [query]);

  // Close on outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const choose = (s: SourceFile) => {
    onSelect(s);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className={`source-combobox${open ? " open" : ""}`} ref={boxRef}>
      <div className="source-combobox-input">
        <MagnifyingGlass size={13} weight="bold" />
        <input
          placeholder={placeholder ?? "Type to search sources…"}
          value={query}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(a + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (filtered[active]) choose(filtered[active]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        />
        <CaretDown size={13} weight="bold" className="source-combobox-caret" />
      </div>
      {open && (
        <ul className="source-combobox-list">
          {filtered.length === 0 ? (
            <li className="muted small source-combobox-empty">No sources match.</li>
          ) : (
            filtered.map((s, i) => (
              <li
                key={s.id}
                className={i === active ? "active" : ""}
                title={s.filename}
                onMouseEnter={() => setActive(i)}
                // mousedown (not click) so the input doesn't blur first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(s);
                }}
              >
                <FilePdf size={13} weight="bold" />
                <span className="source-combobox-name">{s.filename}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
