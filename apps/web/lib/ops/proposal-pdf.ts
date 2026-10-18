import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { type Actor, type DesignBrief, recordEvent, systemClock } from "@siteoffer/core";
import {
  type DbOrTx,
  designVersions,
  findings,
  generationJobs,
  proposalDocuments,
  proposals,
  proposalVersions,
  siteAudits,
  users,
} from "@siteoffer/db";
import { type ProposalText, proposalTextSchema } from "@siteoffer/schemas";
import { and, asc, eq, lte } from "drizzle-orm";
import { PDFDocument, type PDFPage, type RGB, rgb } from "pdf-lib";
import { getCompanyDetail } from "../sales/queries";
import { isUuid } from "./form";
import { compactPdfHeader, wrapPdfText } from "./proposal-pdf-layout";

let fontBytes: Promise<Buffer> | undefined;
export const PROPOSAL_PDF_CACHE_VERSION = "pdf-v6";
const MOCK_PDF_LIMITATION =
  "固定データによる動作検証です。診断結果・改善内容は実企業について確認した事実ではありません。";
const navy = rgb(0.08, 0.15, 0.26),
  blue = rgb(0.19, 0.33, 0.88),
  muted = rgb(0.42, 0.49, 0.59);
export interface ProposalPdfSnapshot {
  name: string;
  url: string;
  date: string;
  designVersion: number;
  designId: string;
  designSha256: string;
  status: string;
  source: string;
  brief: DesignBrief;
  proposalVersion: number | null;
  summary: string | null;
  measures: {
    title: string;
    current: string;
    improvement: string;
    evidence: string;
    problem?: string;
    priority?: "high" | "medium" | "low";
  }[];
  strengths?: string[];
  limitations: string[];
}
/** Embedded Japanese font, measured wrapping, and page breaks; no browser or external URLs. */
export async function renderProposalPdf(snapshot: ProposalPdfSnapshot, png: Buffer): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const localFont = path.join(process.cwd(), "assets/fonts/noto-sans-jp.ttf");
  fontBytes ??= readFile(
    existsSync(localFont) ? localFont : path.join(process.cwd(), "apps/web/assets/fonts/noto-sans-jp.ttf"),
  );
  const font = await pdf.embedFont(await fontBytes, { subset: false, features: { liga: false, kern: false } });
  pdf.setTitle(`${snapshot.name} ウェブサイト改善提案`);
  pdf.setAuthor("SiteOffer");
  pdf.setSubject("SiteOffer 提案資料形式 v6");
  pdf.setCreationDate(new Date(snapshot.date));
  pdf.setModificationDate(new Date(snapshot.date));
  const image = await pdf.embedPng(png);
  let page: PDFPage;
  let y = 0;
  let bodyTop = 469;
  let continuation = "提案内容 / 続き";
  const measure = (size: number) => (text: string) => font.widthOfTextAtSize(text, size);
  function addPage(title: string, subtitle: string, continued = false) {
    page = pdf.addPage([842, 595]);
    if (!continued) continuation = `${title} / 続き`;
    page.drawRectangle({ x: 0, y: 579, width: 842, height: 16, color: navy });
    page.drawText("SiteOffer", { x: 42, y: 545, size: 12, font, color: blue });
    page.drawText(title, { x: 42, y: 512, size: 23, font, color: navy });
    const subtitles = compactPdfHeader(subtitle, measure(9), 758);
    for (const [index, line] of subtitles.entries())
      page.drawText(line, { x: 42, y: 491 - index * 14, size: 9, font, color: muted });
    y = bodyTop = 491 - (subtitles.length - 1) * 14 - 22;
    page.drawLine({ start: { x: 42, y: 36 }, end: { x: 800, y: 36 }, thickness: 0.5, color: rgb(0.85, 0.88, 0.93) });
    const footer = snapshot.status.startsWith("架空デモ")
      ? "非公式のご提案 / 架空デモ・動作検証用 / 実企業への営業資料には使用できません"
      : "非公式のご提案 / 成約・成果を保証するものではありません";
    page.drawText(footer, {
      x: 42,
      y: 22,
      size: 8,
      font,
      color: muted,
    });
    page.drawText("資料形式 v6", { x: 690, y: 22, size: 8, font, color: muted });
    const number = String(pdf.getPageCount()).padStart(2, "0");
    page.drawText(number, { x: 800 - measure(9)(number), y: 22, size: 9, font, color: muted });
  }
  function drawLines(lines: string[], size: number, x: number, color: RGB, tail = 0) {
    const leading = size * 1.7;
    // Keep at least two lines together at both ends of a split paragraph.
    if (lines.length > 1 && y - leading * 2 < 63) addPage(continuation, snapshot.name, true);
    for (const [index, line] of lines.entries()) {
      const remaining = lines.length - index;
      const required = remaining <= 2 ? remaining * leading + tail : leading;
      if (y - required < 63) addPage(continuation, snapshot.name, true);
      page.drawText(line, { x, y, size, font, color });
      y -= leading;
    }
  }
  function paragraph(text: string, size = 11, x = 42, width = 758) {
    drawLines(wrapPdfText(text, measure(size), width), size, x, navy);
    y -= 10;
  }
  function section(title: string, text: string, titleSize = 12) {
    const titles = wrapPdfText(title, measure(titleSize), 758);
    const lines = wrapPdfText(text, measure(11), 758);
    const tail = 8 + Math.min(2, lines.length) * 11 * 1.7;
    const minimum = 10 + titles.length * titleSize * 1.7 + tail;
    if (y - minimum < 63 && y < bodyTop - 1) addPage(continuation, snapshot.name, true);
    y -= 10;
    drawLines(titles, titleSize, 42, blue, tail);
    y -= 8;
    drawLines(lines, 11, 42, navy);
    y -= 10;
  }
  addPage(
    "ウェブサイト改善提案",
    `DESIGN FIRST  /  ${new Date(snapshot.date).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}`,
  );
  y = 445;
  paragraph(snapshot.name, 26);
  y -= 4;
  paragraph(
    `デザイン 第${snapshot.designVersion}版${snapshot.proposalVersion ? ` / サイト提案 第${snapshot.proposalVersion}版` : " / デザイン段階"}`,
    12,
  );
  paragraph(snapshot.status, 10);
  y -= 5;
  section("この提案で目指すこと", snapshot.brief.objective);
  section("想定するお客様", snapshot.brief.audience);
  section(
    "ご検討の流れ",
    "デザインの方向性を確認 / 制作範囲・費用を合意 / サイト制作 / PC・スマホ・更新機能を確認 / 公開。デザイン画像に含まれる写真や文言は提案イメージです。",
  );
  addPage("デザイン案", `${snapshot.name} / デザイン 第${snapshot.designVersion}版 / ${snapshot.status}`);
  const imageHeight = y - 52;
  const scale = Math.min(758 / image.width, imageHeight / image.height);
  const w = image.width * scale,
    h = image.height * scale;
  page!.drawImage(image, { x: (842 - w) / 2, y: 52 + (imageHeight - h) / 2, width: w, height: h });
  addPage("デザイン方針と制作範囲", snapshot.name);
  section("デザインの方向性", snapshot.brief.direction);
  section("制作範囲・確認事項", snapshot.brief.scope);
  section("更新機能・既存データの引き継ぎ", snapshot.brief.updatePlan);
  section(
    "料金・納期",
    "この資料はデザインと改善方針の提案です。料金・納期・保守範囲は別途提示する見積・契約で確定します。",
  );
  if (snapshot.summary || snapshot.strengths?.length) {
    addPage("改善の要点", snapshot.name);
    if (snapshot.summary) section("提案の概要", snapshot.summary);
    if (snapshot.strengths?.length) section("残したい良い点", snapshot.strengths.map((text) => `・${text}`).join("\n"));
  }
  for (const [i, m] of snapshot.measures.entries()) {
    addPage(`改善案 ${String(i + 1).padStart(2, "0")}`, snapshot.name);
    const priority = m.priority ? { high: "高", medium: "中", low: "低" }[m.priority] : null;
    section(
      m.title,
      [
        ...(priority ? [`優先度：${priority}`] : []),
        `現状：${m.current}`,
        ...(m.problem ? [`訪問者にとっての課題：${m.problem}`] : []),
        `改善案：${m.improvement}`,
        `根拠・対象箇所：${m.evidence}`,
      ].join("\n\n"),
      16,
    );
  }
  addPage("確認事項と資料の出典", snapshot.name);
  section(
    "公開前に確認すること",
    "会社情報・掲載文言 / 画像の利用範囲 / 問い合わせ先とフォーム動作 / スマートフォン表示 / お知らせ・ブログの更新とデータ移行 / URLと検索設定。契約・公開の承認は本資料とは別に行います。",
  );
  if (snapshot.limitations.length) section("確認できた範囲・制約", snapshot.limitations.join("\n"));
  section("参照したサイト", snapshot.url);
  section("デザインの出典", snapshot.source);
  section("版の識別", `デザインID：${snapshot.designId}\n画像 SHA-256：${snapshot.designSha256}`);
  return Buffer.from(await pdf.save());
}

/** Authorization runs on every download, including cached PDFs. Sales gets only its currently readable approved proposal. */
export async function serveProposalPdf(db: DbOrTx, actor: Actor | null, kind: "design" | "proposal", id: string) {
  const denied = (status = 404) =>
    new Response(status === 403 ? "Forbidden" : "Not Found", {
      status,
      headers: { "Cache-Control": "private, no-store" },
    });
  if (actor?.kind !== "ops" && actor?.kind !== "sales") return denied(403);
  if (!isUuid(actor.userId)) return denied(403);
  const [reader] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.role, actor.kind), eq(users.status, "active")));
  if (!reader) return denied(403);
  if (!isUuid(id) || (kind === "design" && actor.kind !== "ops")) return denied();
  let designId = id;
  let proposal: typeof proposalVersions.$inferSelect | undefined;
  let proposalCompanyId: string | undefined;
  if (kind === "proposal") {
    const [r] = await db
      .select({ v: proposalVersions, companyId: proposals.companyId })
      .from(proposalVersions)
      .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
      .where(eq(proposalVersions.id, id));
    if (r?.v.status !== "approved") return denied();
    if (actor.kind === "sales") {
      const d = await getCompanyDetail(db, actor, r.companyId);
      if (!d.ok || d.value.proposal?.versionId !== id) return denied();
    }
    proposal = r.v;
    proposalCompanyId = r.companyId;
    designId = (proposal.content as { designVersionId?: string })?.designVersionId ?? "";
    if (!isUuid(designId)) return denied();
  }
  const [d] = await db.select().from(designVersions).where(eq(designVersions.id, designId));
  if (!d?.imageBase64 || !d.imageSha256 || (proposal && d.status !== "approved")) return denied();
  if (
    proposal &&
    (d.companyId !== proposalCompanyId ||
      d.auditId !== proposal.auditId ||
      d.imageSha256 !== (proposal.content as { designSha256?: string })?.designSha256)
  )
    return denied();
  const png = Buffer.from(d.imageBase64, "base64");
  if (createHash("sha256").update(png).digest("hex") !== d.imageSha256)
    return new Response("Artifact integrity error", { status: 503 });
  const key = `${PROPOSAL_PDF_CACHE_VERSION}:${kind}:${id}:${d.status}`;
  let [document] = await db.select().from(proposalDocuments).where(eq(proposalDocuments.documentKey, key));
  if (!document) {
    const company = d.companySnapshot as { name: string; url: string };
    const [evaluation] = await db
      .select({ generator: generationJobs.generator })
      .from(siteAudits)
      .leftJoin(generationJobs, eq(generationJobs.id, siteAudits.generationJobId))
      .where(eq(siteAudits.id, d.auditId));
    const mock =
      evaluation?.generator === "mock" ||
      (proposal?.content as { generator?: string })?.generator === "mock" ||
      /\.(example|test)(?=[:/]|$)/i.test(company.url);
    const parsed = proposalTextSchema.safeParse((proposal?.content as { proposalText?: unknown })?.proposalText);
    const text = parsed.success ? parsed.data : null;
    const observed = text
      ? []
      : await db
          .select()
          .from(findings)
          .where(and(eq(findings.auditId, d.auditId), eq(findings.status, "scored"), lte(findings.score, 1)))
          .orderBy(asc(findings.itemCode))
          .limit(7);
    let snapshot: ProposalPdfSnapshot = {
      name: company.name,
      url: company.url,
      date: systemClock.now().toISOString(),
      designVersion: d.version,
      designId: d.id,
      designSha256: d.imageSha256,
      status: mock
        ? "架空デモ・動作検証用 / 実企業への営業資料には使用できません"
        : proposal
          ? "サイト提案：運営承認済み"
          : d.status === "approved"
            ? "デザイン：運営承認済み / サイト制作前の提案"
            : "デザイン確認用 / 未承認・制作前の提案",
      source:
        d.source === "openai"
          ? `AI生成画像 / 要求モデル：${d.model} / 写真は提案イメージ`
          : "運営が取り込んだデザイン画像 / 写真は提案イメージ",
      brief: d.brief as DesignBrief,
      proposalVersion: proposal?.version ?? null,
      summary: text?.summary ?? null,
      measures:
        text?.measures.map((m) => ({
          title: m.title,
          current: m.current,
          problem: m.problem,
          priority: m.priority,
          improvement: m.improvement,
          evidence: `${m.target.url} / ${m.target.location} / ${m.evidenceRefs.join(", ")}`,
        })) ??
        observed.map((f) => ({
          title: `改善項目 ${f.itemCode}`,
          current: f.reason ?? "診断の観測を確認してください",
          improvement: f.improvementHint ?? "具体的な変更内容は制作前に確認します",
          evidence: company.url,
        })),
      strengths: text?.strengths ?? [],
      limitations: mock
        ? [MOCK_PDF_LIMITATION]
        : (text?.limitations ?? [
            "診断時点で取得できたページの観測に基づきます。サイト全体・実運用のすべてを保証する調査ではありません。",
          ]),
    };
    const [legacy] = await db
      .select()
      .from(proposalDocuments)
      .where(eq(proposalDocuments.documentKey, `pdf-v5:${kind}:${id}:${d.status}`));
    if (legacy) {
      if (!documentMatches(legacy, d, proposal?.version ?? null))
        return new Response("Artifact integrity error", {
          status: 503,
          headers: { "Cache-Control": "private, no-store" },
        });
      // Keep the first export's date and approved content. Only supplement fields from the same,
      // unchanged proposal JSON that the old PDF format did not include.
      snapshot = supplementSnapshot(legacy.snapshot as ProposalPdfSnapshot, text);
    }
    const bytes = await renderProposalPdf(snapshot, png);
    await db.transaction(async (tx) => {
      const rows = await tx
        .insert(proposalDocuments)
        .values({
          documentKey: key,
          designVersionId: d.id,
          snapshot,
          pdfBase64: bytes.toString("base64"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        })
        .onConflictDoNothing()
        .returning({ id: proposalDocuments.id });
      if (rows[0])
        await recordEvent(tx, systemClock, {
          actor,
          action: "proposal_pdf.create",
          targetType: "proposal_document",
          targetId: rows[0].id,
          after: { documentKey: key, designVersionId: d.id },
        });
    });
    [document] = await db.select().from(proposalDocuments).where(eq(proposalDocuments.documentKey, key));
  }
  if (!document) return new Response("PDF unavailable", { status: 503 });
  if (!documentMatches(document, d, proposal?.version ?? null))
    return new Response("Artifact integrity error", { status: 503, headers: { "Cache-Control": "private, no-store" } });
  const bytes = Buffer.from(document.pdfBase64, "base64");
  if (createHash("sha256").update(bytes).digest("hex") !== document.sha256)
    return new Response("Artifact integrity error", { status: 503 });
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="siteoffer-${kind}-${id}-v6.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function isSnapshot(value: unknown): value is ProposalPdfSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (
    !["name", "url", "date", "designId", "designSha256", "status", "source"].every(
      (key) => typeof v[key] === "string",
    ) ||
    !Number.isFinite(Date.parse(v.date as string)) ||
    !Number.isSafeInteger(v.designVersion) ||
    Number(v.designVersion) < 1 ||
    !(v.proposalVersion === null || (Number.isSafeInteger(v.proposalVersion) && Number(v.proposalVersion) > 0)) ||
    !(v.summary === null || typeof v.summary === "string")
  )
    return false;
  const brief = v.brief as Record<string, unknown> | null;
  if (
    !brief ||
    typeof brief !== "object" ||
    !["objective", "audience", "direction", "scope", "updatePlan"].every((key) => typeof brief[key] === "string")
  )
    return false;
  const strings = (input: unknown) => Array.isArray(input) && input.every((item) => typeof item === "string");
  if (!strings(v.limitations) || (v.strengths !== undefined && !strings(v.strengths)) || !Array.isArray(v.measures))
    return false;
  return v.measures.every((m: unknown) => {
    if (!m || typeof m !== "object" || Array.isArray(m)) return false;
    const measure = m as Record<string, unknown>;
    return (
      ["title", "current", "improvement", "evidence"].every((key) => typeof measure[key] === "string") &&
      (measure.problem === undefined || typeof measure.problem === "string") &&
      (measure.priority === undefined || ["high", "medium", "low"].includes(String(measure.priority)))
    );
  });
}
function documentMatches(
  document: typeof proposalDocuments.$inferSelect,
  design: typeof designVersions.$inferSelect,
  proposalVersion: number | null,
) {
  const snapshot = document.snapshot;
  const company = design.companySnapshot as { name?: unknown; url?: unknown };
  return (
    document.designVersionId === design.id &&
    isSnapshot(snapshot) &&
    snapshot.designId === design.id &&
    snapshot.designVersion === design.version &&
    snapshot.designSha256 === design.imageSha256 &&
    snapshot.proposalVersion === proposalVersion &&
    snapshot.name === company?.name &&
    snapshot.url === company?.url &&
    createHash("sha256").update(Buffer.from(document.pdfBase64, "base64")).digest("hex") === document.sha256
  );
}
export function supplementSnapshot(snapshot: ProposalPdfSnapshot, text: ProposalText | null): ProposalPdfSnapshot {
  const originalMockLimitation =
    snapshot.status.startsWith("架空デモ") &&
    snapshot.limitations.length === 1 &&
    snapshot.limitations[0] === MOCK_PDF_LIMITATION;
  if (
    !text ||
    snapshot.summary !== text.summary ||
    snapshot.measures.length !== text.measures.length ||
    (!originalMockLimitation && JSON.stringify(snapshot.limitations) !== JSON.stringify(text.limitations))
  )
    return snapshot;
  const unchanged = snapshot.measures.every((old, index) => {
    const item = text.measures[index]!;
    return (
      old.title === item.title &&
      old.current === item.current &&
      old.improvement === item.improvement &&
      old.evidence === `${item.target.url} / ${item.target.location} / ${item.evidenceRefs.join(", ")}`
    );
  });
  if (!unchanged) return snapshot;
  return {
    ...snapshot,
    strengths: snapshot.strengths ?? text.strengths,
    measures: snapshot.measures.map((old, index) => ({
      ...old,
      problem: old.problem ?? text.measures[index]!.problem,
      priority: old.priority ?? text.measures[index]!.priority,
    })),
  };
}
