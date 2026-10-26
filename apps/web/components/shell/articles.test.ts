import type { PublishedArticlesView } from "@siteoffer/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Articles } from "./articles";

const view: PublishedArticlesView = {
  kind: "article",
  article: {
    id: "entry",
    slug: "new-article",
    publishedAt: new Date("2026-10-19T00:00:00Z"),
    revision: 1,
    title: "掲載記事",
    body: "本文",
    category: "news",
    images: [],
  },
  filters: { page: 2, query: "古い記事", category: "news" },
};
const props = { companyId: "company", name: "架空企業", view, basePath: "/published/company/news" };
it("記事から会社トップと一覧へ戻れ、絞り込んだ一覧への導線も残す", () => {
  const html = renderToStaticMarkup(createElement(Articles, { ...props, homeUrl: "https://published.example.test/" }));
  expect(html).toContain('aria-label="サイト内の移動"');
  expect(html).toContain('href="https://published.example.test/"');
  expect(html).toContain("← トップページ");
  expect(html).toContain('href="/published/company/news"');
  expect(html).toContain("page=2");
  expect(html).toContain("category=news");
});
it("公開URLのない記事は戻り先を創作せず、プレビューでは公開サイトへの移動と分かる", () => {
  const without = renderToStaticMarkup(createElement(Articles, props));
  expect(without).not.toContain("トップページ");
  const preview = renderToStaticMarkup(
    createElement(Articles, { ...props, preview: true, homeUrl: "https://published.example.test/" }),
  );
  expect(preview).toContain("公開サイトのトップ");
  expect(preview).toContain("一般公開されていることを示す画面ではありません");
});
