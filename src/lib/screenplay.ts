const TITLE_KEYS = ["title", "credit", "author", "source", "draft date", "contact"];

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s: string): string {
  let t = escapeHtml(s);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  t = t.replace(/(^|[^_])_([^_]+)_(?!\w)/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return t;
}

function isUpperTr(s: string): boolean {
  return s.length > 0 && s === s.toLocaleUpperCase("tr");
}

interface TitlePage {
  fields: Record<string, string>;
  body: string;
}

function parseTitlePage(md: string): TitlePage {
  const lines = md.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  const fields: Record<string, string> = {};
  let consumedAny = false;
  for (; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === "") break;
    const m = raw.match(/^([A-Za-zÇĞİÖŞÜığöşç .]+):\s*(.*)$/);
    if (!m) break;
    const key = m[1].trim().toLocaleLowerCase("en");
    if (!TITLE_KEYS.includes(key)) break;
    fields[key] = m[2].trim();
    consumedAny = true;
  }
  if (!consumedAny) return { fields: {}, body: md };
  return { fields, body: lines.slice(i).join("\n").replace(/^\s+/, "") };
}

function renderTitlePage(fields: Record<string, string>): string {
  const title = fields.title ? `<div class="tp-title">${escapeHtml(fields.title.toLocaleUpperCase("tr"))}</div>` : "";
  const credit = fields.credit ? `<div class="tp-credit">${escapeHtml(fields.credit)}</div>` : "";
  const author = fields.author ? `<div class="tp-author">${escapeHtml(fields.author)}</div>` : "";
  const draft = fields["draft date"] ? `<div class="tp-corner-left">${escapeHtml(fields["draft date"])}</div>` : "";
  const contact = fields.contact ? `<div class="tp-corner-right">${escapeHtml(fields.contact.replace(/\n/g, "<br>") )}</div>` : "";
  if (!title && !author) return "";
  return `<section class="titlepage">${title}${credit}${author}${draft}${contact}</section>`;
}

function splitChunks(body: string): string[] {
  return body
    .split(/\n[ \t]*\n+/)
    .map((c) => c.replace(/^\n+/, "").replace(/\s+$/, ""))
    .filter((c) => c.length > 0);
}

function renderCue(line: string): { name: string; rest: string } | null {
  const m = line.match(/^\*\*([^*]+)\*\*\s*(.*)$/);
  if (!m) return null;
  const name = m[1].trim();
  if (!isUpperTr(name)) return null;
  if (/[:;]$/.test(name)) return null;
  let rest = (m[2] || "").replace(/^\s*(?:—|–|--|-)\s*/, "").trim();
  return { name, rest };
}

function splitParen(rest: string): { paren: string | null; dialog: string } {
  const pm = rest.match(/^\*\(([^*)]+)\)\*\s*(.*)$/);
  if (pm) return { paren: pm[1].trim(), dialog: pm[2].trim() };
  const pm2 = rest.match(/^\(([^)]+)\)\s*(.*)$/);
  if (pm2) return { paren: pm2[1].trim(), dialog: pm2[2].trim() };
  return { paren: null, dialog: rest };
}

function parenLine(line: string): string | null {
  const m = line.match(/^\*\(([^*)]+)\)\*$/) || line.match(/^\(([^)]+)\)$/);
  return m ? m[1].trim() : null;
}

function renderCharacterChunk(lines: string[]): string {
  const first = renderCue(lines[0]);
  if (!first) return "";
  const out: string[] = [`<p class="character">${escapeHtml(first.name)}</p>`];
  const { paren, dialog } = splitParen(first.rest);
  if (paren) out.push(`<p class="paren">(${escapeHtml(paren.toLocaleLowerCase("tr"))})</p>`);
  const dialogBuf: string[] = [];
  const flush = () => {
    if (dialogBuf.length) {
      out.push(`<p class="dialogue">${inline(dialogBuf.join("<br>"))}</p>`);
      dialogBuf.length = 0;
    }
  };
  if (dialog) dialogBuf.push(dialog);
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i].trim();
    const p = parenLine(ln);
    if (p !== null) {
      flush();
      out.push(`<p class="paren">(${escapeHtml(p.toLocaleLowerCase("tr"))})</p>`);
    } else {
      dialogBuf.push(ln);
    }
  }
  flush();
  return out.join("");
}

function isTable(chunk: string): boolean {
  const lines = chunk.split(/\n/);
  if (lines.length < 2) return false;
  return lines.some(
    (l) => /\|/.test(l) && /^[\s|:-]+$/.test(l.replace(/[^|\s:-]/g, "")) && /-+/.test(l),
  );
}

function renderTable(chunk: string): string {
  const out: string[] = [];
  for (const raw of chunk.split(/\n/)) {
    const line = raw.replace(/<br\s*\/?>/gi, " ").trim();
    if (!line || !line.includes("|")) continue;
    const stripped = line.replace(/[|\s]/g, "");
    if (/^[-:]+$/.test(stripped)) continue;
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (cells.length === 0) continue;
    if (cells.length >= 2) {
      out.push(
        `<p class="action meta"><strong>${inline(cells[0])}:</strong> ${inline(
          cells.slice(1).join(" "),
        )}</p>`,
      );
    } else {
      out.push(`<p class="action meta">${inline(cells[0])}</p>`);
    }
  }
  return out.length ? out.join("\n") : `<p class="action meta"></p>`;
}

function classify(chunk: string): string {
  const lines = chunk.split(/\r?\n/);
  const first = lines[0].trim();
  const single = lines.length === 1;

  if (/^\*\*\*\s*$/.test(first)) return `<div class="pagebreak"></div>`;
  if (/^\[\[([\s\S]*)\]\]$/.test(chunk.trim())) return "";
  if (/^=\s+/.test(first)) return "";

  let m: RegExpMatchArray | null;
  if ((m = first.match(/^###\s+(.+)$/))) return `<p class="sequence">${inline(m[1].trim())}</p>`;
  if ((m = first.match(/^##\s+(.+)$/))) return `<p class="scene">${inline(m[1].trim().toLocaleUpperCase("tr"))}</p>`;
  if ((m = first.match(/^#\s+(.+)$/))) return `<p class="act">${inline(m[1].trim().toLocaleUpperCase("tr"))}</p>`;

  if ((m = first.match(/^>\s+(.+?)\s+<\s*$/))) return `<p class="centered">${inline(m[1])}</p>`;

  const cue = renderCue(first);
  if (cue) return renderCharacterChunk(lines);

  if (single) {
    const stripped = first.replace(/^\*\*/, "").replace(/\*\*$/, "");
    if (/TO:\s*$/.test(stripped) || /^FADE\s+(IN|OUT)/i.test(stripped) || /^THE\s+END/i.test(stripped)) {
      return `<p class="transition">${inline(stripped.toLocaleUpperCase("tr"))}</p>`;
    }
  }

  const meta = first.match(/^\*\*([^*]+):\*\*\s*(.*)$/);
  if (meta && !isUpperTr(meta[1])) {
    const text = lines.map((l) => l.trim()).filter(Boolean).join(" ");
    return `<p class="action meta">${inline(text)}</p>`;
  }

  if (isTable(chunk)) return renderTable(chunk);

  const body = lines
    .map((l) => l.trim().replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, ""))
    .filter(Boolean)
    .join("<br>");
  return `<p class="action">${inline(body)}</p>`;
}

const CSS = `
@page { size: letter; margin: 1in 1in 1in 1.5in; @top-right { content: counter(page) "."; } }
@page :first { margin: 1in 1in 1in 1.5in; @top-right { content: ""; } }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: "Courier New", Courier, monospace; font-size: 12pt; line-height: 1; color: #000; }
p { margin: 0; }
.scene { font-weight: bold; margin: 24pt 0 12pt; }
.action { margin: 12pt 0; }
.action.meta { font-style: italic; }
.character { margin: 12pt 0 0; }
.paren { margin: 0 2.0in 0 1.6in; }
.dialogue { margin: 0 1.0in 12pt 1.0in; }
.transition { text-align: right; margin: 12pt 0; }
.centered { text-align: center; margin: 12pt 0; }
.act { text-align: center; font-weight: bold; margin: 24pt 0; break-before: page; }
.sequence { text-align: center; font-style: italic; margin: 12pt 0; }
.pagebreak { break-after: page; height: 0; }
.titlepage { page-break-after: always; position: relative; min-height: 9in; }
.tp-title { text-align: center; margin-top: 3.5in; font-weight: bold; }
.tp-credit { text-align: center; margin-top: 1in; }
.tp-author { text-align: center; margin-top: 0.4in; }
.tp-corner-left { position: absolute; bottom: 1in; left: 0; }
.tp-corner-right { position: absolute; bottom: 1in; right: 0; text-align: right; }
`;

export function markdownToScreenplayHtml(md: string): string {
  const cleaned = md.replace(/<br\s*\/?>/gi, " ");
  const { fields, body } = parseTitlePage(cleaned);
  const titleHtml = renderTitlePage(fields);
  const chunks = splitChunks(body);
  const bodyHtml = chunks.map(classify).join("\n");
  return `<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8"><title>${escapeHtml(
    fields.title || "screenplay",
  )}</title><style>${CSS}</style></head><body>${titleHtml}${bodyHtml}</body></html>`;
}
