import type { ReactNode } from "react";
import { type Block, type Inline, parseMarkdown } from "@/lib/sales/markdown";

/**
 * 改良資料（proposal.md）の表示。HTML 文字列を挿入せず React 要素だけで描くため、
 * Markdown 内の生 HTML は文字として表示される（XSS 対策）。
 */
export function MarkdownView({ source }: { source: string }) {
  return <div className="markdown">{renderBlocks(parseMarkdown(source))}</div>;
}

function renderInlines(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${n.type}-${i}`;
    switch (n.type) {
      case "text":
        return n.text;
      case "strong":
        return <strong key={key}>{renderInlines(n.children)}</strong>;
      case "em":
        return <em key={key}>{renderInlines(n.children)}</em>;
      case "code":
        return <code key={key}>{n.text}</code>;
      case "link":
        return (
          <a key={key} href={n.href} target="_blank" rel="noopener noreferrer">
            {renderInlines(n.children)}
          </a>
        );
    }
    return null;
  });
}

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((b, i) => {
    const key = `${b.type}-${i}`;
    switch (b.type) {
      case "heading": {
        // ページの h1（企業名）と重ならないよう1段下げる
        const H = `h${Math.min(6, b.level + 1) as 2 | 3 | 4 | 5 | 6}` as const;
        return <H key={key}>{renderInlines(b.children)}</H>;
      }
      case "paragraph":
        return (
          <p key={key} style={{ whiteSpace: "pre-line" }}>
            {renderInlines(b.children)}
          </p>
        );
      case "list": {
        const items = b.items.map((it, k) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静的な文書の並びで、順序は変わらない
          <li key={k}>
            {renderInlines(it.children)}
            {renderBlocks(it.blocks)}
          </li>
        ));
        return b.ordered ? (
          <ol key={key} start={b.start}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        );
      }
      case "table":
        return (
          <div key={key} className="table-wrap">
            <table>
              <thead>
                <tr>
                  {b.header.map((c, k) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 表の列は順序で決まる
                    <th key={k}>{renderInlines(c)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, k) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 表の行は順序で決まる
                  <tr key={k}>
                    {r.map((c, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: 表の列は順序で決まる
                      <td key={j}>{renderInlines(c)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "blockquote":
        return <blockquote key={key}>{renderBlocks(b.blocks)}</blockquote>;
      case "code":
        return (
          <pre key={key}>
            <code>{b.text}</code>
          </pre>
        );
      case "hr":
        return <hr key={key} />;
    }
    return null;
  });
}
