import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { type ActivityHistoryPage, DEFAULT_ACTIVITY_HISTORY } from "@/lib/activity-history-types";
import { ActivityHistory } from "./activity-history";
import { preservesActivityHistory } from "./sales/activity-history-navigation";

const assignmentId = "79e812e5-cfe3-4dbb-ad7c-7042341a0cc9";
const page: ActivityHistoryPage = {
  assignment: {
    id: assignmentId,
    companyId: "company",
    companyName: "架空企業",
    salesName: "架空営業",
    status: "working",
  },
  filters: DEFAULT_ACTIVITY_HISTORY,
  items: [
    {
      id: "activity",
      kind: "negotiating",
      occurredAt: "2026-10-19T03:00:00Z",
      note: "<script>unsafe()</script>",
      nextActionAt: null,
      nextActionMode: "clear",
      consultOps: true,
    },
  ],
  total: 1,
  allTotal: 1,
  pageCount: 1,
  pageSize: 20,
  hasConsultations: true,
  latestNote: "<script>unsafe()</script>",
};
afterEach(() => vi.unstubAllGlobals());
it("検索・活動種別・相談と件数を表示し、メモのHTMLを実行しない", () => {
  const html = renderToStaticMarkup(createElement(ActivityHistory, { initial: page }));
  expect(html).toContain('<search aria-label="活動履歴を検索">');
  expect(html).toContain(`data-activity-history="${assignmentId}"`);
  expect(html).toContain("1件 / 全1件");
  expect(html).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("次回対応日を解除しました");
  expect(html).toContain("/sales/consultations?focus=activity");
});
it("運営は運営の相談画面へ進め、記録なしと検索結果なしを区別する", () => {
  expect(renderToStaticMarkup(createElement(ActivityHistory, { initial: page, audience: "ops" }))).toContain(
    "/ops/consultations?focus=activity",
  );
  expect(
    renderToStaticMarkup(createElement(ActivityHistory, { initial: { ...page, items: [], total: 0, allTotal: 0 } })),
  ).toContain("活動の記録はまだありません");
  expect(renderToStaticMarkup(createElement(ActivityHistory, { initial: { ...page, items: [], total: 0 } }))).toContain(
    "条件に合う記録がありません",
  );
});
it("同じ案件内の履歴検索だけ移動確認を省き、別案件・外部・一般のフォームは保護する", () => {
  class Form {
    method = "get";
    action = `http://localhost:3100/sales/assignments/${assignmentId}`;
    dataset: { activityHistory?: string } = { activityHistory: assignmentId };
  }
  vi.stubGlobal("HTMLFormElement", Form);
  vi.stubGlobal("window", {
    location: { origin: "http://localhost:3100", href: `http://localhost:3100/sales/assignments/${assignmentId}` },
  });
  const check = (target: Form) => preservesActivityHistory(target as unknown as HTMLFormElement, assignmentId);
  expect(check(new Form())).toBe(true);
  const other = new Form();
  other.dataset.activityHistory = "other";
  expect(check(other)).toBe(false);
  const external = new Form();
  external.action = `https://external.example.test/sales/assignments/${assignmentId}`;
  expect(check(external)).toBe(false);
  const different = new Form();
  different.action = "http://localhost:3100/sales/assignments/other";
  expect(check(different)).toBe(false);
  const post = new Form();
  post.method = "post";
  expect(check(post)).toBe(false);
  const ordinary = new Form();
  ordinary.dataset = {};
  expect(check(ordinary)).toBe(false);
  expect(preservesActivityHistory({} as HTMLAnchorElement, assignmentId)).toBe(false);
});
