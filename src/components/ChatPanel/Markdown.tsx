import { Fragment, type ReactNode } from "react";

type Inline =
  | { t: "text"; v: string }
  | { t: "bold"; c: Inline[] }
  | { t: "italic"; c: Inline[] }
  | { t: "strike"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] };

const MAX_PARSE_LEN = 200_000;
const MAX_BLOCKS = 4_000;
const MAX_INLINE_DEPTH = 64;

function parseInline(s: string, depth = 0): Inline[] {
  if (depth > MAX_INLINE_DEPTH || s.length > MAX_PARSE_LEN) {
    return [{ t: "text", v: s.slice(0, MAX_PARSE_LEN) }];
  }
  const out: Inline[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) {
      out.push({ t: "text", v: buf });
      buf = "";
    }
  };
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (c === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ t: "code", v: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (c === "*" && next === "*") {
      const end = s.indexOf("**", i + 2);
      if (end > i + 1) {
        flush();
        out.push({ t: "bold", c: parseInline(s.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }
    if (c === "~" && next === "~") {
      const end = s.indexOf("~~", i + 2);
      if (end > i + 1) {
        flush();
        out.push({ t: "strike", c: parseInline(s.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }
    if ((c === "*" || c === "_") && next !== "*" && next !== "_") {
      const closer = c;
      let end = -1;
      for (let j = i + 1; j < s.length; j++) {
        if (s[j] === closer && s[j + 1] !== closer && s[j - 1] !== closer) {
          end = j;
          break;
        }
      }
      if (end > i) {
        flush();
        out.push({ t: "italic", c: parseInline(s.slice(i + 1, end), depth + 1) });
        i = end + 1;
        continue;
      }
    }
    if (c === "[") {
      const cb = s.indexOf("]", i + 1);
      if (cb > i && s[cb + 1] === "(") {
        const cp = s.indexOf(")", cb + 2);
        if (cp > cb) {
          const href = s.slice(cb + 2, cp);
          if (buf) {
            out.push({ t: "text", v: buf });
            buf = "";
          }
          out.push({ t: "link", href, c: parseInline(s.slice(i + 1, cb), depth + 1) });
          i = cp + 1;
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return <Fragment key={i}>{n.v}</Fragment>;
      case "bold":
        return <strong key={i}>{renderInline(n.c)}</strong>;
      case "italic":
        return <em key={i}>{renderInline(n.c)}</em>;
      case "strike":
        return (
          <s key={i} className="md-strike">
            {renderInline(n.c)}
          </s>
        );
      case "code":
        return (
          <code key={i} className="md-inline-code">
            {n.v}
          </code>
        );
      case "link": {
        const safe = /^(https?:|mailto:|\/|#)/i.test(n.href) ? n.href : undefined;
        return safe ? (
          <a key={i} href={safe} target="_blank" rel="noreferrer noopener">
            {renderInline(n.c)}
          </a>
        ) : (
          <Fragment key={i}>{renderInline(n.c)}</Fragment>
        );
      }
    }
  });
}

type Block =
  | { t: "code"; lang?: string; lines: string[] }
  | { t: "heading"; level: number; text: string }
  | { t: "quote"; text: string }
  | { t: "ul"; items: string[] }
  | { t: "ol"; items: string[] }
  | { t: "para"; text: string }
  | { t: "table"; header: string[]; align: TableAlign[]; rows: string[][] }
  | { t: "hr" };

const SPECIAL = /^\s*(```|#{1,6}\s|>\s?|[-*+]\s|\d+\.\s|---\s*$|\*\*\*\s*$|___\s*$|\|)/;

type TableAlign = "left" | "right" | "center" | "none";

function tableCells(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|\s*$/, "");
  return t.split("|").map((s) => s.trim());
}
function isTableSep(line: string): boolean {
  const cells = tableCells(line);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-{1,}:?$/.test(c));
}
function alignOf(cell: string): TableAlign {
  const l = cell.startsWith(":");
  const r = cell.endsWith(":");
  if (l && r) return "center";
  if (r) return "right";
  if (l) return "left";
  return "none";
}
function parseBlocks(src: string): Block[] {
  if (src.length > MAX_PARSE_LEN) {
    return [{ t: "para", text: src.slice(0, MAX_PARSE_LEN) }];
  }
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    if (blocks.length >= MAX_BLOCKS) break;
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || undefined;
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({ t: "code", lang, lines: code });
      continue;
    }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push({ t: "heading", level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ t: "quote", text: quote.join("\n") });
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      blocks.push({ t: "ul", items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ t: "ol", items });
      continue;
    }
    if (i + 1 < lines.length && line.includes("|") && isTableSep(lines[i + 1])) {
      const header = tableCells(line);
      const aligns = tableCells(lines[i + 1]).map(alignOf);
      i += 2;
      const rows: string[][] = [];
      while (
        i < lines.length &&
        lines[i].includes("|") &&
        lines[i].trim() !== ""
      ) {
        rows.push(tableCells(lines[i]));
        i++;
      }
      blocks.push({ t: "table", header, align: aligns, rows });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !SPECIAL.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    if (para.length === 0 && i < lines.length) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ t: "para", text: para.join("\n") });
  }
  return blocks;
}

function renderPara(text: string, key: number): ReactNode {
  const parts = text.split("\n");
  return (
    <p key={key} className="md-para">
      {parts.map((p, j) => (
        <Fragment key={j}>
          {renderInline(parseInline(p))}
          {j < parts.length - 1 && <br />}
        </Fragment>
      ))}
    </p>
  );
}

function renderBlock(b: Block, i: number): ReactNode {
  switch (b.t) {
    case "code":
      return (
        <pre key={i} className="md-code-block">
          <code>{b.lines.join("\n")}</code>
        </pre>
      );
    case "heading": {
      const lvl = Math.min(b.level, 4);
      const cls = `md-h md-h${lvl}`;
      const content = renderInline(parseInline(b.text));
      if (lvl <= 1) return <h1 key={i} className={cls}>{content}</h1>;
      if (lvl === 2) return <h2 key={i} className={cls}>{content}</h2>;
      if (lvl === 3) return <h3 key={i} className={cls}>{content}</h3>;
      return <h4 key={i} className={cls}>{content}</h4>;
    }
    case "quote":
      return (
        <blockquote key={i} className="md-quote">
          {renderPara(b.text, 0)}
        </blockquote>
      );
    case "ul":
      return (
        <ul key={i} className="md-ul">
          {b.items.map((it, j) => (
            <li key={j}>{renderInline(parseInline(it))}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={i} className="md-ol">
          {b.items.map((it, j) => (
            <li key={j}>{renderInline(parseInline(it))}</li>
          ))}
        </ol>
      );
    case "table": {
      const alignStyle = (a?: TableAlign) =>
        a === "left" || a === "right" || a === "center"
          ? { textAlign: a }
          : undefined;
      return (
        <div key={i} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {b.header.map((h, j) => (
                  <th key={j} style={alignStyle(b.align[j])}>
                    {renderInline(parseInline(h))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, j) => (
                    <td key={j} style={alignStyle(b.align[j])}>
                      {renderInline(parseInline(cell))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "hr":
      return <hr key={i} className="md-hr" />;
    case "para":
      return renderPara(b.text, i);
  }
}

export function Markdown({ text }: { text: string }) {
  if (!text) return null;
  let blocks: Block[];
  try {
    blocks = parseBlocks(text);
  } catch {
    return (
      <div className="md">
        <p className="md-para">{text}</p>
      </div>
    );
  }
  return <div className="md">{blocks.map((b, i) => renderBlock(b, i))}</div>;
}
