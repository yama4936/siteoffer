import type { ReactNode } from "react";
import { type Block, type Inline, parseMarkdown } from "@/lib/sales/markdown";

/** 文書の見た目（Tailwind の typography プラグインは使わず、要素ごとに当てる） */
const PROSE = [
  "break-words text-[15px] leading-relaxed",
  "[&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:border-b [&_h2]:pb-2 [&_h2]:font-semibold [&_h2]:text-xl [&_h2]:tracking-tight",
  "[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:border-primary/60 [&_h3]:border-l-4 [&_h3]:pl-3 [&_h3]:font-semibold [&_h3]:text-lg",
  "[&_h4]:mt-5 [&_h4]:mb-1.5 [&_h4]:font-semibold [&_h5]:mt-4 [&_h5]:font-semibold [&_h6]:mt-4 [&_h6]:font-semibold",
  "[&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1",
  "[&_blockquote]:my-4 [&_blockquote]:rounded-r-md [&_blockquote]:border-warning [&_blockquote]:border-l-4 [&_blockquote]:bg-warning/10 [&_blockquote]:px-4 [&_blockquote]:py-2",
  "[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-sm",
  "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em]",
  "[&_hr]:my-6 [&_hr]:border-t [&_strong]:font-semibold",
  "[&_table]:w-full [&_table]:text-sm [&_th]:bg-muted/60 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium [&_td]:border-t [&_td]:px-3 [&_td]:py-2 [&_td]:align-top",
].join(" ");

/**
 * 改良資料（proposal.md）の表示。HTML 文字列を挿入せず React 要素だけで描くため、
 * Markdown 内の生 HTML は文字として表示される（XSS 対策）。
 */
export function MarkdownView({ source }: { source: string }) {
  return <div className={PROSE}>{renderBlocks(parseMarkdown(source))}</div>;
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
          <p key={key} className="whitespace-pre-line">
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
          <div key={key} className="my-4 overflow-x-auto rounded-lg border">
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
