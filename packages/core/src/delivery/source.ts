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
export function hasProductionScope(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasProductionScope);
  if (value && typeof value === "object") return Object.values(value).some(hasProductionScope);
  return typeof value === "number" || typeof value === "boolean";
}
export async function loadDeliverySource(
  db: DbOrTx,
  contractId: string,
  supplement?: { proposalVersionId: string; scope: unknown },
) {
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, contractId));
  if (!contract) return null;
  const [company] = await db.select().from(companies).where(eq(companies.id, contract.companyId));
  if (!company) return null;
  const blockers: string[] = [],
    notices: string[] = [];
  if (contract.status !== "completed") blockers.push("契約確認が完了していません。契約画面で確認してください。");
  const selectedProposalId = supplement?.proposalVersionId ?? contract.proposalVersionId;
  const [proposal] = selectedProposalId
    ? await db
        .select({ row: proposalVersions })
        .from(proposalVersions)
        .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
        .where(and(eq(proposalVersions.id, selectedProposalId!), eq(proposals.companyId, company.id)))
        .then((rows) => rows.map((r) => r.row))
    : [];
  if (selectedProposalId && proposal?.status !== "approved")
    blockers.push("契約した提案版を確認できません。運営の承認状態と企業の紐付けを確認してください。");
  if (!selectedProposalId) blockers.push("制作に使う提案版が未記録です。納品用の制作情報を補完してください。");
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
  } else blockers.push("承認済みデザインを持つ提案版が必要です。納品用の制作情報を補完してください。");
  const originalScope = contractProductionScope(contract.snapshot);
  const scopeMissing = !hasProductionScope(originalScope?.scope);
  const scope =
    supplement && scopeMissing
      ? {
          ...originalScope,
          name: originalScope?.name ?? null,
          version: originalScope?.version ?? null,
          price: originalScope?.price ?? null,
          monthlyFee: originalScope?.monthlyFee ?? null,
          scope: supplement.scope,
        }
      : originalScope;
  if (!hasProductionScope(scope?.scope))
    blockers.push("提供範囲が未記録です。契約資料を確認して納品用の制作範囲を補完してください。");
  const proposalMissing = !contract.proposalVersionId || (!!proposal && (designId === undefined || designId === null));
  return {
    company,
    contract,
    proposal: proposal ?? null,
    audit: audit ?? null,
    design,
    scope,
    blockers,
    notices,
    proposalMissing,
    scopeMissing,
  };
}
