import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { reviewCheckGuide } from "@/lib/ops/review-check-guide";
import { EMPTY_REVIEW, REVIEW_CHECKS, type ReviewCheckKey } from "@/lib/ops/review-draft-types";
import { ReviewCheckGuidance, ReviewChecklist } from "./review-checklist";

const props = {
  values: EMPTY_REVIEW,
  locked: false,
  canOpen: true,
  readOnly: false,
  idPrefix: "review-check",
  onChange: vi.fn(),
  onOpen: vi.fn(),
};
const render = (changes: Partial<Parameters<typeof ReviewChecklist>[0]> = {}) =>
  renderToStaticMarkup(createElement(ReviewChecklist, { ...props, ...changes }));
it("メモの文章ではなく実際のチェックだけを数え、未確認件数を表示する", () => {
  expect(render()).toContain("0 / 5項目を確認済み");
  expect(render()).toContain("あと5項目");
  const partial = { ...EMPTY_REVIEW, note: "5項目すべて確認済み", company: true, rights: true };
  expect(render({ values: partial })).toContain("2 / 5項目を確認済み");
  expect(render({ values: partial })).toContain("あと3項目");
  const complete = { ...partial, devices: true, links: true, continuity: true };
  expect(render({ values: complete })).toContain("5 / 5項目を確認済み");
  expect(render({ values: complete })).not.toContain("あと0項目");
});
it("確認先ボタンをチェックラベルから分け、閲覧専用でも確認資料を開ける", () => {
  const html = render({ locked: true, readOnly: true });
  expect(html).toContain("この版の確認記録を表示しています");
  expect(html.match(/type="checkbox" disabled=""/g)).toHaveLength(5);
  expect(html.match(/<\/label><button type="button"/g)).toHaveLength(5);
  for (const [key, title] of REVIEW_CHECKS) {
    expect(html).toContain(`id="review-check-${key}"`);
    expect(html).toContain(`for="review-check-${key}"`);
    expect(html).toContain(`aria-label="確認先：${title}"`);
  }
  expect(html).not.toMatch(/class="review-check-open" disabled/);
  expect(render({ canOpen: false }).match(/class="review-check-open" disabled=""/g)).toHaveLength(5);
});
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child) ? [child, ...elements(child.props.children as ReactNode)] : [],
  );
}
it("確認先を開いてもチェックを変更するハンドラーを呼ばず、自動確認しない", () => {
  const onOpen = vi.fn(),
    onChange = vi.fn();
  const buttons = elements(ReviewChecklist({ ...props, onOpen, onChange })).filter(
    (element) => element.type === "button",
  );
  for (const button of buttons) (button.props.onClick as () => void)();
  expect(onOpen.mock.calls.map(([key]) => key)).toEqual(REVIEW_CHECKS.map(([key]) => key));
  expect(onChange).not.toHaveBeenCalled();
  expect(REVIEW_CHECKS.every(([key]) => !props.values[key])).toBe(true);
});
it("各確認項目を該当資料へ結び、制作元画像がないときはサイト比較へ案内する", () => {
  for (const [key, tab] of [
    ["company", "assets"],
    ["rights", "assets"],
    ["devices", "design"],
    ["links", "compare"],
    ["continuity", "proposal"],
  ] as const)
    expect(reviewCheckGuide(key, true).tab).toBe(tab);
  expect(reviewCheckGuide("devices", false).tab).toBe("compare");
});
it("制作サイトがないときは表示・導線の未確認を案内し、該当チェックへ戻れる", () => {
  for (const [key] of REVIEW_CHECKS) {
    const renderGuide = (hasDemo: boolean) =>
      renderToStaticMarkup(
        createElement(ReviewCheckGuidance, {
          check: key as ReviewCheckKey,
          hasDesign: true,
          hasDemo,
          returnTargetId: `review-check-${key}-row`,
        }),
      );
    expect(renderGuide(false)).toContain(`href="#review-check-${key}-row"`);
    expect(renderGuide(false).includes("制作サイトのプレビューがありません")).toBe(
      key === "devices" || key === "links",
    );
    expect(renderGuide(true)).not.toContain("制作サイトのプレビューがありません");
  }
});
