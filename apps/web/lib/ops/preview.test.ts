import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { companies, type Db, proposalVersions, salesOffers } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { serveSalesPreview } from "../sales/site-preview";
import { serveOpsPreview } from "./preview";
import { seedCandidate, seedTerms, seedUser } from "./test-seed";

let db: Db;
let close: () => Promise<void>;
let root: string;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  root = await mkdtemp(path.join(os.tmpdir(), "siteoffer-ops-preview-"));
}, 60_000);
afterEach(async () => {
  await close?.();
  if (root) await rm(root, { recursive: true, force: true });
});

it("sales sees only the approved version of a readable company", async () => {
  const { actor: sales } = await seedUser(db, "sales");
  const { actor: ops } = await seedUser(db, "ops");
  const { company, proposal, version } = await seedCandidate(db, { versionStatus: "approved" });
  await writeFile(path.join(root, "index.html"), "approved preview");
  await db.update(proposalVersions).set({ demoArtifactDir: root }).where(eq(proposalVersions.id, version!.id));
  expect((await serveSalesPreview(db, sales, company.id, "/index.html")).status).toBe(404);
  await db.update(companies).set({ pipelineStatus: "sellable" }).where(eq(companies.id, company.id));
  const terms = await seedTerms(db, {
    version: "fixture-offer",
    price: 100000,
    rewardRule: { type: "fixed", amount: 10000 },
  });
  await db
    .insert(salesOffers)
    .values({ companyId: company.id, version: 1, productTermsId: terms.id, proposalVersionId: version!.id });
  await db.insert(proposalVersions).values({
    proposalId: proposal.id,
    version: 2,
    status: "in_review",
    demoArtifactDir: path.join(root, "unapproved"),
  });
  const response = await serveSalesPreview(db, sales, company.id, "/index.html");
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("approved preview");
  expect((await serveSalesPreview(db, null, company.id, "/index.html")).status).toBe(403);
  expect((await serveSalesPreview(db, ops, company.id, "/index.html")).status).toBe(403);
  expect((await serveSalesPreview(db, sales, company.id, "/../secret.txt")).status).toBe(404);
});

it("serves the selected version, denies other roles and rejects escaped paths", async () => {
  const { actor: ops } = await seedUser(db, "ops");
  const { actor: sales } = await seedUser(db, "sales");
  const { proposal, version } = await seedCandidate(db);
  await mkdir(path.join(root, "first"));
  await mkdir(path.join(root, "second"));
  await writeFile(path.join(root, "first", "index.html"), "<h1>First version</h1>");
  await writeFile(path.join(root, "second", "index.html"), "<h1>Second version</h1>");
  await writeFile(path.join(root, "secret.txt"), "outside preview");
  await db
    .update(proposalVersions)
    .set({ demoArtifactDir: path.join(root, "first") })
    .where(eq(proposalVersions.id, version!.id));
  const [second] = await db
    .insert(proposalVersions)
    .values({ proposalId: proposal.id, version: 2, status: "in_review", demoArtifactDir: path.join(root, "second") })
    .returning();
  const first = await serveOpsPreview(db, ops, version!.id, "/index.html");
  expect(first.status).toBe(200);
  expect(await first.text()).toContain("First version");
  expect(await (await serveOpsPreview(db, ops, second!.id, "/index.html")).text()).toContain("Second version");
  expect(first.headers.get("content-security-policy")).toContain("sandbox allow-same-origin");
  expect(first.headers.get("cache-control")).toBe("private, no-store");
  expect((await serveOpsPreview(db, sales, version!.id, "/index.html")).status).toBe(403);
  expect((await serveOpsPreview(db, null, version!.id, "/index.html")).status).toBe(403);
  for (const input of ["/../secret.txt", "/%2e%2e/secret.txt", "/%2fsecret.txt", "/.env", "/missing.html"]) {
    expect((await serveOpsPreview(db, ops, version!.id, input)).status).toBe(404);
  }
  expect((await serveOpsPreview(db, ops, "invalid", "/index.html")).status).toBe(404);
});
