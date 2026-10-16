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
} from "@siteoffer/db";
import { proposalTextSchema } from "@siteoffer/schemas";
import { and, asc, eq, lte } from "drizzle-orm";
import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import { getCompanyDetail } from "../sales/queries";
import { isUuid } from "./form";

let fontBytes: Promise<Buffer> | undefined;
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
  measures: { title: string; current: string; improvement: string; evidence: string }[];
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
  pdf.setCreationDate(new Date(snapshot.date));
  pdf.setModificationDate(new Date(snapshot.date));
  const image = await pdf.embedPng(png);
  let page: PDFPage;
  let y = 0;
  function addPage(title: string, subtitle: string) {
    page = pdf.addPage([842, 595]);
    y = 480;
    page.drawRectangle({ x: 0, y: 579, width: 842, height: 16, color: navy });
    page.drawText("SiteOffer", { x: 42, y: 545, size: 12, font, color: blue });
    page.drawText(title, { x: 42, y: 512, size: 23, font, color: navy });
    page.drawText(subtitle, { x: 42, y: 491, size: 9, font, color: muted });
    page.drawLine({ start: { x: 42, y: 36 }, end: { x: 800, y: 36 }, thickness: 0.5, color: rgb(0.85, 0.88, 0.93) });
    page.drawText("非公式のご提案 / 成約・成果を保証するものではありません", {
      x: 42,
      y: 22,
      size: 8,
      font,
      color: muted,
    });
    page.drawText(String(pdf.getPageCount()).padStart(2, "0"), { x: 783, y: 22, size: 9, font, color: muted });
  }
  function paragraph(text: string, size = 11, x = 42, width = 758) {
    const lines = wrap(text, font, size, width);
    for (const line of lines) {
      if (y < 63) addPage("提案内容 / 続き", snapshot.name);
      page.drawText(line, { x, y, size, font, color: navy });
      y -= size * 1.7;
    }
    y -= 10;
  }
  function section(title: string, text: string) {
    if (y < 125) addPage("提案内容 / 続き", snapshot.name);
    y -= 10;
    page.drawText(title, { x: 42, y, size: 12, font, color: blue });
    y -= 24;
    paragraph(text);
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
  addPage("完成イメージ", `${snapshot.name} / デザイン 第${snapshot.designVersion}版 / ${snapshot.status}`);
  const scale = Math.min(758 / image.width, 425 / image.height);
  const w = image.width * scale,
    h = image.height * scale;
  page!.drawImage(image, { x: (842 - w) / 2, y: 52 + (425 - h) / 2, width: w, height: h });
  addPage("デザイン方針と制作範囲", snapshot.name);
  section("デザインの方向性", snapshot.brief.direction);
  section("制作範囲・確認事項", snapshot.brief.scope);
  section("更新機能・既存データの引き継ぎ", snapshot.brief.updatePlan);
  section(
    "料金・納期",
    "この資料はデザインと改善方針の提案です。料金・納期・保守範囲は別途提示する見積・契約で確定します。",
  );
  if (snapshot.summary || snapshot.measures.length) {
    addPage("観測に基づく改善提案", snapshot.name);
    if (snapshot.summary) paragraph(snapshot.summary);
    for (const [i, m] of snapshot.measures.entries()) {
      section(
        `${String(i + 1).padStart(2, "0")}  ${m.title}`,
        `現状：${m.current}\n改善：${m.improvement}\n根拠：${m.evidence}`,
      );
    }
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
function wrap(text: string, font: PDFFont, size: number, width: number) {
  const lines: string[] = [];
  const widths = new Map<string, number>();
  for (const paragraph of Array.from(text)
    .filter((c) => c === "\n" || c.charCodeAt(0) >= 32)
    .join("")
    .split("\n")) {
    let line = "",
      length = 0;
    for (const ch of paragraph) {
      let w = widths.get(ch);
      if (w === undefined) {
        w = font.widthOfTextAtSize(ch, size);
        widths.set(ch, w);
      }
      if (line && length + w > width) {
        lines.push(line);
        line = "";
        length = 0;
      }
      line += ch;
      length += w;
    }
    lines.push(line);
  }
  return lines;
}

/** Authorization runs on every download, including cached PDFs. Sales gets only its currently readable approved proposal. */
export async function serveProposalPdf(db: DbOrTx, actor: Actor | null, kind: "design" | "proposal", id: string) {
  const denied = (status = 404) =>
    new Response(status === 403 ? "Forbidden" : "Not Found", {
      status,
      headers: { "Cache-Control": "private, no-store" },
    });
  if (actor?.kind !== "ops" && actor?.kind !== "sales") return denied(403);
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
    if (!r || r.v.status !== "approved") return denied();
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
  const key = `pdf-v5:${kind}:${id}:${d.status}`;
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
    const snapshot: ProposalPdfSnapshot = {
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
          improvement: m.improvement,
          evidence: `${m.target.url} / ${m.target.location} / ${m.evidenceRefs.join(", ")}`,
        })) ??
        observed.map((f) => ({
          title: `改善項目 ${f.itemCode}`,
          current: f.reason ?? "診断の観測を確認してください",
          improvement: f.improvementHint ?? "具体的な変更内容は制作前に確認します",
          evidence: company.url,
        })),
      limitations: mock
        ? ["固定データによる動作検証です。診断結果・改善内容は実企業について確認した事実ではありません。"]
        : (text?.limitations ?? [
            "診断時点で取得できたページの観測に基づきます。サイト全体・実運用のすべてを保証する調査ではありません。",
          ]),
    };
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
  const bytes = Buffer.from(document.pdfBase64, "base64");
  if (createHash("sha256").update(bytes).digest("hex") !== document.sha256)
    return new Response("Artifact integrity error", { status: 503 });
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="siteoffer-${kind}-${id}.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
