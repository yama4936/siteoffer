import { type Actor, err, ok } from "@siteoffer/core";
import { auditEvents, type DbOrTx, generationJobs, users } from "@siteoffer/db";
import { type GenerationFeedback, sanitizeFeedback } from "@siteoffer/generation/feedback";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { isUuid } from "./form";

export type GenerationRetryDetail = { attempt: number; feedback: GenerationFeedback };
export async function readGenerationRetries(db: DbOrTx, actor: Actor | null, companyId: string, jobIds: string[]) {
  if (actor?.kind !== "ops" || !isUuid(actor.userId)) return err("forbidden");
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, "ops"), eq(users.status, "active")));
  if (!user) return err("forbidden");
  if (!isUuid(companyId) || jobIds.length > 20 || jobIds.some((id) => !isUuid(id))) return err("invalid_input");
  const details: Record<string, GenerationRetryDetail> = {};
  if (!jobIds.length) return ok(details);
  // Match the actual attempt, not timestamps: several attempts can share the same clock value.
  const payload = sql`${auditEvents.after}->'retryFeedback'`;
  const rows = await db
    .select({
      id: generationJobs.id,
      attempt: generationJobs.attempts,
      feedback: sql<unknown>`min((${payload})::text)::jsonb`,
      variants: sql<number>`count(distinct coalesce((${payload})::text, '[missing]'))`.mapWith(Number),
    })
    .from(generationJobs)
    .innerJoin(
      auditEvents,
      and(
        eq(auditEvents.targetType, "generation_job"),
        eq(auditEvents.action, "generation.attempt_started"),
        sql`${auditEvents.targetId} = ${generationJobs.id}::text`,
        sql`${auditEvents.after}->>'attempt' = ${generationJobs.attempts}::text`,
      ),
    )
    .where(
      and(
        eq(generationJobs.companyId, companyId),
        inArray(generationJobs.id, [...new Set(jobIds)]),
        gte(generationJobs.attempts, 2),
      ),
    )
    .groupBy(generationJobs.id, generationJobs.attempts);
  for (const row of rows) {
    const feedback = sanitizeFeedback(row.feedback);
    if (row.variants === 1 && feedback) details[row.id] = { attempt: row.attempt, feedback };
  }
  return ok(details);
}

const RULE_LABELS: Record<string, string> = {
  empty_response: "空でない生成結果を返す",
  invalid_json: "読み取れる形式で生成結果を返す",
  schema_violation: "必要な項目と形式を満たす",
  reference_visual: "承認画像に基づく配色・書体・構成を確認する",
  fact_violation: "確認済みの情報に基づいて内容を整える",
  marker: "内部の確認用の文字を掲載内容に残さない",
  needs_review_value: "未確認の情報を掲載しない",
  unsupported_claim: "金額・実績・資格などの根拠を確認する",
  unknown_fact_ref: "掲載情報の出典を確認する",
  unconfirmed_fact_ref: "確認済みの出典だけを使う",
  identity_mismatch: "会社名・連絡先を確認済みの値に合わせる",
  fact_value_mismatch: "会社情報の表を確認済みの値に合わせる",
};
const FIELD_LABELS: Record<string, string> = {
  "company.name": "会社の正式名称",
  "company.shortName": "屋号・略称",
  "contact.phone.display": "電話番号の表示",
  "contact.phone.tel": "電話のリンク先",
  "contact.email": "メールアドレス",
  "contact.hours": "受付時間",
  "theme.visual": "配色・書体・配置",
};
export function generationRetryPresentation(attempts: number, detail?: GenerationRetryDetail) {
  if (!detail || detail.attempt !== attempts || attempts < 2) return null;
  const feedback = sanitizeFeedback(detail.feedback);
  if (!feedback) return null;
  return {
    title: `${attempts}回目の生成へ渡した確認事項`,
    rules: feedback.rules.map((rule) => RULE_LABELS[rule] ?? "生成内容の検査結果を確認する"),
    fields: [
      ...new Set(
        feedback.fields.map(
          (field) => FIELD_LABELS[field] ?? (field.startsWith("companyInfo.rows.") ? "会社情報の表" : "掲載内容"),
        ),
      ),
    ],
    companyInfo: feedback.rules.some((rule) => ["identity_mismatch", "fact_value_mismatch"].includes(rule)),
  };
}
