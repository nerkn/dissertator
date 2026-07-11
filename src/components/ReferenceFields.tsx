// ReferenceFields — the shared editable metadata form for a Reference.
//
// Used by both the ReferencesView inline editor and the PdfViewer's
// edit-citation dialog so the two stay in sync. The citekey is FROZEN after
// first assignment (DESIGN.md §8 decision #9): editing an EXISTING reference
// shows it read-only (changing it would orphan every `[@citekey:page]` chip
// across every manuscript). Only the create path (`citekeyEditable`) lets it
// be typed, exactly once.
//
// `authorsText` is a free-text mirror of `authors[]`: it carries the raw
// string while editing and is parsed back to Author[] on save.

import type { Author } from "@dissertator/shared";

/** Editable draft for an in-progress reference edit. `authorsText` carries the
 *  free-text authors field until save (parsed back to Author[] on submit). */
export interface ReferenceDraft {
  citekey?: string;
  title?: string | null;
  year?: number | null;
  doi?: string | null;
  authors?: Author[];
  authorsText?: string;
}

/** Format [{given,family}] → "Given Family, Given Family". */
export function fmtAuthors(a: Author[]): string {
  return a
    .map((x) => [x.given, x.family].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(", ");
}

/** Parse "Given Family; Given Family" (or "Family, Given; ...") → Author[]. */
export function parseAuthors(s: string): Author[] {
  return s
    .split(/[;\n]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      // "Family, Given" form
      const m = p.match(/^([^,]+),\s*(.+)$/);
      if (m) return { family: m[1].trim(), given: m[2].trim() };
      // "Given Family" form (last token = family)
      const i = p.lastIndexOf(" ");
      if (i === -1) return { family: p, given: "" };
      return { given: p.slice(0, i).trim(), family: p.slice(i + 1).trim() };
    });
}

interface Props {
  draft: ReferenceDraft;
  setDraft: (d: ReferenceDraft) => void;
  /** When false (default), the citekey is shown read-only — frozen once a
   *  reference exists. Only set true on the create path. */
  citekeyEditable?: boolean;
  disabled?: boolean;
}

export function ReferenceFields({
  draft,
  setDraft,
  citekeyEditable,
  disabled,
}: Props) {
  return (
    <div className="reference-edit">
      <input
        className={citekeyEditable ? undefined : "citekey-readonly"}
        placeholder="citekey"
        value={(draft.citekey as string) ?? ""}
        readOnly={!citekeyEditable}
        disabled={disabled}
        title={
          citekeyEditable
            ? "Unique citekey — frozen once saved"
            : "Citekey is fixed (used by every [@citekey] chip)"
        }
        onChange={(e) => setDraft({ ...draft, citekey: e.target.value })}
      />
      <input
        placeholder="Title"
        value={(draft.title as string) ?? ""}
        disabled={disabled}
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
      />
      <input
        placeholder="Authors (Given Family; …)"
        value={draft.authorsText ?? ""}
        disabled={disabled}
        onChange={(e) => setDraft({ ...draft, authorsText: e.target.value })}
      />
      <div className="reference-edit-row">
        <input
          placeholder="Year"
          type="number"
          value={draft.year ?? ""}
          disabled={disabled}
          onChange={(e) =>
            setDraft({
              ...draft,
              year: e.target.value ? Number(e.target.value) : null,
            })
          }
        />
        <input
          placeholder="DOI"
          value={(draft.doi as string) ?? ""}
          disabled={disabled}
          onChange={(e) => setDraft({ ...draft, doi: e.target.value })}
        />
      </div>
    </div>
  );
}
