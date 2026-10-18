import { createHash, randomUUID } from "node:crypto";
import { type Actor, DEFAULT_DESIGN_BRIEF } from "@siteoffer/core";
import { type Db, designVersions, proposalVersions } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readReviewDesign, serveReviewDesignImage } from "./review-design";
import { seedCandidate, seedUser } from "./test-seed";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
  "base64",
);
const hash = createHash("sha256").update(png).digest("hex");
let db: Db, close: () => Promise<void>, ops: Actor;
let candidate: Awaited<ReturnType<typeof seedCandidate>>;
let design: typeof designVersions.$inferSelect;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  ({ actor: ops } = await seedUser(db, "ops"));
  candidate = await seedCandidate(db);
  const [row] = await db
    .insert(designVersions)
    .values({
      companyId: candidate.company.id,
      auditId: candidate.audit.id,
      version: 1,
      requestKey: randomUUID(),
      status: "approved",
      brief: DEFAULT_DESIGN_BRIEF,
      companySnapshot: { name: candidate.company.name },
      prompt: "fixture",
      source: "import",
      imageBase64: png.toString("base64"),
      imageSha256: hash,
      width: 1536,
      height: 1024,
    })
    .returning();
  design = row!;
  await setContent({ designVersionId: design.id, designSha256: hash });
}, 60_000);

afterEach(async () => {
  await close?.();
});

async function setContent(content: unknown) {
  await db.update(proposalVersions).set({ content }).where(eq(proposalVersions.id, candidate.version!.id));
}

it("選択中の提案の承認画像を読み取り、同じ版・診断へ戻れる", async () => {
  const reference = await readReviewDesign(db, ops, candidate.version!.id);
  expect(reference).toEqual({
    id: design.id,
    version: 1,
    width: 1536,
    height: 1024,
    imageUrl: `/ops/review/design/${candidate.version!.id}`,
    studioHref: `/ops/designs?company=${candidate.company.id}&design=${design.id}&audit=${candidate.audit.id}`,
  });
  expect(JSON.stringify(reference)).not.toContain(png.toString("base64"));
  const response = await serveReviewDesignImage(db, ops, candidate.version!.id);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
});

it("別の画像版や提案が増えても、過去の提案の画像を置き換えない", async () => {
  const [newDesign] = await db
    .insert(designVersions)
    .values({
      ...design,
      id: randomUUID(),
      version: 2,
      requestKey: randomUUID(),
      imageSha256: "b".repeat(64),
    })
    .returning();
  const [newProposal] = await db
    .insert(proposalVersions)
    .values({
      proposalId: candidate.proposal.id,
      auditId: candidate.audit.id,
      version: 2,
      status: "in_review",
      content: { designVersionId: newDesign!.id, designSha256: "b".repeat(64) },
    })
    .returning();
  expect((await readReviewDesign(db, ops, candidate.version!.id))?.id).toBe(design.id);
  expect((await readReviewDesign(db, ops, newProposal!.id))?.id).toBe(newDesign!.id);
  expect((await serveReviewDesignImage(db, ops, candidate.version!.id)).status).toBe(200);
  await db.update(proposalVersions).set({ status: "rejected" }).where(eq(proposalVersions.id, candidate.version!.id));
  expect((await readReviewDesign(db, ops, candidate.version!.id))?.id).toBe(design.id);
});

it("営業・未認証を拒否し、不正・存在しない提案は画像を返さない", async () => {
  const { actor: sales } = await seedUser(db, "sales");
  for (const actor of [null, sales]) {
    expect(await readReviewDesign(db, actor, candidate.version!.id)).toBeNull();
    expect((await serveReviewDesignImage(db, actor, candidate.version!.id)).status).toBe(403);
  }
  for (const id of ["invalid", randomUUID()]) {
    expect(await readReviewDesign(db, ops, id)).toBeNull();
    expect((await serveReviewDesignImage(db, ops, id)).status).toBe(404);
  }
});

it("紐づけのない旧提案・不正な参照・画像ハッシュの違いは最新画像で代用しない", async () => {
  for (const content of [
    null,
    [],
    "invalid",
    {},
    { designVersionId: "invalid", designSha256: hash },
    { designVersionId: design.id },
    { designVersionId: design.id, designSha256: "b".repeat(64) },
  ]) {
    await setContent(content);
    expect(await readReviewDesign(db, ops, candidate.version!.id)).toBeNull();
    expect((await serveReviewDesignImage(db, ops, candidate.version!.id)).status).toBe(404);
  }
});

it("別会社または別診断の承認画像を、この提案の制作元として表示しない", async () => {
  const other = await seedCandidate(db);
  await db.update(designVersions).set({ companyId: other.company.id }).where(eq(designVersions.id, design.id));
  expect(await readReviewDesign(db, ops, candidate.version!.id)).toBeNull();
  expect((await serveReviewDesignImage(db, ops, candidate.version!.id)).status).toBe(404);
  await db
    .update(designVersions)
    .set({ companyId: candidate.company.id, auditId: other.audit.id })
    .where(eq(designVersions.id, design.id));
  expect(await readReviewDesign(db, ops, candidate.version!.id)).toBeNull();
  expect((await serveReviewDesignImage(db, ops, candidate.version!.id)).status).toBe(404);
});

it("承認と画像の存在をリクエストごとに確認する", async () => {
  expect(await readReviewDesign(db, ops, candidate.version!.id)).not.toBeNull();
  for (const status of ["draft", "in_review", "rejected", "failed"] as const) {
    await db.update(designVersions).set({ status }).where(eq(designVersions.id, design.id));
    expect(await readReviewDesign(db, ops, candidate.version!.id)).toBeNull();
    expect((await serveReviewDesignImage(db, ops, candidate.version!.id)).status).toBe(404);
  }
  await db
    .update(designVersions)
    .set({ status: "approved", imageBase64: null })
    .where(eq(designVersions.id, design.id));
  expect(await readReviewDesign(db, ops, candidate.version!.id)).toBeNull();
});

it("保存画像の改変やPNGでないデータは整合性エラーにする", async () => {
  const altered = Buffer.from(png);
  altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
  await db
    .update(designVersions)
    .set({ imageBase64: altered.toString("base64") })
    .where(eq(designVersions.id, design.id));
  expect((await serveReviewDesignImage(db, ops, candidate.version!.id)).status).toBe(503);
  const bytes = Buffer.from("<html>not an image</html>");
  const badHash = createHash("sha256").update(bytes).digest("hex");
  await db
    .update(designVersions)
    .set({ imageBase64: bytes.toString("base64"), imageSha256: badHash })
    .where(eq(designVersions.id, design.id));
  await setContent({ designVersionId: design.id, designSha256: badHash });
  expect((await serveReviewDesignImage(db, ops, candidate.version!.id)).status).toBe(503);
});
