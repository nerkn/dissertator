// Unit tests for the prompts.md parser (P4). No DB needed — `parsePrompts` is
// a pure function over a markdown string.
//
// Pins:
//   1. headings (`## X`) set the category for following bullets;
//   2. `**Label**: text` bullets split into {label, prompt: text};
//   3. plain bullets get a truncated label (~40 chars + "…");
//   4. `* ` markers work the same as `- `;
//   5. empty / bullet-less file → [];
//   6. blank lines + prose lines are ignored.

import { expect, test } from "bun:test";
import { parsePrompts } from "./prompts.ts";

test("headings set the category for following bullets", () => {
  const md = `
## Drafting

- Write intro
- Outline methods

## Revising

- Tighten prose
`;
  const out = parsePrompts(md);
  expect(out).toEqual([
    { category: "Drafting", label: "Write intro", prompt: "Write intro" },
    { category: "Drafting", label: "Outline methods", prompt: "Outline methods" },
    { category: "Revising", label: "Tighten prose", prompt: "Tighten prose" },
  ]);
});

test("`**Label**: text` splits into label + prompt", () => {
  const md = `- **Summarize**: Summarize the open source in 5 bullets.`;
  const out = parsePrompts(md);
  expect(out).toEqual([
    { label: "Summarize", prompt: "Summarize the open source in 5 bullets." },
  ]);
});

test("label split tolerates extra spaces around the colon", () => {
  const md = `- **Find gaps**  :   List claims not backed by a citation.`;
  const out = parsePrompts(md);
  expect(out).toEqual([
    {
      label: "Find gaps",
      prompt: "List claims not backed by a citation.",
    },
  ]);
});

test("plain bullet truncates a long prompt to a ~40-char label with …", () => {
  const longText =
    "This is a very long prompt that should be truncated down to about forty characters for the label.";
  const out = parsePrompts(`- ${longText}`);
  expect(out).toHaveLength(1);
  expect(out[0].prompt).toBe(longText); // prompt keeps full text
  expect(out[0].label.length).toBeLessThanOrEqual(41); // 40 + "…"
  expect(out[0].label.endsWith("…")).toBe(true);
});

test("plain bullet under the truncation threshold uses the full text as label", () => {
  const out = parsePrompts("- short text here");
  expect(out).toEqual([{ label: "short text here", prompt: "short text here" }]);
});

test("`* ` markers work the same as `- ` bullets", () => {
  const md = `* alpha
* **Beta**: beta prompt`;
  const out = parsePrompts(md);
  expect(out).toEqual([
    { label: "alpha", prompt: "alpha" },
    { label: "Beta", prompt: "beta prompt" },
  ]);
});

test("empty file → []", () => {
  expect(parsePrompts("")).toEqual([]);
});

test("file with only headings + prose (no bullets) → []", () => {
  const md = `
## Drafting

This is some introductory prose explaining the section.

Another paragraph of prose.

## Empty
`;
  expect(parsePrompts(md)).toEqual([]);
});

test("blank lines and prose lines between bullets are ignored", () => {
  const md = `
- first

some prose in the middle that should be skipped

- second
`;
  const out = parsePrompts(md);
  expect(out).toEqual([
    { label: "first", prompt: "first" },
    { label: "second", prompt: "second" },
  ]);
});

test("a category persists across multiple bullets until the next heading", () => {
  const md = `
## A
- a1
- a2

## B
- b1
`;
  const out = parsePrompts(md);
  expect(out.map((p) => p.category)).toEqual(["A", "A", "B"]);
});

test("bullets before any heading have no category", () => {
  const out = parsePrompts("- orphan");
  expect(out).toEqual([{ category: undefined, label: "orphan", prompt: "orphan" }]);
});
