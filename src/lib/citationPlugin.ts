// Citation decorations for the Milkdown / ProseMirror manuscript editor.
//
// Pandoc-style citation tokens `[@citekey]` / `[@citekey:42]` are stored as
// plain EDITABLE text in the document — so the agent's edits, the autosave
// PUT, and the eventual pandoc/CSL export all see clean markdown. This module
// makes those tokens *look and act* like chips WITHOUT changing the document
// model: it adds inline ProseMirror DECORATIONS over each token's text range.
// Decorations only attach attributes/CSS to existing text, so they survive
// every keystroke, undo, and agent-edit round-trip without corrupting state.
//
// Clicking a chip is handled by event delegation on the editor surface
// (ManuscriptEditor): it reads `data-citekey` / `data-page` off the closest
// decorated element and resolves the citation (open the linked PDF at the
// page, or pop up the reference card for a fileless citation).

import { Plugin, PluginKey } from "@milkdown/prose/state";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import type { Node as PmNode } from "@milkdown/prose/model";
import { $prose } from "@milkdown/kit/utils";

/** Fired when the user clicks a `[@citekey:page]` chip in the manuscript.
 *  `rect` is the chip's bounding rect, for anchoring a popover. */
export type CitationClickHandler = (
  citekey: string,
  page: number | null,
  rect: DOMRect,
) => void;

/**
 * Match a single Pandoc citation token: `[@citekey]` or `[@citekey:42]`.
 * Captures the inner text (everything until `]` or whitespace). Unicode-aware
 * so user-typed non-ASCII citekeys (e.g. `[@Balcıoğlu2001]`) match too.
 */
const CITE_RE = /\[@([^\]\s]+)\]/g;

export interface ParsedCitation {
  citekey: string;
  page: number | null;
}

/**
 * Parse the inner text of a `[@...]` token into citekey + optional page.
 * Handles the common single-citation forms; for Pandoc multi-citations
 * (`[@a; @b]`) the FIRST entry is used for the chip (the raw text is
 * preserved either way). A leading `@` is tolerated.
 */
export function parseCitationToken(inner: string): ParsedCitation {
  const first = inner.split(/[;,]/)[0].trim().replace(/^@/, "");
  const idx = first.indexOf(":");
  if (idx === -1) return { citekey: first, page: null };
  const citekey = first.slice(0, idx).trim();
  const n = parseInt(first.slice(idx + 1).trim(), 10);
  return { citekey, page: Number.isFinite(n) && n > 0 ? n : null };
}

/** Build the DecorationSet for a doc: one inline decoration per token. */
function decorationsFor(doc: PmNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      const text = node.text;
      CITE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CITE_RE.exec(text)) !== null) {
        const { citekey } = parseCitationToken(m[1]);
        if (!citekey) continue;
        const from = pos + m.index;
        const to = from + m[0].length;
        decos.push(
          Decoration.inline(from, to, {
            class: "cite-chip",
            "data-citekey": citekey,
            "data-page": m[1].includes(":")
              ? String(parseCitationToken(m[1]).page ?? "")
              : "",
          }),
        );
      }
    }
    return true; // descend into children
  });
  return DecorationSet.create(doc, decos);
}

const citationKey = new PluginKey<DecorationSet>("dissertator-citations");

/**
 * The Milkdown plugin: scans the doc on init and whenever it changes, and
 * re-derives the chip decorations. Cheap (a single descendants walk per
 * transaction that actually edits text) and fully derived state (no stale
 * decorations to clean up manually).
 */
export const citationPlugin = $prose(
  () =>
    new Plugin({
      key: citationKey,
      state: {
        init: (_config, state) => decorationsFor(state.doc),
        apply: (tr, old) => (tr.docChanged ? decorationsFor(tr.doc) : old),
      },
      props: {
        decorations: (state) => citationKey.getState(state),
      },
    }),
);
