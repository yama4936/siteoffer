import {
  createDeliveryForContract,
  fixedClock,
  hasPublishedSite,
  loadArticleWorkspace,
  publishArticle,
  saveArticle,
  saveArticleWorkingCopy,
} from "@siteoffer/core";
import { deliveries } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { type ArticlePublicationStatus, articlePublicationLabel } from "@/lib/article-publication-status";
import { seedDeliveryBase } from "../../../../packages/core/src/delivery/test-helpers.ts";
import { ArticlePublication } from "./article-publication";

const base = {
  companyId: "79e812e5-cfe3-4dbb-ad7c-7042341a0cc9",
  slug: "saved-article",
  audience: "ops" as const,
  publicSite: false,
  currentRevision: 2,
  publishedRevision: 1,
  publicationRevision: 1,
};
const render = (changes: Partial<Parameters<typeof ArticlePublication>[0]> = {}) =>
  renderToStaticMarkup(createElement(ArticlePublication, { ...base, ...changes }));

it("サイト公開前の掲載設定と公開後の状態、下書きの変更・掲載停止を区別する", () => {
  const states: [Partial<ArticlePublicationStatus>, string][] = [
    [{ publishedRevision: null, publicationRevision: 0 }, "未掲載"],
    [{ publishedRevision: null, publicationRevision: 2 }, "掲載停止"],
    [{ currentRevision: 1 }, "掲載準備済み"],
    [{}, "掲載準備済み・変更あり"],
    [{ publicSite: true, currentRevision: 1 }, "掲載中"],
    [{ publicSite: true }, "掲載中・変更あり"],
  ];
  for (const [changes, label] of states) expect(articlePublicationLabel({ ...base, ...changes })).toBe(label);
});
it("未公開サイトでも選んだ記事の掲載予定を直接開け、顧客と運営の権限経路を分ける", () => {
  for (const audience of ["ops", "customer"] as const) {
    const html = render({ audience });
    expect(html).toContain(`href="/${audience}/content/${base.companyId}/preview?article=saved-article"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("掲載予定の内容を確認");
    expect(html).toContain("第1版を掲載する設定です。サイトはまだ未公開です。");
    expect(html).toContain("共有下書きの第2版は、まだ掲載内容に反映していません。");
    expect(html).not.toContain('href="/published/');
    if (audience === "customer") expect(html).not.toContain('href="/ops/');
  }
});
it("サイト公開後はその記事の一般公開URLも開け、共有下書きを公開版と呼ばない", () => {
  const html = render({ publicSite: true });
  expect(html).toContain(`href="/published/${base.companyId}/news?article=saved-article"`);
  expect(html).toContain("公開中の記事を開く");
  expect(html).toContain("第1版を掲載しています。");
  expect(html).not.toContain("第2版を掲載しています。");
  expect(render({ publicSite: true, currentRevision: 1 })).not.toContain("変更あり");
});
it("未掲載・掲載停止の記事には存在しない記事プレビューや一般公開のリンクを出さない", () => {
  for (const publicSite of [false, true]) {
    for (const publicationRevision of [0, 2]) {
      const html = render({ publicSite, publishedRevision: null, publicationRevision });
      expect(html).not.toContain("?article=");
      expect(html).not.toContain("<a ");
      expect(html).toContain(publicationRevision === 0 ? "まだ掲載していません" : "掲載を停止しています");
    }
  }
});
it("実際の保存・掲載・下書き変更・サイト公開・掲載停止から、確認先と状態を切り替える", async () => {
  const { db, close } = await createTestDb();
  try {
    const f = await seedDeliveryBase(db),
      clock = fixedClock("2026-10-19T02:00:00Z");
    const delivery = await createDeliveryForContract(db, clock, f.ops, f.contract.id);
    if (!delivery.ok) throw Error(delivery.error);
    const input = {
      companyId: f.company.id,
      slug: "published-first",
      title: "掲載版",
      body: "掲載本文",
      category: "news",
    };
    const entry = await saveArticle(db, clock, f.ops, input);
    const scope = { companyId: f.company.id, entryId: entry.id };
    const read = async () => {
      const workspace = await loadArticleWorkspace(db, f.ops, scope);
      return render({
        companyId: workspace.scope.companyId,
        slug: workspace.current.slug,
        currentRevision: Number(workspace.current.baseRevision),
        publishedRevision: workspace.publishedRevision,
        publicationRevision: workspace.publicationRevision,
        publicSite: await hasPublishedSite(db, f.company.id),
      });
    };
    expect(await read()).toContain("まだ掲載していません");
    await publishArticle(db, clock, f.ops, {
      ...scope,
      revision: 1,
      expectedRevision: 1,
      expectedPublicationRevision: 0,
    });
    expect(await read()).toContain("掲載準備済み");
    await saveArticleWorkingCopy(db, clock, f.ops, scope, 0, {
      slug: input.slug,
      category: input.category,
      title: "PRIVATE-COPY-TITLE",
      body: "PRIVATE-COPY-BODY",
      baseRevision: "1",
    });
    await saveArticle(db, clock, f.ops, {
      ...input,
      entryId: entry.id,
      expectedRevision: 1,
      title: "SHARED-DRAFT-TITLE",
    });
    const prepared = await read();
    expect(prepared).toContain("共有下書きの第2版は、まだ掲載内容に反映していません。");
    expect(prepared).not.toMatch(/PRIVATE-COPY|SHARED-DRAFT-TITLE/);
    expect(prepared).toContain("preview?article=published-first");
    expect(prepared).not.toContain('href="/published/');
    // Synthetic database only; no real site or normal application record is published.
    await db.update(deliveries).set({ status: "published" }).where(eq(deliveries.id, delivery.value.delivery.id));
    expect(await read()).toContain(`/published/${f.company.id}/news?article=published-first`);
    await publishArticle(db, clock, f.ops, {
      ...scope,
      revision: 2,
      expectedRevision: 2,
      expectedPublicationRevision: 1,
    });
    expect(await read()).toContain("第2版を掲載しています。");
    expect(await read()).not.toContain("変更あり");
    await publishArticle(db, clock, f.ops, {
      ...scope,
      revision: null,
      expectedRevision: 2,
      expectedPublicationRevision: 2,
    });
    const stopped = await read();
    expect(stopped).toContain("掲載停止");
    expect(stopped).not.toContain("?article=");
    expect((await loadArticleWorkspace(db, f.ops, scope)).copy.values?.title).toBe("PRIVATE-COPY-TITLE");
  } finally {
    await close();
  }
});
