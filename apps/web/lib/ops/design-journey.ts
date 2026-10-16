import type { designVersions, proposalVersions } from "@siteoffer/db";

type Design = Pick<typeof designVersions.$inferSelect, "id" | "status" | "imageSha256" | "buildRequestedAt">;
type Proposal = Pick<typeof proposalVersions.$inferSelect, "id" | "status" | "version">;
export type DesignJourneyInput = {
  companyId: string;
  canCreate: boolean;
  configured: boolean;
  design?: Design;
  proposal?: Proposal;
};
export const DESIGN_STEPS = ["制作条件", "画像を用意", "画像を確認", "サイトを制作", "提案を引き継ぐ"] as const;
export function designJourney({ companyId, canCreate, configured, design: d, proposal: p }: DesignJourneyInput) {
  const company = `/ops/companies/${companyId}`;
  const review = `/ops/review?${new URLSearchParams({ company: companyId, ...(p ? { version: p.id } : {}) })}`;
  const state = (step: number, title: string, description: string, action: string, href: string, waiting = false) => ({
    step,
    title,
    description,
    action,
    href,
    waiting,
  });
  if (!d) {
    if (!canCreate)
      return state(
        0,
        "まず、企業の診断結果を確認",
        "改善提案の対象になった診断が必要です。企業情報と診断を確認してから、制作条件を保存してください。",
        "企業情報・診断を見る",
        company,
      );
    return state(
      0,
      "制作条件から最初の画像案を用意",
      configured
        ? "目的・顧客像・雰囲気を入力して画像を生成するか、用意した画像を取り込む版を作成します。"
        : "制作条件を保存して「画像を取り込む版を作成」へ進みます。次に用意した画像をアップロードできます。",
      "制作条件を入力",
      "#design-brief",
    );
  }
  if (d.status === "draft")
    return state(
      1,
      "用意したデザイン画像を取り込む",
      "制作条件はこの版に保存済みです。画像を取り込むと、デザイン提案PDFの出力と承認へ進めます。",
      "画像を選ぶ",
      "#design-upload",
    );
  if (["queued", "generating"].includes(d.status))
    return state(
      1,
      d.status === "queued" ? "画像生成の開始待ち" : "デザイン画像を生成中",
      "完了するとこの画面に画像が表示されます。画面を閉じても処理の依頼は残ります。長く変わらない場合は企業情報の処理履歴を確認してください。",
      "企業情報・処理履歴を見る",
      company,
      true,
    );
  if (d.status === "failed" || d.status === "rejected")
    return state(
      1,
      d.status === "failed" ? "画像生成の結果を確認して再作成" : "修正指示を反映して新しい画像案へ",
      "下のエラー・確認メモと制作条件を確認し、新しい版を作成してください。過去の画像と承認記録は残ります。",
      "制作条件を見直す",
      "#design-brief",
    );
  if (d.status === "in_review")
    return state(
      2,
      "画像案を確認して制作へ進める",
      "画像の文言・利用権・PCとスマホの構成を確認します。方向性の相談にはデザイン提案PDFを使えます。",
      "確認項目へ進む",
      "#design-review",
    );
  if (!d.buildRequestedAt && !p)
    return state(
      3,
      "承認した画像からサイトを制作",
      "画像の承認は完了しました。下の制作ボタンで、同じ画像と制作条件を使ったサイト制作を依頼します。",
      "サイト制作の操作へ",
      "#design-build",
    );
  if (!p || p.status === "generating")
    return state(
      3,
      "サイトを制作中・開始待ち",
      "依頼は受け付け済みです。完成したら提案レビューで表示・内容・機能を確認します。長く変わらない場合は処理履歴を確認してください。",
      "企業情報・処理履歴を見る",
      company,
      true,
    );
  if (p.status === "failed" || p.status === "rejected")
    return state(
      3,
      p.status === "failed" ? "制作に失敗しました。原因を確認" : "サイトの修正内容を確認",
      "提案レビューの結果を確認してください。下の「同じ承認画像で再制作」から、画像を生成し直さず新しい制作版を作れます。",
      "提案レビューで確認",
      review,
    );
  if (p.status === "in_review")
    return state(
      4,
      "完成したサイトをレビュー",
      "サイト制作が完了しました。表示・文言・機能を確認して承認すると、営業向けの提案PDFを出力できます。",
      "サイトと提案を確認",
      review,
    );
  return state(
    4,
    "承認済みの提案を営業へ引き継ぐ",
    "提案PDFを出力できます。営業可能にするには、提案レビューで販売条件と企業の状態も確認してください。",
    "販売条件・営業への引き継ぎを確認",
    review,
  );
}
