/**
 * 改良資料（proposal.md）を表示するための簡易 Markdown 解析。依存を増やさないため自前で持つ。
 *
 * - HTML 文字列は作らず、構文木を返す。描画は components/sales/markdown.tsx が React 要素で行うため、
 *   Markdown 内の生 HTML（<script> 等）はそのまま文字として表示され、実行されない。
 * - リンクは http(s)・mailto だけを有効にする（javascript: 等や相対パスは文字として表示）。
 * - 対応：見出し、段落、箇条書き（入れ子）、番号付きリスト、表、引用、コードブロック、区切り線、
 *   強調（**）、斜体（*）、インラインコード、リンク。それ以外は文字として表示する。
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] };

export interface ListItem {
  children: Inline[];
  blocks: Block[];
}

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "table"; header: Inline[][]; rows: Inline[][][] }
  | { type: "blockquote"; blocks: Block[] }
  | { type: "code"; text: string }
  | { type: "hr" };

const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** 安全とみなすリンク先。それ以外は null（文字として表示） */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^https?:\/\/[^\s]+$/i.test(href)) return href;
  if (/^mailto:[^\s]+$/i.test(href)) return href;
  return null;
}

// ---------- インライン ----------

function pushText(out: Inline[], text: string) {
  if (text === "") return;
  const last = out[out.length - 1];
  if (last?.type === "text") last.text += text;
  else out.push({ type: "text", text });
}

/** 行内の記法を解析する */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length && /[\\`*_[\]()#+\-.!|>~]/.test(src[i + 1] ?? "")) {
      pushText(out, src[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        out.push({ type: "code", text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (src.startsWith("**", i)) {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        out.push({ type: "strong", children: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" && src[i + 1] !== " " && src[i + 1] !== "*") {
      const end = src.indexOf("*", i + 1);
      if (end > i + 1 && src[end - 1] !== " ") {
        out.push({ type: "em", children: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const m = /^\[([^\]]*)\]\(([^()\s]*)\)/.exec(src.slice(i));
      if (m) {
        const href = safeHref(m[2] ?? "");
        const label = parseInline(m[1] ?? "");
        if (href) out.push({ type: "link", href, children: label });
        else {
          // 安全でないリンク先は表示しない（文言だけ残す）
          for (const n of label) {
            if (n.type === "text") pushText(out, n.text);
            else out.push(n);
          }
        }
        i += m[0].length;
        continue;
      }
    }
    pushText(out, ch ?? "");
    i++;
  }
  return out;
}

// ---------- ブロック ----------

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += s[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}

function isTableStart(lines: string[], i: number): boolean {
  const line = lines[i] ?? "";
  const next = lines[i + 1] ?? "";
  return line.includes("|") && next.includes("-") && TABLE_SEP_RE.test(next);
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i] ?? "";
  return (
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    FENCE_RE.test(line) ||
    QUOTE_RE.test(line) ||
    LIST_RE.test(line) ||
    isTableStart(lines, i)
  );
}

const indentOf = (line: string) => /^ */.exec(line)?.[0].length ?? 0;

function parseLines(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1] ?? "```";
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith(marker)) body.push(lines[i++] ?? "");
      i++; // 閉じるフェンス（無ければ末尾まで）
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = (heading[1] ?? "#").length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: "heading", level, children: parseInline(heading[2] ?? "") });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const q = QUOTE_RE.exec(lines[i] ?? "");
        if (!q) break;
        inner.push(q[1] ?? "");
        i++;
      }
      blocks.push({ type: "blockquote", blocks: depth < 8 ? parseLines(inner, depth + 1) : [] });
      continue;
    }

    if (isTableStart(lines, i)) {
      const header = splitRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") {
        const cells = splitRow(lines[i] ?? "");
        rows.push(header.map((_, k) => parseInline(cells[k] ?? "")));
        i++;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }

    const first = LIST_RE.exec(line);
    if (first) {
      const base = (first[1] ?? "").length;
      const ordered = /\d/.test(first[2] ?? "");
      const items: { head: string; rest: string[] }[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? "";
        const m = LIST_RE.exec(l);
        if (m && (m[1] ?? "").length <= base && /\d/.test(m[2] ?? "") === ordered) {
          items.push({ head: m[3] ?? "", rest: [] });
          i++;
          continue;
        }
        const cur = items[items.length - 1];
        if (!cur) break;
        if (l.trim() === "") {
          // 空行の次が字下げされた続きなら同じ項目、そうでなければリストを終える
          const next = lines[i + 1] ?? "";
          if (next.trim() !== "" && indentOf(next) > base) {
            cur.rest.push("");
            i++;
            continue;
          }
          break;
        }
        if (indentOf(l) > base) {
          cur.rest.push(l.slice(Math.min(indentOf(l), base + 2)));
          i++;
          continue;
        }
        if (m || startsBlock(lines, i)) break;
        // 字下げの無い続きの行（遅延継続）
        cur.head += `\n${l.trim()}`;
        i++;
      }
      blocks.push({
        type: "list",
        ordered,
        start: ordered ? Number.parseInt(first[2] ?? "1", 10) : 1,
        items: items.map((it) => ({
          children: parseInline(it.head),
          blocks: depth < 8 ? parseLines(it.rest, depth + 1) : [],
        })),
      });
      continue;
    }

    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && (lines[i] ?? "").trim() !== "" && !startsBlock(lines, i)) {
      para.push((lines[i] ?? "").trim());
      i++;
    }
    blocks.push({ type: "paragraph", children: parseInline(para.join("\n")) });
  }
  return blocks;
}

/** Markdown を構文木にする */
export function parseMarkdown(src: string): Block[] {
  return parseLines(src.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"), 0);
}
