import { createHash } from "node:crypto";
import {
  approvals,
  companies,
  contracts,
  type DbOrTx,
  deliveries,
  deliveryBuilds,
  deliveryChanges,
  deliveryVersions,
  shareLinks,
} from "@siteoffer/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Clock } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
import { err, ok, type Result } from "../common/result.ts";
import { findSecretInFields } from "../domain-preference/secrets.ts";
import { deliveryVersionImagesValid } from "../image-assets.ts";
import {
  IMAGE_RIGHTS_CONSENT_VERSION,
  loadVersionImages,
  recordCustomerImageRightsConsent,
} from "../image-rights-consent.ts";
import { verifyShareLink } from "../share-link/share-link.ts";
import { beginDeliveryBuild } from "./build-state.ts";
import type { DeliveryRow } from "./delivery.ts";

/**
 * 顧客確認（5.3・15章・AC-18）。顧客は常設ログインを持たず、運営が発行した期限付きの共有リンクで操作する。
 * リンクは verifyShareLink(purpose: "delivery", targetId: 版) で検証し、戻り値の customer actor で履歴を残す。
 * 期限切れ・取り消し済み・別の版のリンク、顧客確認中でない納品では、承認・修正依頼を受け付けない。
 */

export const CUSTOMER_COMMENT_MAX = 2000;

export type CustomerDecision = "approved" | "changes_requested";

/** 顧客の画面に出す状態 */
export type CustomerReviewState =
  /** 確認をお願いしている（承認・修正依頼を受け付ける） */
  | "awaiting"
  /** この版を承認済み */
  | "approved"
  /** この版に修正依頼を出した */
  | "changes_requested"
  /** この版は確認の受付を終えた（新しい版の確認に移った・運営が取り下げた等） */
  | "closed";

/** 顧客に見せてよい情報だけ（成果物のパス・内部ID以外の運営情報は含めない） */
export interface CustomerReview {
  versionId: string;
  versionNumber: number;
  companyName: string;
  linkExpiresAt: Date;
  state: CustomerReviewState;
  /** この版への直近の判断（あれば） */
  lastDecision: { decision: CustomerDecision; decidedAt: Date; comment: string | null } | null;
}

async function loadReview(db: DbOrTx, versionId: string) {
  const [row] = await db
    .select({
      version: deliveryVersions,
      delivery: deliveries,
      companyName: companies.name,
    })
    .from(deliveryVersions)
    .innerJoin(deliveries, eq(deliveries.id, deliveryVersions.deliveryId))
    .innerJoin(contracts, eq(contracts.id, deliveries.contractId))
    .innerJoin(companies, eq(companies.id, contracts.companyId))
    .where(eq(deliveryVersions.id, versionId));
  return row ?? null;
}

const isUnderReview = (d: DeliveryRow, versionId: string) =>
  d.status === "customer_review" && d.reviewVersionId === versionId;

/**
 * 共有リンクから、顧客が確認する版の情報を読む。無効なリンクは理由を区別せず not_found（存在を明かさない）。
 */
export async function getCustomerReview(
  db: DbOrTx,
  clock: Clock,
  token: string,
): Promise<Result<CustomerReview, "not_found">> {
  const link = await verifyShareLink(db, clock, token, { purpose: "delivery" });
  if (!link.ok) return link;
  const row = await loadReview(db, link.value.targetId);
  if (!row) return err("not_found", "target_missing");
  const [last] = await db
    .select()
    .from(approvals)
    .where(eq(approvals.deliveryVersionId, row.version.id))
    .orderBy(desc(approvals.decidedAt))
    .limit(1);
  let state: CustomerReviewState;
  if (isUnderReview(row.delivery, row.version.id)) state = "awaiting";
  else if (row.delivery.lockedVersionId === row.version.id) state = "approved";
  else if (last?.decision === "changes_requested") state = "changes_requested";
  else state = "closed";
  return ok({
    versionId: row.version.id,
    versionNumber: row.version.version,
    companyName: row.companyName,
    linkExpiresAt: link.value.expiresAt,
    state,
    lastDecision: last ? { decision: last.decision, decidedAt: last.decidedAt, comment: last.comment } : null,
  });
}

export interface CustomerDecisionInput {
  /** 画面に表示していた版。リンクの対象と一致しなければ拒否する */
  versionId: string;
  decision: CustomerDecision;
  /** 修正依頼では必須。承認では任意 */
  comment?: string | null;
  requestKey?: string;
  /**
   * 写真・ロゴ等の権利についての同意（承認では必須）。画面に表示した文言の版を送る。
   * 文言の版が今の版と違えば受け付けない（表示していない文言への同意にしない）。
   */
  imageRightsConsent?: { accepted: boolean; textVersion: string } | null;
}

export type CustomerDecisionError = "link_invalid" | "invalid_input" | "not_under_review" | "request_conflict";

export interface CustomerDecisionResult {
  delivery: DeliveryRow;
  approvalId: string;
}

/**
 * 顧客の承認・修正依頼。
 * - 承認：版を公開対象として固定（locked_version_id）し、公開準備（ready）へ。固定済みなら上書きしない。
 * - 修正依頼：制作（building）に戻す。運営が新しい版を追加して、運営確認からやり直す。
 * 判断は approvals に残し、操作履歴は共有リンクの customer actor で記録する。
 */
export async function decideAsCustomer(
  db: DbOrTx,
  clock: Clock,
  token: string,
  input: CustomerDecisionInput,
): Promise<Result<CustomerDecisionResult, CustomerDecisionError>> {
  if (
    !input ||
    (input.requestKey !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestKey))
  )
    return err("invalid_input");
  if (input.decision !== "approved" && input.decision !== "changes_requested") return err("invalid_input");
  const comment = typeof input.comment === "string" ? input.comment.trim() : "";
  if (comment.length > CUSTOMER_COMMENT_MAX) {
    return err("invalid_input", `コメントは${CUSTOMER_COMMENT_MAX}文字以内で入力してください`);
  }
  if (findSecretInFields({ comment }))
    return err("invalid_input", "パスワード・移管コード・鍵などは記入しないでください");
  if (input.decision === "changes_requested" && !comment) {
    return err("invalid_input", "修正してほしい点をご記入ください");
  }
  const consent = input.imageRightsConsent;
  if (
    input.decision === "approved" &&
    (consent?.accepted !== true || consent.textVersion !== IMAGE_RIGHTS_CONSENT_VERSION)
  )
    return err(
      "invalid_input",
      "写真・ロゴ等の権利についての同意が必要です。同意の内容をご確認のうえチェックを入れてください",
    );

  return db.transaction(async (tx): Promise<Result<CustomerDecisionResult, CustomerDecisionError>> => {
    // 用途と版の両方が一致するリンクだけ（別の版のリンクでは承認できない）
    const link = await verifyShareLink(tx, clock, token, { purpose: "delivery", targetId: input.versionId });
    if (!link.ok) return err("link_invalid", link.message);

    const [version] = await tx.select().from(deliveryVersions).where(eq(deliveryVersions.id, link.value.targetId));
    if (!version) return err("link_invalid", "target_missing");
    const [delivery] = await tx.select().from(deliveries).where(eq(deliveries.id, version.deliveryId)).for("update");
    // 納品ロックを待つ間の取り消し・期限切れを見逃さない。判断確定まではリンクもロックする。
    await tx.select({ id: shareLinks.id }).from(shareLinks).where(eq(shareLinks.id, link.value.linkId)).for("update");
    const currentLink = await verifyShareLink(tx, clock, token, { purpose: "delivery", targetId: input.versionId });
    if (!currentLink.ok) return err("link_invalid", currentLink.message);
    const hash = (s: string) => createHash("sha256").update(s).digest("hex");
    const receiptKey = input.requestKey ? hash(JSON.stringify([link.value.linkId, input.requestKey])) : null;
    const payloadHash = hash(
      JSON.stringify(
        input.decision === "approved"
          ? [input.versionId, input.decision, comment, IMAGE_RIGHTS_CONSENT_VERSION]
          : [input.versionId, input.decision, comment],
      ),
    );
    if (receiptKey) {
      const [previous] = await tx.select().from(approvals).where(eq(approvals.receiptKey, receiptKey));
      if (previous) {
        if (previous.payloadHash !== payloadHash) return err("request_conflict", "前の送信と内容が異なります");
        if (!delivery) return err("not_under_review");
        return ok({ delivery, approvalId: previous.id });
      }
    }
    if (!delivery || !isUnderReview(delivery, version.id) || delivery.lockedVersionId !== null) {
      return err("not_under_review", "この版は現在、確認の受付を行っていません");
    }

    if (input.decision === "approved" && !(await deliveryVersionImagesValid(tx, version.id, true)))
      return err("not_under_review", "制作内容を運営で再確認しています。担当者へお問い合わせください");
    const [change] = await tx
      .select()
      .from(deliveryChanges)
      .where(and(eq(deliveryChanges.deliveryId, delivery.id), isNull(deliveryChanges.approvedVersionId)))
      .for("update");
    if (change) {
      const [build] = version.buildId
        ? await tx
            .select({ changeId: deliveryBuilds.changeId })
            .from(deliveryBuilds)
            .where(and(eq(deliveryBuilds.id, version.buildId), eq(deliveryBuilds.deliveryId, delivery.id)))
        : [];
      if (build?.changeId !== change.id) return err("not_under_review", "今回の変更に対応する版を確認してください");
    }
    const now = clock.now();
    const [approval] = await tx
      .insert(approvals)
      .values({
        deliveryVersionId: version.id,
        decision: input.decision,
        receiptKey,
        payloadHash: receiptKey ? payloadHash : null,
        comment: comment || null,
        shareLinkId: link.value.linkId,
        decidedAt: now,
      })
      .returning();

    const approved = input.decision === "approved";
    if (approved) {
      // 承認と同じトランザクションで、版の画像の組への同意を記録する
      const images = await loadVersionImages(tx, version.id);
      if (!images) throw new Error(`delivery version ${version.id} images could not be read`);
      await recordCustomerImageRightsConsent(tx, clock, {
        actor: link.value.actor,
        companyId: images.companyId,
        deliveryId: delivery.id,
        versionId: version.id,
        version: version.version,
        buildId: version.buildId,
        approvalId: approval!.id,
        shareLinkId: link.value.linkId,
        images: images.images,
      });
    }
    const build = approved ? null : await beginDeliveryBuild(tx, clock, delivery);
    const [row] = await tx
      .update(deliveries)
      .set(
        approved
          ? { status: "ready", lockedVersionId: version.id, reviewVersionId: null, updatedAt: now }
          : { status: "building", reviewVersionId: null, currentBuildId: build!.id, updatedAt: now },
      )
      .where(
        and(
          eq(deliveries.id, delivery.id),
          eq(deliveries.status, "customer_review"),
          isNull(deliveries.lockedVersionId),
        ),
      )
      .returning();
    if (!row) throw new Error(`delivery ${delivery.id} changed during customer decision`);
    if (approved && change)
      await tx
        .update(deliveryChanges)
        .set({ approvedVersionId: version.id, approvedAt: now })
        .where(eq(deliveryChanges.id, change.id));

    await recordEvent(tx, clock, {
      actor: link.value.actor,
      action: approved ? "delivery.customer_approve" : "delivery.customer_request_changes",
      targetType: "delivery",
      targetId: delivery.id,
      before: { status: delivery.status, lockedVersionId: delivery.lockedVersionId },
      // コメント本文は approvals に保存し、履歴には有無だけ残す
      after: {
        status: row.status,
        lockedVersionId: row.lockedVersionId,
        versionId: version.id,
        version: version.version,
        approvalId: approval!.id,
        hasComment: comment.length > 0,
      },
    });
    return ok({ delivery: row, approvalId: approval!.id });
  });
}
