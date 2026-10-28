import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fixedClock } from "@siteoffer/core";
import { seedCompany, seedUser } from "@siteoffer/core/share-link/testing";
import { auditEvents, companies, type Db, proposals, proposalVersions, siteAudits, websites } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ProposalAiCheck, runProposalPrecheck } from "../src/skills/precheck.ts";
import { recheckInReviewProposalVersions } from "../src/skills/precheck-recheck.ts";
import { importSkillProposalVersion } from "../src/skills/proposal-import.ts";
import { REPO_ROOT } from "./helpers.ts";
import { fakePython, makePrecheckSite } from "./precheck-fixture.ts";

let db: Db;
let close: () => Promise<void>;
let temp: string;
const clock = fixedClock("2026-10-14T12:00:00Z");
const system = { kind: "system", job: "test" } as const;
const repo = { repoRoot: REPO_ROOT };
/** 事前チェックの前提を満たす企業（評価済み・公式サイト確認済み・営業抑止なし） */
const auditedCompany = () => seedCompany(db, { pipelineStatus: "audited", officialSiteStatus: "confirmed" });

/** 実際の check.py を通る最小サイト（fixtures/make-precheck-site.py）と提案書を置く */
async function makeArtifact(root: string) {
  makePrecheckSite(path.join(root, "site"));
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
    const company = await auditedCompany();
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

    const result = await importSkillProposalVersion(db, clock, system, audit.id, repo);
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

    const again = await importSkillProposalVersion(db, clock, system, audit.id, repo);
    expect(again.ok && again.value.created).toBe(false);
    expect(await db.select().from(proposalVersions)).toHaveLength(2);
  });

  it("営業ユーザーは取り込めず、相対パス・成果物外へのsiteリンクも拒否する", async () => {
    const company = await auditedCompany();
    const sales = await seedUser(db, "sales");
    const valid = path.join(temp, "valid");
    await makeArtifact(valid);
    const audit = await makeAudit(company.id, valid, "valid");
    expect(await importSkillProposalVersion(db, clock, sales.actor, audit.id, repo)).toMatchObject({
      ok: false,
      error: "forbidden",
    });

    const relative = await makeAudit(company.id, "reports/relative", "relative");
    expect(await importSkillProposalVersion(db, clock, system, relative.id, repo)).toMatchObject({
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
    expect(await importSkillProposalVersion(db, clock, system, linked.id, repo)).toMatchObject({
      ok: false,
      error: "artifact_missing",
    });
    expect(await db.select().from(proposalVersions)).toHaveLength(0);
  });
});

describe("AIの事前チェック", () => {
  it("実際の check.py・check_mobile_quality.py で判定する（合格の最小サイトと、壊したサイト）", async () => {
    const siteDir = path.join(temp, "real/site");
    makePrecheckSite(siteDir);
    const company = { officialSiteStatus: "confirmed", suppression: "none" };
    const passed = await runProposalPrecheck({ repoRoot: REPO_ROOT, siteDir, company, now: clock.now() });
    expect(passed.status).toBe("passed");
    expect(passed.items.map((i) => [i.key, i.ok])).toEqual([
      ["company", true],
      ["devices", true],
      ["links", true],
      ["continuity", true],
    ]);
    expect(passed.checker.checkPy).toMatch(/^[0-9a-f]{64}$/);
    expect(passed.siteDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(passed.checkedAt).toBe("2026-10-14T12:00:00.000Z");

    // リンク切れを足すと links が不合格になり、サイトのハッシュも変わる
    const index = path.join(siteDir, "index.html");
    await writeFile(
      index,
      (await readFile(index, "utf8")).replace("</body>", '<a href="missing.html">詳細</a></body>'),
    );
    // スマホ品質を合格線（12/15）未満にする（総合点は80点以上のまま）
    const qrPath = path.join(siteDir, "quality-review.json");
    const qr = JSON.parse(await readFile(qrPath, "utf8"));
    qr.scores.mobile = 11;
    qr.scores.polish = 10;
    qr.total = Object.values(qr.scores as Record<string, number>).reduce((a, b) => a + b, 0);
    await writeFile(qrPath, JSON.stringify(qr));
    const broken = await runProposalPrecheck({
      repoRoot: REPO_ROOT,
      siteDir,
      company: { officialSiteStatus: "confirmed", suppression: "do_not_contact" },
      now: clock.now(),
    });
    expect(broken.status).toBe("failed");
    const byKey = Object.fromEntries(broken.items.map((i) => [i.key, i]));
    expect(byKey.links!.ok).toBe(false);
    expect(byKey.links!.details.join("\n")).toContain("broken_link");
    expect(byKey.devices!.ok).toBe(false);
    expect(byKey.devices!.details.join("\n")).toContain("12/15");
    expect(byKey.company!.details.join("\n")).toContain("営業抑止");
    expect(byKey.continuity!.ok).toBe(true);
    expect(broken.siteDigest).not.toBe(passed.siteDigest);
  });

  it("合格：in_review と aiCheck を保存し、同じトランザクションで企業を audited→in_review へ進める", async () => {
    const company = await auditedCompany();
    const artifact = path.join(temp, "pass");
    await makeArtifact(artifact);
    const audit = await makeAudit(company.id, artifact, "pass");
    const result = await importSkillProposalVersion(db, clock, system, audit.id, repo);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.version.status).toBe("in_review");
    const content = result.value.version.content as { aiCheck: ProposalAiCheck; failure: unknown };
    expect(content.aiCheck.status).toBe("passed");
    expect(content.failure).toBeNull();
    const [after] = await db.select().from(companies).where(eq(companies.id, company.id));
    expect(after!.pipelineStatus).toBe("in_review");
    const events = await db.select().from(auditEvents);
    const imported = events.find((e) => e.action === "proposal_version.import_skill_artifact");
    expect(imported?.after).toMatchObject({ status: "in_review", aiCheck: { status: "passed", failedItems: [] } });
    expect(events.some((e) => e.action === "company.pipeline_status_changed")).toBe(true);
    expect(events.some((e) => e.action === "proposal_version.ai_precheck_failed")).toBe(false);
  });

  it("不合格：failed と理由・aiCheck を残し、企業の状態は変えない。成果物の自己申告（site-check.json）は使わない", async () => {
    const company = await auditedCompany();
    const artifact = path.join(temp, "fail");
    await makeArtifact(artifact);
    await writeFile(path.join(artifact, "site-check.json"), JSON.stringify({ ok: true, errors: [] }));
    const audit = await makeAudit(company.id, artifact, "fail");
    const python = fakePython({
      ok: false,
      errors: [
        { file: "content-plan.json", line: null, check: "feature_parity", message: "主要機能が欠落" },
        { file: "index.html", line: 3, check: "external_resource", message: "外部リソースを読み込んでいる" },
      ],
    });
    const result = await importSkillProposalVersion(db, clock, system, audit.id, { ...repo, python: python.run });
    if (!result.ok) throw new Error(result.error);
    const siteDir = await realpath(path.join(artifact, "site"));
    expect(python.calls).toEqual([
      { script: path.join(REPO_ROOT, ".agents/skills/site-rebuild/scripts/check.py"), args: [siteDir] },
      { script: path.join(REPO_ROOT, ".agents/skills/site-rebuild/scripts/check_mobile_quality.py"), args: [siteDir] },
    ]);
    const v = result.value.version;
    expect(v.status).toBe("failed");
    const content = v.content as { aiCheck: ProposalAiCheck; failure: string };
    expect(content.failure).toContain("リンク・フォーム・外部読み込み");
    expect(content.failure).toContain("元サイトからの引き継ぎ");
    expect(content.aiCheck.items.filter((i) => !i.ok).map((i) => i.key)).toEqual(["links", "continuity"]);
    const [after] = await db.select().from(companies).where(eq(companies.id, company.id));
    expect(after!.pipelineStatus).toBe("audited");
    const failedEvents = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "proposal_version.ai_precheck_failed"));
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]!.after).toMatchObject({
      aiCheck: { status: "failed", failedItems: ["links", "continuity"] },
    });

    // 同じ成果物の再取り込みは検査し直さず、同じ版を返す
    const again = await importSkillProposalVersion(db, clock, system, audit.id, { ...repo, python: python.run });
    expect(again.ok && !again.value.created && again.value.version.id).toBe(v.id);
    expect(python.calls).toHaveLength(2);
  });

  it("検査スクリプトを動かせないときは版を作らない", async () => {
    const company = await auditedCompany();
    const artifact = path.join(temp, "noscript");
    await makeArtifact(artifact);
    const audit = await makeAudit(company.id, artifact, "noscript");
    expect(await importSkillProposalVersion(db, clock, system, audit.id, { repoRoot: temp })).toMatchObject({
      ok: false,
      error: "precheck_unavailable",
    });
    const broken = async () => ({ code: 1, stdout: "not json", stderr: "" });
    expect(await importSkillProposalVersion(db, clock, system, audit.id, { ...repo, python: broken })).toMatchObject({
      ok: false,
      error: "precheck_unavailable",
    });
    expect(await db.select().from(proposalVersions)).toHaveLength(0);
  });

  it("再チェック：aiCheck のない in_review の版に aiCheck だけを書き、状態は変えない", async () => {
    const company = await seedCompany(db, { pipelineStatus: "in_review", officialSiteStatus: "confirmed" });
    const artifact = path.join(temp, "recheck");
    await makeArtifact(artifact);
    const audit = await makeAudit(company.id, artifact, "recheck");
    const siteDir = await realpath(path.join(artifact, "site"));
    const [proposal] = await db.insert(proposals).values({ companyId: company.id }).returning();
    const [old] = await db
      .insert(proposalVersions)
      .values({
        proposalId: proposal!.id,
        version: 1,
        status: "in_review",
        auditId: audit.id,
        demoArtifactDir: siteDir,
        content: { schemaVersion: 1, revision: "site-rebuild", failure: null, proposalText: { summary: "既存" } },
      })
      .returning();
    // 生成パイプラインの版（site-rebuild でない）は対象外
    const [generated] = await db
      .insert(proposalVersions)
      .values({ proposalId: proposal!.id, version: 2, status: "in_review", content: { revision: "initial" } })
      .returning();

    const first = await recheckInReviewProposalVersions({ db, clock }, repo);
    expect(first.checked).toEqual([{ proposalVersionId: old!.id, status: "passed" }]);
    expect(first.skipped).toEqual([{ proposalVersionId: generated!.id, reason: "not_site_rebuild" }]);
    const [row] = await db.select().from(proposalVersions).where(eq(proposalVersions.id, old!.id));
    expect(row!.status).toBe("in_review");
    const content = row!.content as { aiCheck: ProposalAiCheck; proposalText: unknown; failure: unknown };
    expect(content.aiCheck.status).toBe("passed");
    expect(content.proposalText).toEqual({ summary: "既存" });
    expect(content.failure).toBeNull();
    expect(
      await db.select().from(auditEvents).where(eq(auditEvents.action, "proposal_version.ai_precheck_rechecked")),
    ).toHaveLength(1);

    // aiCheck がある版は既定では検査しない。all では検査し直す（不合格でも状態は in_review のまま）
    expect((await recheckInReviewProposalVersions({ db, clock }, repo)).checked).toEqual([]);
    await appendFile(path.join(siteDir, "index.html"), '<a href="nowhere.html">x</a>');
    const forced = await recheckInReviewProposalVersions({ db, clock }, { ...repo, all: true });
    expect(forced.checked).toEqual([{ proposalVersionId: old!.id, status: "failed" }]);
    const [after] = await db.select().from(proposalVersions).where(eq(proposalVersions.id, old!.id));
    expect(after!.status).toBe("in_review");
    expect((after!.content as { aiCheck: ProposalAiCheck }).aiCheck.status).toBe("failed");

    // 承認済みの版には書かない
    await db.update(proposalVersions).set({ status: "approved" }).where(eq(proposalVersions.id, old!.id));
    expect((await recheckInReviewProposalVersions({ db, clock }, { ...repo, all: true })).checked).toEqual([]);
  });
});
