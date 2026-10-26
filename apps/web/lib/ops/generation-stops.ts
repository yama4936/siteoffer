import { companies, type DbOrTx, generationJobs } from "@siteoffer/db";
import { sandboxStopReferenceSchema } from "@siteoffer/generation/stop-reference";
import { and, asc, count, eq } from "drizzle-orm";

export const GENERATION_STOP_LIMIT = 20;
export const GENERATION_PURPOSE_LABELS = {
  evaluation: "サイト診断",
  proposal_text: "改善提案文",
  call_script: "営業台本",
  faq: "想定問答",
  demo_site: "提案サイト",
  delivery_site: "納品サイト",
} as const;

type RecoveryWorker = { live: boolean; known: boolean; site: boolean; generator: string; stopRecovery: boolean };
export function generationStopNextStep(
  job: { id: string; generator: string; reference: unknown },
  workers: RecoveryWorker[],
) {
  const reference = sandboxStopReferenceSchema.safeParse(job.reference);
  if (
    !reference.success ||
    reference.data.jobId !== job.id ||
    (!reference.data.clientClosed && reference.data.clientPid === null)
  )
    return {
      code: "evidence_missing" as const,
      label: "元の実行環境の確認が必要",
      detail:
        "停止を判断する情報が不足しています。元のワーカーと実行環境を管理者が確認してください。停止を確認するまで新しい生成は保留します。",
    };
  const matching = workers.filter((w) => w.live && w.known && w.site && w.generator === job.generator);
  if (!matching.length)
    return {
      code: "worker_missing" as const,
      label: "対応ワーカーの稼働を確認",
      detail: "同じ生成方式を扱う制作ワーカーの稼働を確認できません。元の実行環境のワーカーと接続を確認してください。",
    };
  if (!matching.some((w) => w.stopRecovery))
    return {
      code: "worker_update" as const,
      label: "停止確認に対応するワーカーが必要",
      detail: "稼働通知はありますが、停止確認への対応は未通知です。更新した制作ワーカーを使用してください。",
    };
  return {
    code: "automatic_check" as const,
    label: "停止確認に対応するワーカーが稼働中",
    detail:
      "毎分の確認で元の実行環境の停止を証明できた場合だけ、同じ生成方式の受付を再開します。長く変わらない場合は元のワーカーとDockerの状態を確認してください。",
  };
}

/** Internal to the authorized ops overview. Global because one company's sandbox can block another company. */
export async function loadGenerationStops(db: DbOrTx, requestedPage: number | undefined) {
  const where = and(
    eq(generationJobs.status, "needs_review"),
    eq(generationJobs.errorCode, "sandbox_stop_unconfirmed"),
  );
  const counts = await db
    .select({ generator: generationJobs.generator, count: count() })
    .from(generationJobs)
    .where(where)
    .groupBy(generationJobs.generator);
  const total = counts.reduce((sum, r) => sum + r.count, 0),
    pages = Math.max(1, Math.ceil(total / GENERATION_STOP_LIMIT));
  const page = Math.max(1, Math.min(pages, Number.isSafeInteger(requestedPage) ? requestedPage! : 1));
  const rows = await db
    .select({
      id: generationJobs.id,
      companyId: generationJobs.companyId,
      companyName: companies.name,
      purpose: generationJobs.purpose,
      generator: generationJobs.generator,
      since: generationJobs.finishedAt,
      createdAt: generationJobs.createdAt,
      reference: generationJobs.outputRef,
    })
    .from(generationJobs)
    .leftJoin(companies, eq(companies.id, generationJobs.companyId))
    .where(where)
    .orderBy(asc(generationJobs.finishedAt), asc(generationJobs.id))
    .limit(GENERATION_STOP_LIMIT)
    .offset((page - 1) * GENERATION_STOP_LIMIT);
  return { total, page, pages, counts, rows };
}
