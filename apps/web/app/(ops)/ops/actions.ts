"use server";

/**
 * 運営画面の Server Function。直接POSTでも呼べるため、権限は各処理（lib/ops/commands.ts → core）で判定する。
 * ここでは FormData を読み、処理を呼び、結果の文言を付けて元の画面へ戻すだけにする。
 */
import { type Actor, type PaymentTargetStatus, type Result, retryDeliveryBuild, systemClock } from "@siteoffer/core";
import { resumeAuditByOps } from "@siteoffer/worker/audit-recovery";
import { requestAuditByOps } from "@siteoffer/worker/audit-request";
import { refresh, revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import {
  adjustRewardByOps,
  cancelRewardByOps,
  confirmContractByOps,
  confirmDomainPreferenceByOps,
  createDiscoveryJobByOps,
  createImageAsset,
  createProductTermsVersion,
  excludeCandidate,
  extendAssignmentByOps,
  liftSuppressionByOps,
  makeSellable,
  markRewardPaidByOps,
  type OpsDeps,
  reactivateSalesUser,
  reassignAssignmentByOps,
  recordPaymentByOps,
  rejectContractByOps,
  releaseAssignmentByOps,
  retryDiscoveryJobByOps,
  reviewProposalVersion,
  scheduleRewardByOps,
  setOfficialSiteStatus,
  setProductTermsActive,
  startContractReviewByOps,
  suspendSalesUser,
  updateCandidate,
  updateImageAssetPolicy,
  updatePaymentStatusByOps,
  updateSetting,
  withdrawSellable,
} from "@/lib/ops/commands";
import {
  createDeliveryByOps,
  recordPublicationByOps,
  sendToCustomerReviewByOps,
  transitionDeliveryByOps,
} from "@/lib/ops/delivery";
import type { CustomerReviewLinkState } from "@/lib/ops/delivery-state";
import { jstDate, optInt, optStr, safeReturnTo, str, withFlash } from "@/lib/ops/form";
import { reviewLinkError } from "@/lib/ops/review-links";
import { getCurrentActor } from "@/lib/session";

async function run(
  fd: FormData,
  fn: (deps: OpsDeps, actor: Actor | null) => Promise<Result<unknown, string>>,
  okMessage: string,
): Promise<never> {
  const actor = await getCurrentActor();
  let r: Result<unknown, string>;
  try {
    r = await fn({ db: getDb(), clock: systemClock }, actor);
  } catch (e) {
    // 想定外の失敗（不正なIDによるDBエラー等）。詳細はサーバーのログにだけ残し、画面には出さない
    console.error("ops action failed", e);
    r = { ok: false, error: "unexpected", message: "処理に失敗しました。入力内容を確認してください" };
  }
  const back = safeReturnTo(fd.get("returnTo"));
  revalidatePath("/ops", "layout");
  redirect(withFlash(back, r.ok ? { msg: okMessage } : { error: r.message ? `${r.message}（${r.error}）` : r.error }));
}

// 1. 収集条件・ジョブ・候補

export async function createDiscoveryJobAction(fd: FormData) {
  const keywords = str(fd, "keywords")
    .split(/[,、\s]+/)
    .filter(Boolean);
  const limit = optInt(fd, "limit");
  const criteria = {
    prefecture: optStr(fd, "prefecture") ?? undefined,
    city: optStr(fd, "city") ?? undefined,
    cityCode: optStr(fd, "cityCode") ?? undefined,
    industry: optStr(fd, "industry") ?? undefined,
    keywords,
    limit: limit ?? undefined,
  };
  await run(
    fd,
    (d, a) => createDiscoveryJobByOps(d, a, { provider: str(fd, "provider"), criteria }),
    "稼働中の収集ワーカーを確認して登録しました。状態は自動更新されます。処理時間は取得元と件数によって変わります",
  );
}

export async function updateCandidateAction(fd: FormData) {
  await run(
    fd,
    (d, a) =>
      updateCandidate(d, a, {
        companyId: str(fd, "companyId"),
        patch: {
          name: str(fd, "name"),
          prefecture: optStr(fd, "prefecture"),
          city: optStr(fd, "city"),
          address: optStr(fd, "address"),
          addressSourceUrl: optStr(fd, "addressSourceUrl"),
          industry: optStr(fd, "industry"),
          representativePhone: optStr(fd, "representativePhone"),
        },
      }),
    "候補を修正しました",
  );
}

export async function setOfficialSiteStatusAction(fd: FormData) {
  await run(
    fd,
    (d, a) =>
      setOfficialSiteStatus(d, a, {
        companyId: str(fd, "companyId"),
        status: str(fd, "status") as Parameters<typeof setOfficialSiteStatus>[2]["status"],
        websiteId: optStr(fd, "websiteId"),
        note: str(fd, "note"),
      }),
    "公式サイトの確度を更新しました",
  );
}

export async function excludeCandidateAction(fd: FormData) {
  await run(
    fd,
    (d, a) =>
      excludeCandidate(d, a, {
        companyId: str(fd, "companyId"),
        kind: str(fd, "kind") as "excluded" | "existing_customer",
        reason: str(fd, "reason"),
      }),
    "候補を除外しました（再収集でも営業可能に戻りません）",
  );
}

export async function createImageAssetAction(fd: FormData) {
  await run(
    fd,
    (d, a) =>
      createImageAsset(d, a, {
        companyId: str(fd, "companyId"),
        label: str(fd, "label"),
        sourceType: str(fd, "sourceType") as Parameters<typeof createImageAsset>[2]["sourceType"],
        sourceUrl: optStr(fd, "sourceUrl"),
        note: str(fd, "note"),
      }),
    "画像素材を評価参照のみで登録しました",
  );
}

export async function updateImageAssetPolicyAction(fd: FormData) {
  await run(
    fd,
    (d, a) =>
      updateImageAssetPolicy(d, a, {
        companyId: str(fd, "companyId"),
        imageAssetId: str(fd, "imageAssetId"),
        rightsStatus: str(fd, "rightsStatus") as Parameters<typeof updateImageAssetPolicy>[2]["rightsStatus"],
        allowSalesDemo: fd.has("allowSalesDemo"),
        allowProduction: fd.has("allowProduction"),
        note: str(fd, "note"),
      }),
    "画像素材の権利状態と利用範囲を更新しました",
  );
}

// 2. 診断・生成・レビュー・営業可能化

export async function reviewProposalAction(fd: FormData) {
  const decision = str(fd, "decision") as "approved" | "rejected";
  await run(
    fd,
    (d, a) =>
      reviewProposalVersion(d, a, { proposalVersionId: str(fd, "proposalVersionId"), decision, note: str(fd, "note") }),
    decision === "approved" ? "提案版を承認しました" : "提案版を差し戻しました",
  );
}

export async function makeSellableAction(fd: FormData) {
  await run(
    fd,
    (d, a) => makeSellable(d, a, { companyId: str(fd, "companyId"), productTermsId: optStr(fd, "productTermsId") }),
    "営業可能にしました",
  );
}

export async function withdrawSellableAction(fd: FormData) {
  await run(
    fd,
    (d, a) => withdrawSellable(d, a, { companyId: str(fd, "companyId"), reason: str(fd, "reason") }),
    "営業可能を取り下げました",
  );
}

// 3. 担当状況・営業拒否・引き継ぎ

export async function releaseAssignmentAction(fd: FormData) {
  await run(
    fd,
    (d, a) => releaseAssignmentByOps(d, a, { assignmentId: str(fd, "assignmentId"), reason: str(fd, "reason") }),
    "担当を解除しました",
  );
}

export async function reassignAssignmentAction(fd: FormData) {
  await run(
    fd,
    (d, a) =>
      reassignAssignmentByOps(d, a, {
        assignmentId: str(fd, "assignmentId"),
        toUserId: str(fd, "toUserId"),
        reason: str(fd, "reason"),
      }),
    "担当を付け替えました",
  );
}

export async function extendAssignmentAction(fd: FormData) {
  const expiresAt = jstDate(fd, "expiresAt");
  const resume = optStr(fd, "resumeStatus") as "claimed" | "working" | "negotiating" | "contract_pending" | null;
  await run(
    fd,
    async (d, a) =>
      expiresAt
        ? extendAssignmentByOps(d, a, {
            assignmentId: str(fd, "assignmentId"),
            expiresAt,
            reason: str(fd, "reason"),
            ...(resume ? { resumeStatus: resume } : {}),
          })
        : { ok: false, error: "invalid_expiry", message: "期限を入力してください" },
    "期限を延長しました",
  );
}

export async function liftSuppressionAction(fd: FormData) {
  await run(
    fd,
    (d, a) => liftSuppressionByOps(d, a, { companyId: str(fd, "companyId"), reason: str(fd, "reason") }),
    "営業抑止を解除しました",
  );
}

// 4. 商品条件・契約確認・入金・報酬

export async function createProductTermsAction(fd: FormData) {
  const rewardType = str(fd, "rewardType");
  const rewardValue = optInt(fd, "rewardValue");
  const rewardRule =
    rewardType === "fixed" && rewardValue !== null
      ? { type: "fixed", amount: rewardValue }
      : rewardType === "rate" && rewardValue !== null
        ? { type: "rate", basisPoints: rewardValue }
        : null;
  await run(
    fd,
    (d, a) =>
      createProductTermsVersion(d, a, {
        version: str(fd, "version"),
        name: str(fd, "name"),
        scopeText: str(fd, "scope"),
        price: optInt(fd, "price"),
        monthlyFee: optInt(fd, "monthlyFee"),
        rewardRule,
      }),
    "販売条件・報酬条件の版を作成しました",
  );
}

export async function setProductTermsActiveAction(fd: FormData) {
  const active = str(fd, "active") === "true";
  await run(
    fd,
    (d, a) => setProductTermsActive(d, a, { productTermsId: str(fd, "productTermsId"), active }),
    active ? "版を有効にしました" : "版を無効にしました",
  );
}

export async function startContractReviewAction(fd: FormData) {
  await run(fd, (d, a) => startContractReviewByOps(d, a, str(fd, "contractId")), "契約資料の確認を開始しました");
}

export async function confirmContractAction(fd: FormData) {
  const productTermsId = optStr(fd, "productTermsId");
  const documentRef = optStr(fd, "documentRef");
  await run(
    fd,
    (d, a) =>
      confirmContractByOps(d, a, {
        contractId: str(fd, "contractId"),
        ...(productTermsId ? { productTermsId } : {}),
        ...(documentRef ? { documentRef } : {}),
      }),
    "契約完了を確認しました（報酬は1件だけ発生します）",
  );
}

export async function rejectContractAction(fd: FormData) {
  await run(
    fd,
    (d, a) => rejectContractByOps(d, a, { contractId: str(fd, "contractId"), reason: str(fd, "reason") }),
    "成約報告を差し戻しました",
  );
}

export async function recordPaymentAction(fd: FormData) {
  await run(
    fd,
    (d, a) =>
      recordPaymentByOps(d, a, {
        contractId: str(fd, "contractId"),
        amount: optInt(fd, "amount") ?? Number.NaN,
        received: str(fd, "received") === "on",
        note: optStr(fd, "note"),
      }),
    "入金を記録しました",
  );
}

export async function updatePaymentStatusAction(fd: FormData) {
  await run(
    fd,
    (d, a) =>
      updatePaymentStatusByOps(d, a, {
        paymentId: str(fd, "paymentId"),
        status: str(fd, "status") as PaymentTargetStatus,
      }),
    "入金の状態を更新しました",
  );
}

export async function scheduleRewardAction(fd: FormData) {
  const scheduledFor = jstDate(fd, "scheduledFor");
  await run(
    fd,
    async (d, a) =>
      scheduledFor
        ? scheduleRewardByOps(d, a, { rewardId: str(fd, "rewardId"), scheduledFor })
        : { ok: false, error: "invalid_input", message: "支払予定日を入力してください" },
    "支払予定日を設定しました",
  );
}

export async function markRewardPaidAction(fd: FormData) {
  await run(fd, (d, a) => markRewardPaidByOps(d, a, str(fd, "rewardId")), "支払済みにしました");
}

export async function adjustRewardAction(fd: FormData) {
  await run(
    fd,
    (d, a) =>
      adjustRewardByOps(d, a, {
        rewardId: str(fd, "rewardId"),
        delta: optInt(fd, "delta") ?? Number.NaN,
        reason: str(fd, "reason"),
      }),
    "報酬を調整しました（元の記録は残ります）",
  );
}

export async function cancelRewardAction(fd: FormData) {
  await run(
    fd,
    (d, a) => cancelRewardByOps(d, a, { rewardId: str(fd, "rewardId"), reason: str(fd, "reason") }),
    "報酬を取り消しました（元の記録は残ります）",
  );
}

// 5. ドメイン希望

export async function confirmDomainPreferenceAction(fd: FormData) {
  await run(
    fd,
    (d, a) => confirmDomainPreferenceByOps(d, a, str(fd, "id"), optInt(fd, "revision") ?? Number.NaN),
    "ドメイン希望を確認済みにしました",
  );
}

// 5. 納品（制作・運営確認・顧客確認・公開の記録・納品）

export async function createDeliveryAction(fd: FormData) {
  await run(
    fd,
    async (d, a) => {
      const result = await createDeliveryByOps(d, a, str(fd, "contractId"));
      if (result.ok)
        fd.set("returnTo", `/ops/delivery?focus=${result.value.deliveryId}#delivery-${result.value.deliveryId}`);
      return result;
    },
    "納品を作成しました（情報確認）。準備ができたら「制作に進める」を押してください",
  );
}

const STEP_MESSAGES: Record<string, string> = {
  building: "制作を受け付けました。制作・検査が完了すると運営確認へ進みます。進行状態は自動更新されます",
  ops_review: "運営確認に回しました。版を確認し、顧客確認に回してください",
  delivered: "納品済みにしました",
};

export async function transitionDeliveryAction(fd: FormData) {
  const to = str(fd, "to");
  await run(
    fd,
    (d, a) => transitionDeliveryByOps(d, a, { deliveryId: str(fd, "deliveryId"), to, note: str(fd, "note") }),
    STEP_MESSAGES[to] ?? "納品の状態を変更しました",
  );
}

export async function recordPublicationAction(fd: FormData) {
  await run(
    fd,
    (d, a) =>
      recordPublicationByOps(d, a, {
        deliveryId: str(fd, "deliveryId"),
        environment: str(fd, "environment"),
        url: optStr(fd, "url"),
      }),
    "公開を記録しました（記録だけで、AWSへの公開・DNS変更は行っていません）",
  );
}

/**
 * 顧客確認に回す。顧客に渡すURL（トークンを含む）は戻り値でだけ返す。
 * 他の操作と違い、リダイレクトのクエリにURLを載せない（履歴・ログに残さないため）。
 */
export async function sendToCustomerReviewAction(
  _prev: CustomerReviewLinkState,
  fd: FormData,
): Promise<CustomerReviewLinkState> {
  const actor = await getCurrentActor();
  const ttl = optInt(fd, "ttlHours");
  if (ttl !== null && (!Number.isFinite(ttl) || ttl <= 0))
    return { status: "error", message: reviewLinkError("invalid_ttl") };
  const requestKey = str(fd, "requestKey");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestKey))
    return { status: "error", message: reviewLinkError("invalid_request") };
  try {
    const r = await sendToCustomerReviewByOps({ db: getDb(), clock: systemClock }, actor, {
      deliveryId: str(fd, "deliveryId"),
      versionId: str(fd, "versionId"),
      requestKey,
      ...(ttl !== null ? { ttlHours: ttl } : {}),
    });
    if (!r.ok) return { status: "error", message: reviewLinkError(r.error) };
    refresh();
    return {
      status: "ok",
      message: "顧客確認のリンクを用意しました。発行履歴からも再表示できます。",
      reviewUrl: r.value.reviewUrl,
      expiresAt: r.value.expiresAt.toISOString(),
      linkId: r.value.linkId,
      versionId: r.value.versionId,
    };
  } catch {
    return {
      status: "unknown",
      message: "発行結果を確認できませんでした。同じ発行を再確認すると、リンクを増やさず結果を取得できます。",
    };
  }
}

// 6. 設定・利用停止

export async function updateSettingAction(fd: FormData) {
  await run(
    fd,
    (d, a) => updateSetting(d, a, { key: str(fd, "key"), value: optInt(fd, "value") ?? Number.NaN }),
    "設定を変更しました（操作履歴に記録しました）",
  );
}

export async function suspendUserAction(fd: FormData) {
  await run(
    fd,
    (d, a) => suspendSalesUser(d, a, { userId: str(fd, "userId"), reason: str(fd, "reason") }),
    "利用停止にしました",
  );
}

export async function reactivateUserAction(fd: FormData) {
  await run(
    fd,
    (d, a) => reactivateSalesUser(d, a, { userId: str(fd, "userId"), reason: str(fd, "reason") }),
    "利用停止を解除しました",
  );
}

export async function retryDiscoveryJobAction(fd: FormData) {
  await run(
    fd,
    (d, a) => retryDiscoveryJobByOps(d, a, str(fd, "jobId")),
    "同じ条件の再試行ジョブを登録しました。収集一覧で新しいジョブを確認できます",
  );
}

export async function retryDeliveryBuildAction(deliveryId: string, buildId: string) {
  const actor = await getCurrentActor();
  const r = await retryDeliveryBuild(getDb(), systemClock, actor, deliveryId, buildId);
  if (!r.ok)
    return {
      message:
        r.error === "forbidden"
          ? "運営のログイン状態を確認してください。"
          : "制作状態が更新されています。最新の状態を確認してください。",
    };
  refresh();
  return { message: "制作の再試行を受け付けました。進行状態を確認してください。" };
}

export async function resumeAuditAction(auditId: string) {
  const actor = await getCurrentActor();
  try {
    const result = await resumeAuditByOps(getDb(), systemClock, actor, auditId);
    if (!result.ok) return { ok: false, message: result.message ?? "診断と操作権限を確認してください" };
    revalidatePath("/ops");
    revalidatePath("/ops/processing");
    revalidatePath(`/ops/companies/${result.value.companyId}`);
    return {
      ok: true,
      message: result.value.proposalQueued
        ? "保存済みの診断から制作依頼を受け付けました。ワーカーが自動で引き継ぎます。"
        : "保存済みの判定を反映しました。採点のやり直しは行っていません。",
    };
  } catch {
    return { ok: false, message: "受付結果を確認できませんでした。もう一度操作しても、同じ依頼は重複しません。" };
  }
}

export async function requestCompanyAuditAction(input: { companyId: string; requestId: string }) {
  const actor = await getCurrentActor();
  try {
    const result = await requestAuditByOps(getDb(), systemClock, actor, input);
    if (!result.ok) return { ok: false, message: result.message ?? "診断の対象と操作権限を確認してください" };
    revalidatePath(`/ops/companies/${input.companyId}`);
    revalidatePath("/ops/processing");
    revalidatePath("/ops");
    return {
      ok: true,
      message: result.value.alreadyAccepted
        ? "診断依頼は受付済みです。同じ依頼を追加していません。"
        : "診断を受け付けました。ワーカーが順次処理し、結果を反映します。",
    };
  } catch {
    return { ok: false, message: "受付結果を確認できませんでした。同じ操作でもう一度確認してください。" };
  }
}
