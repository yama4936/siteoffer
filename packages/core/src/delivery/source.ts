import { createHash } from "node:crypto";
import {
  companies,
  contracts,
  type DbOrTx,
  designVersions,
  proposals,
  proposalVersions,
  siteAudits,
} from "@siteoffer/db";
import { and, desc, eq } from "drizzle-orm";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
export function contractProductionScope(snapshot: unknown) {
  const root = object(snapshot),
    terms = object(root.terms);
  if (root.version !== 1) return null;
  return {
    name: typeof terms.name === "string" ? terms.name : null,
    version: typeof terms.version === "string" ? terms.version : null,
    scope: terms.scope ?? null,
    price: typeof terms.price === "number" ? terms.price : null,
    monthlyFee: typeof terms.monthlyFee === "number" ? terms.monthlyFee : null,
  };
}

/** 制作入力の参照元を契約から解決する。明示された参照が不正なら別の版へ自動で差し替えない。サーバー内部用。 */
export async function loadDeliverySource(db: DbOrTx, contractId: string) {
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  if (!contract) return null;
  const [company] = await db.select().from(companies).where(eq(companies.id, contract.companyId));
  if (!company) return null;
  const blockers: string[] = [],
    notices: string[] = [];
  if (contract.status !== "completed") blockers.push("契約確認が完了していません。契約画面で確認してください。");
  const [proposal] = contract.proposalVersionId
    ? await db
        .select({ row: proposalVersions })
        .from(proposalVersions)
        .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
        .where(and(eq(proposalVersions.id, contract.proposalVersionId), eq(proposals.companyId, company.id)))
        .then((rows) => rows.map((r) => r.row))
    : [];
  if (contract.proposalVersionId && proposal?.status !== "approved")
    blockers.push("契約した提案版を確認できません。運営の承認状態と企業の紐付けを確認してください。");
  if (!contract.proposalVersionId)
    notices.push("契約に提案版が記録されていない旧案件です。最新の評価済み診断を使います。");
  const [audit] = proposal?.auditId
    ? await db
        .select()
        .from(siteAudits)
        .where(
          and(
            eq(siteAudits.id, proposal.auditId),
            eq(siteAudits.companyId, company.id),
            eq(siteAudits.status, "evaluated"),
          ),
        )
    : await db
        .select()
        .from(siteAudits)
        .where(and(eq(siteAudits.companyId, company.id), eq(siteAudits.status, "evaluated")))
        .orderBy(desc(siteAudits.createdAt), desc(siteAudits.id))
        .limit(1);
  if (!audit) blockers.push("制作の根拠にする評価済み診断がありません。対象の診断を確認してください。");
  const designId = object(proposal?.content).designVersionId;
  let design: typeof designVersions.$inferSelect | null = null;
  if (designId !== undefined && designId !== null) {
    if (typeof designId === "string" && uuid.test(designId)) {
      const [row] = await db
        .select()
        .from(designVersions)
        .where(and(eq(designVersions.id, designId), eq(designVersions.companyId, company.id)));
      design = row ?? null;
    }
    if (
      design?.status !== "approved" ||
      design.auditId !== audit?.id ||
      !design.imageBase64 ||
      !design.imageSha256 ||
      createHash("sha256").update(Buffer.from(design.imageBase64, "base64")).digest("hex") !== design.imageSha256
    )
      blockers.push(
        "契約した提案の承認済みデザイン画像を確認できません。画像・承認状態・診断の紐付けを確認してください。",
      );
  } else notices.push("この提案にはデザイン画像の記録がありません。制作前に契約時の見た目・構成を確認してください。");
  const scope = contractProductionScope(contract.snapshot);
  if (!scope) notices.push("契約時の提供範囲が記録されていない旧案件です。契約資料で確認してください。");
  return { company, contract, proposal: proposal ?? null, audit: audit ?? null, design, scope, blockers, notices };
}
