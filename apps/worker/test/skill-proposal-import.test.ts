import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fixedClock } from "@siteoffer/core";
import { seedCompany, seedUser } from "@siteoffer/core/share-link/testing";
import { auditEvents, type Db, proposals, proposalVersions, siteAudits, websites } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importSkillProposalVersion } from "../src/skills/proposal-import.ts";

let db: Db;
let close: () => Promise<void>;
let temp: string;
const clock = fixedClock("2026-10-14T12:00:00Z");
const system = { kind: "system", job: "test" } as const;

async function makeArtifact(root: string) {
  await mkdir(path.join(root, "site"), { recursive: true });
  await writeFile(path.join(root, "site/index.html"), "<!doctype html><title>企業固有デモ</title>");
  await writeFile(
    path.join(root, "proposal.json"),
    JSON.stringify({
      summary: { headline: "見出し", direction: "改善方針" },
      actions: [
        {
          id: "P-01",
          title: "スマホ表示を改善",
          issue_ids: ["D1"],
          priority: "high",
          target: { url: "https://example.test/", location: "サイト全体" },
          current: "固定幅で表示される",
          problem: "スマホで読みづらい",
          change: { description: "レスポンシブ構成へ変更する" },
          scope: "in_scope",
        },
      ],
      sales_points: ["既存の強みを残す"],
      limitations: ["効果は保証しない"],
      open_questions: ["問い合わせ先"],
    }),
  );
}

async function makeAudit(companyId: string, artifactDir: string, suffix: string) {
  const [website] = await db
    .insert(websites)
    .values({
      companyId,
      url: `https://${suffix}.example.test/`,
      normalizedUrl: `${suffix}.example.test/`,
      domain: `${suffix}.example.test`,
      isPrimary: true,
    })
    .returning();
  const [audit] = await db
    .insert(siteAudits)
    .values({
      companyId,
      websiteId: website!.id,
      status: "evaluated",
      targetUrl: website!.url,
      artifactDir,
    })
    .returning();
  return audit!;
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  temp = await mkdtemp(path.join(os.tmpdir(), "siteoffer-skill-proposal-"));
});

afterEach(async () => {
  await close();
  await rm(temp, { recursive: true, force: true });
});

describe("skill成果物の提案版取り込み", () => {
  it("既存の承認済み版を変えず、同じ会社・評価のsiteだけをin_reviewの新しい版へ取り込む", async () => {
    const company = await seedCompany(db);
    const artifact = path.join(temp, "company-a");
    await makeArtifact(artifact);
    const audit = await makeAudit(company.id, artifact, "a");
    const [proposal] = await db.insert(proposals).values({ companyId: company.id }).returning();
    const [old] = await db
      .insert(proposalVersions)
      .values({
        proposalId: proposal!.id,
        version: 1,
        status: "approved",
        auditId: audit.id,
        demoArtifactDir: "/immutable/old-demo",
      })
      .returning();

    const result = await importSkillProposalVersion(db, clock, system, audit.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toBe(true);
    expect(result.value.version).toMatchObject({ version: 2, status: "in_review", auditId: audit.id });
    expect(result.value.version.demoArtifactDir).toBe(await realpath(path.join(artifact, "site")));
    const [unchanged] = await db.select().from(proposalVersions).where(eq(proposalVersions.id, old!.id));
    expect(unchanged!.demoArtifactDir).toBe("/immutable/old-demo");
    expect(unchanged!.status).toBe("approved");
    expect(
      await db.select().from(auditEvents).where(eq(auditEvents.action, "proposal_version.import_skill_artifact")),
    ).toHaveLength(1);

    const again = await importSkillProposalVersion(db, clock, system, audit.id);
    expect(again.ok && again.value.created).toBe(false);
    expect(await db.select().from(proposalVersions)).toHaveLength(2);
  });

  it("営業ユーザーは取り込めず、相対パス・成果物外へのsiteリンクも拒否する", async () => {
    const company = await seedCompany(db);
    const sales = await seedUser(db, "sales");
    const valid = path.join(temp, "valid");
    await makeArtifact(valid);
    const audit = await makeAudit(company.id, valid, "valid");
    expect(await importSkillProposalVersion(db, clock, sales.actor, audit.id)).toMatchObject({
      ok: false,
      error: "forbidden",
    });

    const relative = await makeAudit(company.id, "reports/relative", "relative");
    expect(await importSkillProposalVersion(db, clock, system, relative.id)).toMatchObject({
      ok: false,
      error: "artifact_missing",
    });

    const outside = path.join(temp, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "index.html"), "outside");
    const linkedRoot = path.join(temp, "linked");
    await mkdir(linkedRoot);
    await writeFile(path.join(linkedRoot, "proposal.json"), "{}");
    await symlink(outside, path.join(linkedRoot, "site"));
    const linked = await makeAudit(company.id, linkedRoot, "linked");
    expect(await importSkillProposalVersion(db, clock, system, linked.id)).toMatchObject({
      ok: false,
      error: "artifact_missing",
    });
    expect(await db.select().from(proposalVersions)).toHaveLength(0);
  });
});
