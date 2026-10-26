import { createHash } from "node:crypto";
import { DEFAULT_DESIGN_BRIEF } from "@siteoffer/core";
import {
  companies,
  type Db,
  designVersions,
  proposalDocuments,
  proposalVersions,
  salesOffers,
  users,
} from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  PROPOSAL_PDF_CACHE_VERSION,
  type ProposalPdfSnapshot,
  renderProposalPdf,
  serveProposalPdf,
  supplementSnapshot,
} from "./proposal-pdf";
import { seedCandidate, seedTerms, seedUser } from "./test-seed";

let db: Db, close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
  "base64",
);
const proposalText = {
  summary: "架空サイトの相談先を探しやすくする提案です。",
  measures: [
    {
      title: "相談先の案内",
      current: "リンクはフッターにあります。",
      problem: "相談先を探す移動が必要です。",
      improvement: "ヘッダーにも確認済みの連絡先を案内します。",
      priority: "high" as const,
      target: { url: "https://example.test/", location: "フッター" },
      evidenceRefs: ["A1"],
    },
  ],
  strengths: ["現在の事業紹介を残します。"],
  limitations: ["架空の検証用です。"],
};
it("PDFを保存し、キャッシュ後も権限・承認・版の整合性を確認する", async () => {
  const { actor: ops, user: opsUser } = await seedUser(db, "ops"),
    { actor: sales } = await seedUser(db, "sales"),
    c = await seedCandidate(db, { versionStatus: "approved" });
  const [d] = await db
    .insert(designVersions)
    .values({
      companyId: c.company.id,
      auditId: c.audit.id,
      version: 1,
      requestKey: "pdf-fixture",
      status: "approved",
      brief: DEFAULT_DESIGN_BRIEF,
      companySnapshot: { name: c.company.name, url: c.website.url },
      prompt: "fixture",
      source: "import",
      imageBase64: png.toString("base64"),
      imageSha256: createHash("sha256").update(png).digest("hex"),
    })
    .returning();
  await db
    .update(proposalVersions)
    .set({ content: { designVersionId: d!.id, designSha256: d!.imageSha256, proposalText } })
    .where(eq(proposalVersions.id, c.version!.id));
  expect((await serveProposalPdf(db, null, "design", d!.id)).status).toBe(403);
  expect((await serveProposalPdf(db, sales, "design", d!.id)).status).toBe(404);
  expect((await serveProposalPdf(db, sales, "proposal", c.version!.id)).status).toBe(404);
  const first = await serveProposalPdf(db, ops, "proposal", c.version!.id);
  expect(first.status).toBe(200);
  const bytes = Buffer.from(await first.arrayBuffer());
  expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
  expect(first.headers.get("content-disposition")).toContain("-v7.pdf");
  expect((await PDFDocument.load(bytes)).getSubject()).toBe("SiteOffer 提案資料形式 v7");
  expect((await PDFDocument.load(bytes)).getKeywords()).toContain(`design-id=${d!.id}`);
  expect((await PDFDocument.load(bytes)).getKeywords()).toContain(`design-sha256=${d!.imageSha256}`);
  expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(4);
  await db.update(companies).set({ pipelineStatus: "sellable" }).where(eq(companies.id, c.company.id));
  const terms = await seedTerms(db, {
    version: "fixture-offer",
    price: 100000,
    rewardRule: { type: "fixed", amount: 10000 },
  });
  await db
    .insert(salesOffers)
    .values({ companyId: c.company.id, version: 1, productTermsId: terms.id, proposalVersionId: c.version!.id });
  const again = await serveProposalPdf(db, sales, "proposal", c.version!.id);
  expect(again.status).toBe(200);
  expect(
    createHash("sha256")
      .update(Buffer.from(await again.arrayBuffer()))
      .digest("hex"),
  ).toBe(createHash("sha256").update(bytes).digest("hex"));
  const documents = await db.select().from(proposalDocuments);
  expect(documents).toHaveLength(1);
  expect(documents[0]!.documentKey).toBe(`${PROPOSAL_PDF_CACHE_VERSION}:proposal:${c.version!.id}:approved`);
  expect(documents[0]!.snapshot).toMatchObject({
    strengths: proposalText.strengths,
    measures: [{ problem: proposalText.measures[0]!.problem, priority: "high" }],
  });
  expect((documents[0]!.snapshot as ProposalPdfSnapshot).limitations).toContain(proposalText.limitations[0]);
  expect((documents[0]!.snapshot as ProposalPdfSnapshot).limitations).toHaveLength(2);
  expect((documents[0]!.snapshot as { status: string }).status).toContain("架空デモ");
  for (const reader of [
    { kind: "ops" as const, userId: "invalid" },
    { kind: "ops" as const, userId: crypto.randomUUID() },
  ])
    expect((await serveProposalPdf(db, reader, "proposal", c.version!.id)).status).toBe(403);
  await db.update(users).set({ status: "suspended" }).where(eq(users.id, opsUser.id));
  expect((await serveProposalPdf(db, ops, "proposal", c.version!.id)).status).toBe(403);
  await db.update(users).set({ status: "active" }).where(eq(users.id, opsUser.id));
  await db
    .update(proposalDocuments)
    .set({ snapshot: { ...(documents[0]!.snapshot as ProposalPdfSnapshot), name: "別企業" } })
    .where(eq(proposalDocuments.id, documents[0]!.id));
  const invalidCache = await serveProposalPdf(db, ops, "proposal", c.version!.id);
  expect(invalidCache.status).toBe(503);
  expect(invalidCache.headers.get("cache-control")).toBe("private, no-store");
  await db
    .update(proposalVersions)
    .set({ content: { designVersionId: d!.id, designSha256: "mismatch" } })
    .where(eq(proposalVersions.id, c.version!.id));
  expect((await serveProposalPdf(db, ops, "proposal", c.version!.id)).status).toBe(404);
  await db.update(proposalVersions).set({ status: "rejected" }).where(eq(proposalVersions.id, c.version!.id));
  expect((await serveProposalPdf(db, sales, "proposal", c.version!.id)).status).toBe(404);
});
it.each(["pdf-v5", "pdf-v6"])(
  "keeps the %s export date, contents and bytes when adding a new PDF format",
  async (previousFormat) => {
    const { actor } = await seedUser(db, "ops");
    const c = await seedCandidate(db, { versionStatus: "approved" });
    const [design] = await db
      .insert(designVersions)
      .values({
        companyId: c.company.id,
        auditId: c.audit.id,
        version: 1,
        requestKey: "legacy-pdf",
        status: "approved",
        brief: DEFAULT_DESIGN_BRIEF,
        companySnapshot: { name: c.company.name, url: c.website.url },
        prompt: "fixture",
        source: "import",
        imageBase64: png.toString("base64"),
        imageSha256: createHash("sha256").update(png).digest("hex"),
      })
      .returning();
    await db
      .update(proposalVersions)
      .set({ content: { designVersionId: design!.id, designSha256: design!.imageSha256, proposalText } })
      .where(eq(proposalVersions.id, c.version!.id));
    const first = await serveProposalPdf(db, actor, "proposal", c.version!.id);
    expect(first.status).toBe(200);
    const [saved] = await db.select().from(proposalDocuments);
    const legacy = { ...(saved!.snapshot as ProposalPdfSnapshot), date: "2026-10-16T00:00:00Z" };
    legacy.limitations = [legacy.limitations[0]!];
    if (previousFormat === "pdf-v5") {
      delete legacy.strengths;
      for (const measure of legacy.measures) {
        delete measure.problem;
        delete measure.priority;
      }
    }
    const legacyBytes = await renderProposalPdf(legacy, png);
    await db
      .update(proposalDocuments)
      .set({
        documentKey: `${previousFormat}:proposal:${c.version!.id}:approved`,
        snapshot: legacy,
        pdfBase64: legacyBytes.toString("base64"),
        sha256: createHash("sha256").update(legacyBytes).digest("hex"),
      })
      .where(eq(proposalDocuments.id, saved!.id));
    expect((await serveProposalPdf(db, actor, "proposal", c.version!.id)).status).toBe(200);
    const documents = await db.select().from(proposalDocuments);
    expect(documents).toHaveLength(2);
    const old = documents.find((document) => document.id === saved!.id)!;
    expect(old.snapshot).toEqual(legacy);
    expect(Buffer.from(old.pdfBase64, "base64")).toEqual(legacyBytes);
    const updated = documents.find((document) => document.id !== saved!.id)!;
    expect(updated.snapshot).toMatchObject({
      date: legacy.date,
      name: legacy.name,
      strengths: proposalText.strengths,
      limitations: [legacy.limitations[0], ...proposalText.limitations],
      measures: [{ title: legacy.measures[0]!.title, problem: proposalText.measures[0]!.problem, priority: "high" }],
    });
    await db.delete(proposalDocuments).where(eq(proposalDocuments.id, updated.id));
    if (previousFormat === "pdf-v6") {
      await db.insert(proposalDocuments).values({
        documentKey: `pdf-v5:proposal:${c.version!.id}:approved`,
        designVersionId: old.designVersionId,
        snapshot: legacy,
        pdfBase64: legacyBytes.toString("base64"),
        sha256: createHash("sha256").update(legacyBytes).digest("hex"),
      });
    }
    await db
      .update(proposalDocuments)
      .set({ sha256: "0".repeat(64) })
      .where(eq(proposalDocuments.id, old.id));
    expect((await serveProposalPdf(db, actor, "proposal", c.version!.id)).status).toBe(503);
  },
);
it("supplements missing fields only from the same unchanged proposal content", () => {
  const snapshot: ProposalPdfSnapshot = {
    name: "架空",
    url: "https://example.test/",
    date: "2026-10-16T00:00:00Z",
    designVersion: 1,
    designId: "fixture",
    designSha256: "abc",
    status: "確認用",
    source: "fixture",
    brief: DEFAULT_DESIGN_BRIEF,
    proposalVersion: 1,
    summary: proposalText.summary,
    limitations: proposalText.limitations,
    measures: proposalText.measures.map((m) => ({
      title: m.title,
      current: m.current,
      improvement: m.improvement,
      evidence: `${m.target.url} / ${m.target.location} / ${m.evidenceRefs.join(", ")}`,
    })),
  };
  const before = JSON.stringify(snapshot);
  expect(supplementSnapshot(snapshot, proposalText).measures[0]?.priority).toBe("high");
  expect(JSON.stringify(snapshot)).toBe(before);
  expect(supplementSnapshot(snapshot, { ...proposalText, summary: "別の内容" })).toBe(snapshot);
  expect(supplementSnapshot(snapshot, { ...proposalText, limitations: ["別の制約"] })).toBe(snapshot);
  expect(
    supplementSnapshot(snapshot, { ...proposalText, measures: [{ ...proposalText.measures[0]!, current: "変更後" }] }),
  ).toBe(snapshot);
  expect(supplementSnapshot(snapshot, null)).toBe(snapshot);
  const complete = supplementSnapshot(snapshot, proposalText);
  expect(supplementSnapshot(complete, { ...proposalText, strengths: ["変更後の良い点"] })).toBe(complete);
  for (const patch of [{ problem: "変更後の課題" }, { priority: "low" as const }])
    expect(
      supplementSnapshot(complete, { ...proposalText, measures: [{ ...proposalText.measures[0]!, ...patch }] }),
    ).toBe(complete);
});
it("長い日本語はページを増やして欠落させず、フォントを埋め込む", async () => {
  const bytes = await renderProposalPdf(
    {
      name: "長文確認",
      url: "https://example.test",
      date: "2026-10-16T00:00:00Z",
      designVersion: 1,
      designId: "fixture",
      designSha256: "abc",
      status: "確認用",
      source: "fixture",
      brief: { ...DEFAULT_DESIGN_BRIEF, scope: "制作範囲を確認します。".repeat(120) },
      proposalVersion: null,
      summary: null,
      measures: [],
      limitations: [],
    },
    png,
  );
  expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(4);
});
