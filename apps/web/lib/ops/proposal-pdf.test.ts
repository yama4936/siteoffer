import { createHash } from "node:crypto";
import { DEFAULT_DESIGN_BRIEF } from "@siteoffer/core";
import { companies, type Db, designVersions, proposalDocuments, proposalVersions, salesOffers } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, expect, it } from "vitest";
import { renderProposalPdf, serveProposalPdf } from "./proposal-pdf";
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
it("PDFを保存し、キャッシュ後も権限・承認・版の整合性を確認する", async () => {
  const { actor: ops } = await seedUser(db, "ops"),
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
    .set({ content: { designVersionId: d!.id, designSha256: d!.imageSha256 } })
    .where(eq(proposalVersions.id, c.version!.id));
  expect((await serveProposalPdf(db, null, "design", d!.id)).status).toBe(403);
  expect((await serveProposalPdf(db, sales, "design", d!.id)).status).toBe(404);
  expect((await serveProposalPdf(db, sales, "proposal", c.version!.id)).status).toBe(404);
  const first = await serveProposalPdf(db, ops, "proposal", c.version!.id);
  expect(first.status).toBe(200);
  const bytes = Buffer.from(await first.arrayBuffer());
  expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
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
  expect((documents[0]!.snapshot as { status: string }).status).toContain("架空デモ");
  await db
    .update(proposalVersions)
    .set({ content: { designVersionId: d!.id, designSha256: "mismatch" } })
    .where(eq(proposalVersions.id, c.version!.id));
  expect((await serveProposalPdf(db, ops, "proposal", c.version!.id)).status).toBe(404);
  await db.update(proposalVersions).set({ status: "rejected" }).where(eq(proposalVersions.id, c.version!.id));
  expect((await serveProposalPdf(db, sales, "proposal", c.version!.id)).status).toBe(404);
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
