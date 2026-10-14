// 改良資料用の簡易 Markdown 解析のテスト
import { describe, expect, it } from "vitest";
import { type Block, parseInline, parseMarkdown, safeHref } from "./markdown.ts";

describe("parseMarkdown", () => {
  it("見出し・段落・引用・表・リストを解析する", () => {
    const blocks = parseMarkdown(
      [
        "# Webサイト改善提案書：架空工務店",
        "",
        "> この資料は**非公式**の改善提案です。",
        "",
        "| 項目 | 値 |",
        "| --- | --- |",
        "| 総合点 | 48 / 100 |",
        "",
        "- 一つ目",
        "  - 入れ子",
        "- 二つ目",
        "",
        "1. 手順",
        "2. 次の手順",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.type)).toEqual(["heading", "blockquote", "table", "list", "list"]);
    const table = blocks[2] as Extract<Block, { type: "table" }>;
    expect(table.header).toHaveLength(2);
    expect(table.rows[0]?.[1]).toEqual([{ type: "text", text: "48 / 100" }]);
    const list = blocks[3] as Extract<Block, { type: "list" }>;
    expect(list.items).toHaveLength(2);
    expect(list.items[0]?.blocks[0]?.type).toBe("list");
    const ol = blocks[4] as Extract<Block, { type: "list" }>;
    expect(ol.ordered).toBe(true);
  });

  it("生 HTML は文字のまま残す（要素として解釈しない）", () => {
    const blocks = parseMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">');
    expect(blocks).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "<script>alert(1)</script>" }] },
      { type: "paragraph", children: [{ type: "text", text: '<img src=x onerror="alert(1)">' }] },
    ]);
  });

  it("コードブロックの中身は解析しない", () => {
    expect(parseMarkdown("```\n# 見出しではない\n**太字ではない**\n```")).toEqual([
      { type: "code", text: "# 見出しではない\n**太字ではない**" },
    ]);
  });
});

describe("リンク", () => {
  it("http(s)・mailto だけをリンクにする", () => {
    expect(parseInline("[サイト](https://example.test/)")).toEqual([
      { type: "link", href: "https://example.test/", children: [{ type: "text", text: "サイト" }] },
    ]);
    expect(parseInline("[x](javascript:alert(1))")[0]?.type).not.toBe("link");
    expect(parseInline("[評価](evaluation.md)")).toEqual([{ type: "text", text: "評価" }]);
    expect(safeHref("JAVASCRIPT:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("mailto:info@example.test")).toBe("mailto:info@example.test");
  });

  it("強調・斜体・インラインコード", () => {
    expect(parseInline("**強調** と *斜体* と `code`")).toEqual([
      { type: "strong", children: [{ type: "text", text: "強調" }] },
      { type: "text", text: " と " },
      { type: "em", children: [{ type: "text", text: "斜体" }] },
      { type: "text", text: " と " },
      { type: "code", text: "code" },
    ]);
  });
});
