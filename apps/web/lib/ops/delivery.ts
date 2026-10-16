/**
 * 運営の納品操作（15・18章）。Server Function（app/(ops)/ops/actions.ts）から呼ぶ。
 * - 入口で requireOps を通し、運営以外は forbidden を返す（AC-17・AC-18）。core の業務関数でも重ねて判定する。
 * - 状態遷移・版の固定・共有リンクの発行は core の delivery が行う。ここでは独自の規則を作らない。
 * - 制作版のビルドはワーカーが行う（制作中で版のない納品を拾う）。公開はAWSの処理をせず、記録だけを残す。
 * Next.js に依存しない形にして、PGlite の結合テストから直接呼べるようにしている。
 */
import {
  type Actor,
  createDeliveryForContract,
  type DeliveryDetail,
  err,
  getDeliveryDetail,
  loadDeliverySource,
  ok,
  type Result,
  recordPublication,
  type ShareTokenRecovery,
  sendToCustomerReview,
  transitionDelivery,
} from "@siteoffer/core";
import { companies, contracts, type DbOrTx, deliveries, users } from "@siteoffer/db";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { OpsDeps } from "./commands";
import { requireOps } from "./guard";
import { reviewLinkRecovery } from "./review-links";

/** Web（顧客確認の画面）のオリジン。WEB_BASE_URL が無ければローカルの既定値 */
export const DEFAULT_WEB_ORIGIN = "http://localhost:3100";

export function webOrigin(): string {
  return process.env.WEB_BASE_URL || DEFAULT_WEB_ORIGIN;
}

/** 顧客に渡す確認画面のURL（<web>/review/<token>）。トークンはこの戻り値でだけ扱う */
export function customerReviewUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/review/${token}`;
}

const LIST_LIMIT = 100;

/** 契約完了で納品がまだない契約（納品を作成できるもの） */
export async function listContractsAwaitingDelivery(db: DbOrTx, actor: Actor | null, filter: { id?: string } = {}) {
  const g = requireOps(actor);
  if (!g.ok) return g;
  const rows = await db
    .select({
      contractId: contracts.id,
      companyId: companies.id,
      companyName: companies.name,
      salesName: users.displayName,
      completedAt: contracts.completedAt,
    })
    .from(contracts)
    .innerJoin(companies, eq(companies.id, contracts.companyId))
    .innerJoin(users, eq(users.id, contracts.salesUserId))
    .leftJoin(deliveries, eq(deliveries.contractId, contracts.id))
    .where(
      and(
        eq(contracts.status, "completed"),
        isNull(deliveries.id),
        filter.id ? eq(contracts.id, filter.id) : undefined,
      ),
    )
    .orderBy(asc(contracts.completedAt), asc(contracts.id))
    .limit(LIST_LIMIT);
  return ok(rows);
}

/** 納品の一覧と詳細（版・顧客の判断・公開記録）。運営だけ */
export async function listDeliveryDetails(
  db: DbOrTx,
  actor: Actor | null,
  filter: { id?: string; contractId?: string } = {},
): Promise<Result<DeliveryDetail[], "forbidden">> {
  const g = requireOps(actor);
  if (!g.ok) return g;
  const ids = await db
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(
      and(
        filter.id ? eq(deliveries.id, filter.id) : undefined,
        filter.contractId ? eq(deliveries.contractId, filter.contractId) : undefined,
      ),
    )
    .orderBy(desc(deliveries.updatedAt))
    .limit(LIST_LIMIT);
  const out: DeliveryDetail[] = [];
  for (const { id } of ids) {
    const r = await getDeliveryDetail(db, g.value, id);
    if (r.ok) out.push(r.value);
  }
  return ok(out);
}

/** 契約完了の契約から納品を作る（情報確認から始まる） */
export async function createDeliveryByOps({ db, clock }: OpsDeps, actor: Actor | null, contractId: string) {
  const g = requireOps(actor);
  if (!g.ok) return g;
  const r = await createDeliveryForContract(db, clock, g.value, contractId);
  if (!r.ok) return r;
  return ok({ deliveryId: r.value.delivery.id, created: r.value.created });
}

/** 単純な状態遷移（制作へ・運営確認へ・納品済みへ）。行き先の可否は core が判定する */
export async function transitionDeliveryByOps(
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { deliveryId: string; to: string; note?: string },
) {
  const g = requireOps(actor);
  if (!g.ok) return g;
  if (input.to !== "building" && input.to !== "ops_review" && input.to !== "delivered") {
    return err("invalid_transition", "この状態へは変更できません");
  }
  if (input.to === "building") {
    const detail = await getDeliveryDetail(db, g.value, input.deliveryId);
    if (!detail.ok) return detail;
    const source = await loadDeliverySource(db, detail.value.contractId);
    if (!source || source.blockers.length)
      return err("preparation_required", source?.blockers.join(" / ") ?? "制作の入力情報を確認してください");
  }
  return transitionDelivery(db, clock, g.value, input.deliveryId, input.to, input.note);
}

/**
 * 運営が確認した版を顧客確認に回し、顧客に渡すURL（<web>/review/<token>）を返す。
 * URLは戻り値でだけ返す（リダイレクトのクエリ・ログには載せない）。
 */
export async function sendToCustomerReviewByOps(
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { deliveryId: string; versionId: string; ttlHours?: number; requestKey?: string },
  origin: string = webOrigin(),
  recovery: ShareTokenRecovery | undefined = reviewLinkRecovery(),
): Promise<Result<{ reviewUrl: string; expiresAt: Date; linkId: string; versionId: string }, string>> {
  const g = requireOps(actor);
  if (!g.ok) return g;
  const r = await sendToCustomerReview(
    db,
    clock,
    g.value,
    input.deliveryId,
    {
      versionId: input.versionId,
      ...(input.requestKey !== undefined ? { requestKey: input.requestKey } : {}),
      ...(input.ttlHours !== undefined ? { ttlHours: input.ttlHours } : {}),
    },
    recovery,
  );
  if (!r.ok) return r;
  return ok({
    linkId: r.value.issued.link.id,
    versionId: r.value.issued.link.targetId,
    reviewUrl: customerReviewUrl(origin, r.value.issued.token),
    expiresAt: r.value.issued.link.expiresAt,
  });
}

/** 公開の記録（公開準備 → 公開）。AWSへの公開・DNS変更は行わない */
export async function recordPublicationByOps(
  { db, clock }: OpsDeps,
  actor: Actor | null,
  input: { deliveryId: string; environment: string; url?: string | null },
) {
  const g = requireOps(actor);
  if (!g.ok) return g;
  const r = await recordPublication(db, clock, g.value, input.deliveryId, {
    environment: input.environment,
    url: input.url ?? null,
  });
  if (!r.ok) return r;
  return ok({ deploymentId: r.value.deployment.id });
}
