import type {
  assignments,
  auditRequests,
  companies,
  contracts,
  deliveries,
  designVersions,
  proposalVersions,
  siteAudits,
} from "@siteoffer/db";
import {
  ASSIGNMENT_STATUS_LABEL,
  CONTRACT_STATUS_LABEL,
  DELIVERY_STATUS_LABEL,
  OFFICIAL_SITE_LABEL,
  PROPOSAL_STATUS_LABEL,
  SUPPRESSION_LABEL,
} from "./format";

export type CompanyJourneyFacts = {
  company: Pick<typeof companies.$inferSelect, "id" | "suppression" | "pipelineStatus" | "officialSiteStatus">;
  siteUsable: boolean;
  audit: Pick<typeof siteAudits.$inferSelect, "id" | "status" | "decision"> | null;
  request: Pick<typeof auditRequests.$inferSelect, "status"> | null;
  design:
    | (Pick<typeof designVersions.$inferSelect, "id" | "auditId" | "status" | "version"> & {
        hasImage: boolean;
        buildRequested: boolean;
      })
    | null;
  proposal: (Pick<typeof proposalVersions.$inferSelect, "id" | "status" | "version"> & { hasDocument: boolean }) | null;
  handoff: boolean;
  pipelinePending: boolean;
  offer: boolean;
  assignment: (Pick<typeof assignments.$inferSelect, "id" | "status"> & { expired: boolean }) | null;
  contract: Pick<typeof contracts.$inferSelect, "id" | "status"> | null;
  delivery: Pick<typeof deliveries.$inferSelect, "id" | "status"> | null;
  checkedAt: string;
};
const designLabels = {
  draft: "画像の取り込み待ち",
  queued: "画像生成の開始待ち",
  generating: "画像生成中",
  in_review: "画像の確認待ち",
  approved: "画像の承認済み",
  rejected: "画像の差し戻し",
  failed: "画像生成の失敗",
};
const auditLabels = {
  queued: "開始待ち",
  collecting: "サイト取得中",
  scoring: "採点中",
  evaluated: "診断済み",
  unevaluable: "評価不能",
  failed: "診断の失敗",
};
export function companyJourneyState(f: CompanyJourneyFacts) {
  const id = f.company.id,
    local = `/ops/companies/${id}`,
    processing = `/ops/processing?company=${id}`;
  const design = f.design
    ? `/ops/designs?company=${id}&design=${f.design.id}&audit=${f.design.auditId}`
    : `/ops/designs?company=${id}&design=new&audit=${f.audit?.id ?? "none"}`;
  const review = `/ops/review?company=${id}${f.proposal ? `&version=${f.proposal.id}` : ""}`;
  const sales = f.contract
    ? `/ops/contracts?focus=${f.contract.id}`
    : f.assignment
      ? `/ops/assignments?focus=${f.assignment.id}`
      : `/ops/review/ready?company=${id}`;
  const delivery = f.delivery
    ? `/ops/delivery?focus=${f.delivery.id}`
    : f.contract?.status === "completed"
      ? `/ops/delivery?contract=${f.contract.id}`
      : null;
  const next = (key: string, title: string, description: string, action: string, href: string, waiting = false) => ({
    key,
    title,
    description,
    action,
    href,
    waiting,
  });
  let current: ReturnType<typeof next>;
  if (f.contract) {
    if (f.contract.status !== "completed")
      current = next(
        "contract",
        "成約報告の内容を確認",
        "営業からの報告は契約完了とは別です。対象の契約を開き、内容と条件を確認してください。",
        "この契約を確認",
        sales,
      );
    else if (f.delivery)
      current = next(
        "delivery",
        ["published", "delivered"].includes(f.delivery.status)
          ? "公開後の運用と納品状況を確認"
          : "契約済みの案件を納品へ進める",
        `納品の現在の状態は「${DELIVERY_STATUS_LABEL[f.delivery.status]}」です。対象の制作・顧客確認・公開記録を確認してください。`,
        "この納品を開く",
        delivery!,
        f.delivery.status === "building" || f.delivery.status === "customer_review",
      );
    else
      current = next(
        "delivery",
        "契約済みの案件の制作を準備",
        "契約内容を引き継ぎ、素材・記事・ドメイン希望を確認して納品制作を開始します。",
        "この契約から制作を準備",
        delivery!,
      );
  } else if (f.company.suppression !== "none")
    current = next(
      "suppression",
      "営業抑止の対応方針を確認",
      `現在は「${SUPPRESSION_LABEL[f.company.suppression]}」です。新しい制作や営業へ進めず、企業の希望と現在の対応を確認してください。`,
      "企業の抑止情報を確認",
      `${local}#company-policy`,
    );
  else if (f.assignment)
    current = next(
      "assignment",
      f.assignment.expired || f.assignment.status === "awaiting_ops"
        ? "担当の期限・引き継ぎを確認"
        : "営業担当の進捗を確認",
      f.assignment.expired
        ? "担当の期限を過ぎています。現在の状態を確認し、重ねて営業を始めないでください。"
        : "既に営業の担当があります。新しい初回診断へ戻す前に、対象の担当と相談・契約の進捗を確認してください。",
      "この担当を確認",
      sales,
    );
  else if (f.company.pipelineStatus === "sellable" && f.offer)
    current = next(
      "sales",
      "営業へ引き継いだ条件を確認",
      "営業向けの条件版が保存されています。現在の提案と条件、担当状況を確認できます。",
      "営業への引き継ぎを確認",
      sales,
    );
  else if (f.proposal) {
    if (f.proposal.status === "approved")
      current = next(
        "sales",
        "販売条件を確認して営業へ引き継ぐ",
        "提案の承認は完了しています。販売・報酬条件と企業の状態を確認して、営業に使う条件を確定してください。",
        "販売条件と引き継ぎを確認",
        sales,
      );
    else if (f.proposal.status === "generating")
      current = next(
        "proposal",
        "サイト制作の受付・実行状態を確認",
        "制作中の提案版があります。依頼を重ねず、処理状況で現在の状態を確認してください。",
        "この会社の処理状況を確認",
        processing,
        true,
      );
    else
      current = next(
        "proposal",
        f.proposal.status === "in_review" ? "完成したサイトと提案をレビュー" : "制作結果と修正内容を確認",
        `最新の提案は第${f.proposal.version}版・${PROPOSAL_STATUS_LABEL[f.proposal.status]}です。表示・内容・機能を確認する画面へ進みます。`,
        "この提案版を確認",
        review,
      );
  } else if (f.design)
    current = next(
      "design",
      f.design.status === "approved" ? "承認画像からのサイト制作を確認" : "デザイン画像と制作条件を確認",
      `最新の画像案は第${f.design.version}版・${designLabels[f.design.status]}です。選んだ画像案の制作条件・PDF・承認・制作の操作へ進みます。`,
      "この画像案を開く",
      design,
      ["queued", "generating"].includes(f.design.status) || (f.design.status === "approved" && f.design.buildRequested),
    );
  else if (f.handoff)
    current = next(
      "handoff",
      "診断後の制作受付を確認",
      "診断から制作への受付が残っています。処理状況で引き継ぎと再送の状態を確認してください。",
      "制作受付の状況を確認",
      processing,
      true,
    );
  else if (f.pipelinePending)
    current = next(
      "pipeline",
      "受付済みの診断・制作を確認",
      "診断または制作の実行待ち・再試行中の依頼があります。新しい依頼を重ねず、処理状況を確認してください。",
      "この会社の処理状況を確認",
      processing,
      true,
    );
  else if (f.request || (f.audit && ["queued", "collecting", "scoring"].includes(f.audit.status)))
    current = next(
      "audit",
      "診断の受付・実行状態を確認",
      "診断の受付または処理中の記録があります。重ねて依頼せず、処理状況で結果と停止理由を確認してください。",
      "診断の処理状況を確認",
      `${processing}#audit-requests`,
      true,
    );
  else if (["generated", "in_review", "sellable"].includes(f.company.pipelineStatus))
    current = next(
      "records",
      "進行状態と制作記録を照合",
      "企業の準備段階は先へ進んでいますが、対応する提案や画像案を確認できません。初回診断を重ねず、処理履歴と保存済み記録を確認してください。",
      "この会社の処理状況を確認",
      processing,
    );
  else if (f.audit?.status === "evaluated" && f.audit.decision === "create")
    current = next(
      "design",
      "診断結果からデザインを準備",
      "改善提案を作成する判定の診断があります。まず画像で方向性をそろえ、提案PDFとサイト制作へ進みます。",
      "この診断からデザインを準備",
      design,
    );
  else if (f.audit)
    current = next(
      "audit",
      "診断結果と制作の判定を確認",
      f.audit.status === "evaluated"
        ? f.audit.decision === "skip"
          ? "提案を作成しない判定です。必要性と根拠を確認し、制作を自動で進めないでください。"
          : "制作の判定が保留または未確定です。評価の根拠と設定を確認してください。"
        : "診断を完了できていません。保存済み結果の再利用と停止理由を確認してください。",
      "診断結果を確認",
      `${local}#company-audit`,
    );
  else if (f.company.officialSiteStatus !== "confirmed" || !f.siteUsable)
    current = next(
      "site",
      "診断する公式サイトを確認",
      f.siteUsable
        ? "候補のURLがこの会社の公式サイトか確認し、主サイトと確度を設定してください。"
        : "診断に使える公開HTTP/HTTPSの公式サイトが必要です。登録済みのサイトと出典・収集設定を確認してください。",
      "公式サイトと出典を確認",
      `${local}#company-site`,
    );
  else
    current = next(
      "audit",
      "確認済みの公式サイトの診断へ",
      "公式サイトの確認が済んでいます。診断の依頼画面で対象URLと受付条件を確認してください。",
      "診断の依頼を確認",
      `${local}#audit-request`,
    );
  const cards = [
    {
      key: "site",
      label: "公式サイト",
      value: f.siteUsable ? OFFICIAL_SITE_LABEL[f.company.officialSiteStatus] : "対象URLを確認",
      href: `${local}#company-site`,
    },
    {
      key: "audit",
      label: "診断",
      value: f.request
        ? "診断の受付あり"
        : f.audit
          ? `${auditLabels[f.audit.status]}${f.audit.status === "evaluated" ? `・${f.audit.decision === "create" ? "制作対象" : f.audit.decision === "skip" ? "対象外" : "判定保留"}` : ""}`
          : "記録なし",
      href: `${local}#company-audit`,
    },
    {
      key: "design",
      label: "デザイン画像",
      value: f.design ? `第${f.design.version}版・${designLabels[f.design.status]}` : "記録なし",
      href: design,
    },
    {
      key: "proposal",
      label: "提案レビュー",
      value: f.proposal ? `第${f.proposal.version}版・${PROPOSAL_STATUS_LABEL[f.proposal.status]}` : "記録なし",
      href: review,
    },
    {
      key: "sales",
      label: "営業・契約",
      value: f.contract
        ? CONTRACT_STATUS_LABEL[f.contract.status]
        : f.assignment
          ? ASSIGNMENT_STATUS_LABEL[f.assignment.status]
          : f.offer
            ? "営業向け条件の記録あり"
            : "記録なし",
      href: sales,
    },
    {
      key: "delivery",
      label: "納品・公開",
      value: f.delivery ? DELIVERY_STATUS_LABEL[f.delivery.status] : "記録なし",
      href: delivery,
    },
  ];
  return {
    companyId: id,
    checkedAt: f.checkedAt,
    next: current,
    cards,
    notice:
      f.company.suppression !== "none"
        ? `営業抑止：${SUPPRESSION_LABEL[f.company.suppression]}。契約・納品の対応と新しい営業は分けて確認してください。`
        : null,
    documents: {
      design: f.design?.hasImage ? `/ops/designs/${f.design.id}/pdf` : null,
      proposal: f.proposal?.hasDocument ? `/ops/proposals/${f.proposal.id}/pdf` : null,
    },
  };
}
