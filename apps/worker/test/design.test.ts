import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  attachDesignImage,
  attachImageAssetFile,
  createDesign,
  DEFAULT_DESIGN_BRIEF,
  loadCompanyProfile,
  proposalRevisionFingerprint,
  requestDesignBuild,
  retryDesignBuild,
  reviewDesign,
  saveCompanyProfile,
} from "@siteoffer/core";
import {
  auditEvents,
  companies,
  designVersions,
  generationJobs,
  imageAssets,
  proposalVersions,
  siteAudits,
  users,
  websites,
} from "@siteoffer/db";
import { createOpenAIImageGenerator, normalizeDesignImage } from "@siteoffer/generation/images";
import { EMPTY_COMPANY_PROFILE } from "@siteoffer/schemas";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { intakeDesignBuilds, processDesignJobs } from "../src/design.ts";
import { executeStep } from "../src/execute.ts";
import { defaultGenerationInputBuilder } from "../src/input.ts";
import { ensureProposalVersion, proposalStep } from "../src/pipeline/proposal.ts";
import { withProposalRevision } from "../src/proposal-revision.ts";
import { stepKeys } from "../src/queues.ts";
import { deferred, setupEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
afterEach(async () => {
  await env?.cleanup();
  env = undefined!;
});
async function seed() {
  env = await setupEnv();
  const [user] = await env.db
    .insert(users)
    .values({
      email: "design-operator@example.test",
      displayName: "確認担当",
      passwordHash: "fixture-not-a-login",
      role: "ops",
    })
    .returning();
  const [company] = await env.db.insert(companies).values({ name: "デザイン検証株式会社" }).returning();
  const [website] = await env.db
    .insert(websites)
    .values({
      companyId: company!.id,
      url: "https://design.example.test",
      normalizedUrl: "https://design.example.test",
      domain: "design.example.test",
      kind: "current",
    })
    .returning();
  const [audit] = await env.db
    .insert(siteAudits)
    .values({
      companyId: company!.id,
      websiteId: website!.id,
      targetUrl: "https://design.example.test",
      status: "evaluated",
      decision: "create",
    })
    .returning();
  const actor = { kind: "ops", userId: user!.id } as const;
  const image = await normalizeDesignImage(
    await sharp({ create: { width: 800, height: 600, channels: 3, background: "#f0eee8" } })
      .png()
      .toBuffer(),
  );
  return { company: company!, audit: audit!, actor, image };
}
async function rejectedProposal() {
  const s = await seed();
  const d = await createDesign(env.db, env.clock, s.actor, {
    companyId: s.company.id,
    auditId: s.audit.id,
    requestKey: "revision-source",
    brief: DEFAULT_DESIGN_BRIEF,
    source: "import",
  });
  await attachDesignImage(env.db, env.clock, s.actor, d.id, s.image);
  await reviewDesign(env.db, env.clock, s.actor, {
    id: d.id,
    approve: true,
    note: "画像確認済み",
    factsChecked: true,
    rightsChecked: true,
    layoutChecked: true,
  });
  await requestDesignBuild(env.db, env.clock, s.actor, d.id);
  await intakeDesignBuilds(env.deps);
  expect((await env.queue.drain(env.runtime)).at(-1)?.outcome.status).toBe("succeeded");
  const [source] = await env.db
    .update(proposalVersions)
    .set({
      status: "rejected",
      reviewNote: "見出しを短くし、スマホでは写真を先に。",
      reviewedBy: s.actor.userId,
      reviewedAt: env.clock.now(),
    })
    .returning();
  return { ...s, design: d, source: source! };
}

it("再制作の4用途へ固定した修正メモと元構成を渡し、元の版・画像・事実を変えない", async () => {
  const s = await rejectedProposal();
  const before = proposalRevisionFingerprint(s.source);
  const retry = await retryDesignBuild(env.db, env.clock, s.actor, s.design.id, s.source.id);
  const generation = vi.spyOn(env.deps.generation.generator, "generate");
  const base = await env.deps.buildGenerationInput(env.db, { company: s.company, audit: s.audit });
  await intakeDesignBuilds(env.deps);
  expect((await env.queue.drain(env.runtime)).at(-1)?.outcome.status).toBe("succeeded");
  expect(generation).toHaveBeenCalledTimes(4);
  for (const [request] of generation.mock.calls) {
    expect(request.input.context.proposalRevision).toMatchObject({
      sourceVersionId: s.source.id,
      request: s.source.reviewNote,
      sourceSha256: before,
    });
    expect(request.input.facts).toEqual(base.facts);
    const old = request.input.externalData.find((item) => item.id === "previous-proposal");
    expect(JSON.parse(old!.content)).toHaveProperty("demoSite");
    expect(request.input.attachments.find((a) => a.name === "approved-design.png")?.imagePolicy?.allowedUses).toEqual([
      "analysis_only",
    ]);
  }
  const rows = await env.db.select().from(proposalVersions);
  expect(rows).toHaveLength(2);
  const fresh = rows.find((row) => row.id !== s.source.id)!;
  expect(fresh.content).toMatchObject({ proposalRevision: { sourceVersionId: s.source.id, sourceVersion: 1 } });
  expect(JSON.stringify(fresh.content)).not.toContain(s.source.reviewNote!);
  expect(proposalRevisionFingerprint(rows.find((row) => row.id === s.source.id)!)).toBe(before);
  expect(retry.imageSha256).toBe((s.source.content as { designSha256: string }).designSha256);
  expect((await retryDesignBuild(env.db, env.clock, s.actor, s.design.id, s.source.id)).id).toBe(retry.id);
});
it("元の提案・修正メモや依頼履歴が変更されたら、追加の生成前に止める", async () => {
  const s = await rejectedProposal();
  const retry = await retryDesignBuild(env.db, env.clock, s.actor, s.design.id, s.source.id);
  const base = await env.deps.buildGenerationInput(env.db, { company: s.company, audit: s.audit });
  const [event] = await env.db.select().from(auditEvents).where(eq(auditEvents.targetId, retry.id));
  for (const after of [
    null,
    {},
    { ...(event!.after as object), previousProposalId: s.design.id },
    { ...(event!.after as object), revisionNote: "保存後に差し替えた短い指示" },
    { ...(event!.after as object), revisionNote: "x".repeat(4001) },
  ]) {
    await env.db.update(auditEvents).set({ after }).where(eq(auditEvents.id, event!.id));
    await expect(withProposalRevision(env.db, retry, base)).rejects.toThrow("再制作");
  }
  await env.db.update(auditEvents).set({ after: event!.after }).where(eq(auditEvents.id, event!.id));
  await env.db
    .update(proposalVersions)
    .set({ reviewNote: "後から差し替えた指示" })
    .where(eq(proposalVersions.id, s.source.id));
  await expect(withProposalRevision(env.db, retry, base)).rejects.toThrow("元の提案が変更");
  expect(await env.db.select().from(generationJobs)).toHaveLength(4);
});
it("別の元版・新しい提案がある場合と、無効な運営による再制作を拒否する", async () => {
  const s = await rejectedProposal();
  await expect(retryDesignBuild(env.db, env.clock, s.actor, s.design.id, s.design.id)).rejects.toThrow("制作失敗");
  await env.db.update(users).set({ status: "suspended" }).where(eq(users.id, s.actor.userId));
  await expect(retryDesignBuild(env.db, env.clock, s.actor, s.design.id, s.source.id)).rejects.toThrow("有効な運営");
  await env.db.update(users).set({ status: "active" }).where(eq(users.id, s.actor.userId));
  await env.db
    .insert(proposalVersions)
    .values({ proposalId: s.source.proposalId, auditId: s.audit.id, version: 2, status: "in_review" });
  await expect(retryDesignBuild(env.db, env.clock, s.actor, s.design.id, s.source.id)).rejects.toThrow("新しい提案版");
  expect(await env.db.select().from(designVersions)).toHaveLength(1);
});
it("通常制作・旧形式の再制作は後から修正指示を足さず、jsonbのキー順で元版の署名を変えない", async () => {
  const s = await rejectedProposal();
  const base = await env.deps.buildGenerationInput(env.db, { company: s.company, audit: s.audit });
  expect(await withProposalRevision(env.db, s.design, base)).toBe(base);
  const [approved] = await env.db.select().from(designVersions);
  expect(
    await withProposalRevision(env.db, { ...approved!, requestKey: `retry:${s.design.id}:${s.source.id}` }, base),
  ).toBe(base);
  const content = s.source.content as Record<string, unknown>;
  expect(
    proposalRevisionFingerprint({ ...s.source, content: Object.fromEntries(Object.entries(content).reverse()) }),
  ).toBe(proposalRevisionFingerprint(s.source));
});
describe("画像を先に承認する制作フロー", () => {
  async function withProfile(key: string) {
    const s = await seed();
    const values = { ...EMPTY_COMPANY_PROFILE, email: "contact@fixture-profile.example.test" };
    await saveCompanyProfile(env.db, env.clock, s.actor, {
      companyId: s.company.id,
      expectedRevision: 0,
      values,
      source: "架空の版照合検証",
      confirmed: true,
    });
    const original = env.deps.buildGenerationInput;
    env.deps.buildGenerationInput = async (...args) => {
      const input = await original(...args);
      const profile = await loadCompanyProfile(env.db, s.company.id);
      return { ...input, context: { ...input.context, companyProfileRevision: profile!.revision } };
    };
    const d = await createDesign(env.db, env.clock, s.actor, {
      companyId: s.company.id,
      auditId: s.audit.id,
      requestKey: key,
      brief: DEFAULT_DESIGN_BRIEF,
      source: "import",
    });
    await attachDesignImage(env.db, env.clock, s.actor, d.id, s.image);
    await reviewDesign(env.db, env.clock, s.actor, {
      id: d.id,
      approve: true,
      note: "架空データの版照合",
      factsChecked: true,
      rightsChecked: true,
      layoutChecked: true,
    });
    return {
      ...s,
      values,
      payload: { companyId: s.company.id, auditId: s.audit.id, designVersionId: d.id, revision: key },
    };
  }
  it("制作中に確認情報が変わった版を運営確認へ進めない", async () => {
    const s = await withProfile("profile-mid-build"),
      build = env.deps.siteBuilder.buildDemo;
    env.deps.siteBuilder.buildDemo = async (args) => {
      await saveCompanyProfile(env.db, env.clock, s.actor, {
        companyId: s.company.id,
        expectedRevision: 1,
        values: s.values,
        source: "制作中に更新した架空の根拠",
        confirmed: true,
      });
      return build(args);
    };
    const result = await executeStep(env.deps, proposalStep, s.payload);
    expect(result.status).toBe("failed");
    expect(env.generator.calls).toHaveLength(4);
    const [version] = await env.db.select().from(proposalVersions);
    expect(version!.status).toBe("failed");
    expect((version!.content as { failure: string }).failure).toContain("会社情報が変更");
  });
  it("再試行で旧確認版の成功した文章を新しい情報へ混在させない", async () => {
    const s = await withProfile("profile-retry");
    let builds = 0;
    const build = env.deps.siteBuilder.buildDemo;
    env.deps.siteBuilder.buildDemo = async (args) => {
      if (++builds === 1)
        return { ok: false, reason: "astro-build-failed", message: "架空の一時的な失敗", retryable: true };
      return build(args);
    };
    expect((await executeStep(env.deps, proposalStep, s.payload)).status).toBe("retry");
    await saveCompanyProfile(env.db, env.clock, s.actor, {
      companyId: s.company.id,
      expectedRevision: 1,
      values: s.values,
      source: "次の試行までに更新した架空の根拠",
      confirmed: true,
    });
    expect((await executeStep(env.deps, proposalStep, s.payload)).status).toBe("failed");
    expect(env.generator.calls).toHaveLength(4);
    expect(builds).toBe(1);
  });
  it("連絡先が未確認ならモデルを呼ぶ前に止め、確認画面を案内する", async () => {
    const s = await seed();
    env.deps.buildGenerationInput = defaultGenerationInputBuilder;
    const d = await createDesign(env.db, env.clock, s.actor, {
      companyId: s.company.id,
      auditId: s.audit.id,
      requestKey: "missing-contact",
      brief: DEFAULT_DESIGN_BRIEF,
      source: "import",
    });
    await attachDesignImage(env.db, env.clock, s.actor, d.id, s.image);
    await reviewDesign(env.db, env.clock, s.actor, {
      id: d.id,
      approve: true,
      note: "架空データの検証",
      factsChecked: true,
      rightsChecked: true,
      layoutChecked: true,
    });
    const result = await executeStep(env.deps, proposalStep, {
      companyId: s.company.id,
      auditId: s.audit.id,
      designVersionId: d.id,
      revision: "contact-check",
    });
    expect(result.status).toBe("failed");
    expect(env.generator.calls).toHaveLength(0);
    expect(await env.db.select().from(generationJobs)).toHaveLength(0);
    const [version] = await env.db.select().from(proposalVersions);
    expect((version!.content as { failure: string }).failure).toContain("制作に使う会社情報");
  });
  it("keeps a legacy generating proposal image-free instead of adopting newly registered materials", async () => {
    const s = await seed();
    const d = await createDesign(env.db, env.clock, s.actor, {
      companyId: s.company.id,
      auditId: s.audit.id,
      requestKey: "legacy-material",
      brief: DEFAULT_DESIGN_BRIEF,
      source: "import",
    });
    await attachDesignImage(env.db, env.clock, s.actor, d.id, s.image);
    await reviewDesign(env.db, env.clock, s.actor, {
      id: d.id,
      approve: true,
      note: "内部検証",
      factsChecked: true,
      rightsChecked: true,
      layoutChecked: true,
    });
    const payload = {
      companyId: s.company.id,
      auditId: s.audit.id,
      designVersionId: d.id,
      revision: "legacy-no-materials",
    };
    const version = await ensureProposalVersion(env.db, env.clock, {
      companyId: s.company.id,
      auditId: s.audit.id,
      idempotencyKey: stepKeys.proposal(payload),
      revision: payload.revision,
    });
    const legacy = { ...(version.content as Record<string, unknown>) };
    delete legacy.demoImageAssets;
    await env.db.update(proposalVersions).set({ content: legacy }).where(eq(proposalVersions.id, version.id));
    const [asset] = await env.db
      .insert(imageAssets)
      .values({ companyId: s.company.id, label: "後から登録した写真", sourceType: "generated", placement: "hero" })
      .returning();
    await attachImageAssetFile(env.db, env.clock, s.actor, {
      companyId: s.company.id,
      assetId: asset!.id,
      png: s.image.png,
      width: s.image.width,
      height: s.image.height,
    });
    await env.db
      .update(imageAssets)
      .set({
        rightsStatus: "use_approved",
        allowSalesDemo: true,
        confirmedBy: s.actor.userId,
        confirmedAt: env.clock.now(),
      })
      .where(eq(imageAssets.id, asset!.id));
    let hero: unknown;
    const builder = env.deps.siteBuilder.buildDemo;
    env.deps.siteBuilder.buildDemo = async (args) => {
      hero = args.siteInput.hero.image;
      return builder(args);
    };
    const result = await executeStep(env.deps, proposalStep, payload);
    expect(result.status).toBe("succeeded");
    expect(hero).toBeUndefined();
    const rows = await env.db.select().from(proposalVersions);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.content as { demoImageAssets: unknown }).demoImageAssets).toEqual([]);
  });
  it("does not replace or regenerate a proposal's frozen materials on a build retry after permission changes", async () => {
    const s = await seed();
    env.deps.policies.proposal.maxAttempts = 2;
    const [asset] = await env.db
      .insert(imageAssets)
      .values({ companyId: s.company.id, label: "変更前の概念写真", sourceType: "generated", placement: "hero" })
      .returning();
    await attachImageAssetFile(env.db, env.clock, s.actor, {
      companyId: s.company.id,
      assetId: asset!.id,
      png: s.image.png,
      width: s.image.width,
      height: s.image.height,
    });
    await env.db
      .update(imageAssets)
      .set({
        rightsStatus: "use_approved",
        allowSalesDemo: true,
        confirmedBy: s.actor.userId,
        confirmedAt: env.clock.now(),
      })
      .where(eq(imageAssets.id, asset!.id));
    const d = await createDesign(env.db, env.clock, s.actor, {
      companyId: s.company.id,
      auditId: s.audit.id,
      requestKey: "retry-material",
      brief: DEFAULT_DESIGN_BRIEF,
      source: "import",
    });
    await attachDesignImage(env.db, env.clock, s.actor, d.id, s.image);
    await reviewDesign(env.db, env.clock, s.actor, {
      id: d.id,
      approve: true,
      note: "内部検証",
      factsChecked: true,
      rightsChecked: true,
      layoutChecked: true,
    });
    env.deps.siteBuilder.buildDemo = async () => ({
      ok: false,
      reason: "astro-build-failed",
      message: "transient fixture failure",
      retryable: true,
    });
    const payload = { companyId: s.company.id, auditId: s.audit.id, designVersionId: d.id, revision: "frozen-retry" };
    expect((await executeStep(env.deps, proposalStep, payload)).status).toBe("retry");
    expect(env.generator.calls).toHaveLength(4);
    const [before] = await env.db.select().from(proposalVersions);
    await env.db
      .update(imageAssets)
      .set({ allowSalesDemo: false, policyRevision: 2 })
      .where(eq(imageAssets.id, asset!.id));
    const retry = await executeStep(env.deps, proposalStep, payload);
    expect(retry).toMatchObject({ status: "failed", reason: expect.stringContaining("許諾") });
    expect(env.generator.calls).toHaveLength(4);
    const [after] = await env.db.select().from(proposalVersions);
    expect(after!.status).toBe("failed");
    expect((after!.content as { demoImageAssets: unknown }).demoImageAssets).toEqual(
      (before!.content as { demoImageAssets: unknown }).demoImageAssets,
    );
  });
  it("separates the design reference from a permitted hero image and records immutable demo materials", async () => {
    const s = await seed();
    const [asset] = await env.db
      .insert(imageAssets)
      .values({ companyId: s.company.id, label: "デモ専用の概念写真", sourceType: "generated", placement: "hero" })
      .returning();
    await attachImageAssetFile(env.db, env.clock, s.actor, {
      companyId: s.company.id,
      assetId: asset!.id,
      png: s.image.png,
      width: s.image.width,
      height: s.image.height,
    });
    await env.db
      .update(imageAssets)
      .set({
        rightsStatus: "use_approved",
        allowSalesDemo: true,
        confirmedBy: s.actor.userId,
        confirmedAt: env.clock.now(),
      })
      .where(eq(imageAssets.id, asset!.id));
    const d = await createDesign(env.db, env.clock, s.actor, {
      companyId: s.company.id,
      auditId: s.audit.id,
      requestKey: "with-material",
      brief: DEFAULT_DESIGN_BRIEF,
      source: "import",
    });
    await attachDesignImage(env.db, env.clock, s.actor, d.id, s.image);
    await reviewDesign(env.db, env.clock, s.actor, {
      id: d.id,
      approve: true,
      note: "架空の内部検証",
      factsChecked: true,
      rightsChecked: true,
      layoutChecked: true,
    });
    let hero: { src: string; alt: string } | undefined;
    const builder = env.deps.siteBuilder.buildDemo;
    env.deps.siteBuilder.buildDemo = async (args) => {
      hero = args.siteInput.hero.image;
      return builder(args);
    };
    await requestDesignBuild(env.db, env.clock, s.actor, d.id);
    await intakeDesignBuilds(env.deps);
    expect((await env.queue.drain(env.runtime)).at(-1)?.outcome.status).toBe("succeeded");
    const [version] = await env.db.select().from(proposalVersions);
    expect(hero).toEqual({ src: `materials/material-${asset!.id}.png`, alt: "デモ専用の概念写真" });
    expect((version!.content as { demoImageAssets: unknown }).demoImageAssets).toMatchObject([
      { assetId: asset!.id, policyRevision: 1, policy: { allowedUses: ["sales_demo"] } },
    ]);
    expect(await readFile(path.join(path.dirname(version!.demoArtifactDir!), hero!.src))).toEqual(s.image.png);
    expect(env.generator.calls).toHaveLength(4);
    for (const call of env.generator.calls) {
      expect(call.input.attachments).toMatchObject([
        { name: `material-${asset!.id}.png`, imagePolicy: { allowedUses: ["sales_demo"] } },
        { name: "approved-design.png", imagePolicy: { allowedUses: ["analysis_only"] } },
      ]);
    }
  });
  it("画像未承認ではHTMLを生成せず、承認・二重依頼後に同じ画像を1回だけ制作に渡す", async () => {
    const s = await seed();
    const first = await executeStep(env.deps, proposalStep, {
      companyId: s.company.id,
      auditId: s.audit.id,
      revision: "initial",
    });
    expect(first).toMatchObject({ status: "succeeded", result: { status: "awaiting_design" } });
    expect(await env.db.select().from(generationJobs)).toHaveLength(0);
    expect(await env.db.select().from(proposalVersions)).toHaveLength(0);
    const [d] = await env.db.select().from(designVersions);
    await expect(requestDesignBuild(env.db, env.clock, s.actor, d!.id)).rejects.toThrow("承認済み");
    await attachDesignImage(env.db, env.clock, s.actor, d!.id, s.image);
    await expect(
      reviewDesign(env.db, env.clock, s.actor, {
        id: d!.id,
        approve: true,
        note: "",
        factsChecked: true,
        rightsChecked: false,
        layoutChecked: true,
      }),
    ).rejects.toThrow("3項目");
    await reviewDesign(env.db, env.clock, s.actor, {
      id: d!.id,
      approve: true,
      note: "fixture",
      factsChecked: true,
      rightsChecked: true,
      layoutChecked: true,
    });
    await expect(attachDesignImage(env.db, env.clock, s.actor, d!.id, s.image)).rejects.toThrow("状態が変わりました");
    await requestDesignBuild(env.db, env.clock, s.actor, d!.id);
    await requestDesignBuild(env.db, env.clock, s.actor, d!.id);
    await intakeDesignBuilds(env.deps);
    await intakeDesignBuilds(env.deps);
    expect(env.queue.size).toBe(1);
    const result = await env.queue.drain(env.runtime);
    expect(result.at(-1)?.outcome.status).toBe("succeeded");
    const [v] = await env.db.select().from(proposalVersions);
    expect(v).toMatchObject({
      status: "in_review",
      content: { designVersionId: d!.id, designSha256: expect.any(String) },
    });
    expect(await readFile(path.join(path.dirname(v!.demoArtifactDir!), "reference", `design-${d!.id}.png`))).toEqual(
      s.image.png,
    );
    await intakeDesignBuilds(env.deps);
    expect(env.queue.size).toBe(0);
    await expect(retryDesignBuild(env.db, env.clock, s.actor, d!.id)).rejects.toThrow("制作失敗");
    await env.db.update(proposalVersions).set({ status: "failed" }).where(eq(proposalVersions.id, v!.id));
    const retry = await retryDesignBuild(env.db, env.clock, s.actor, d!.id);
    expect(retry.imageSha256).toBe(v!.content && (v!.content as { designSha256: string }).designSha256);
    expect(retry.status).toBe("approved");
    expect((await retryDesignBuild(env.db, env.clock, s.actor, d!.id)).id).toBe(retry.id);
    await intakeDesignBuilds(env.deps);
    expect(env.queue.size).toBe(1);
    expect((await env.queue.drain(env.runtime)).at(-1)?.outcome.status).toBe("succeeded");
    expect(await env.db.select().from(proposalVersions)).toHaveLength(2);
  });
  it("営業権限・別企業のデザイン・未承認の直指定を拒否する", async () => {
    const s = await seed();
    const input = {
      companyId: s.company.id,
      auditId: s.audit.id,
      requestKey: "access",
      brief: DEFAULT_DESIGN_BRIEF,
      source: "import" as const,
    };
    await expect(createDesign(env.db, env.clock, { kind: "sales", userId: s.actor.userId }, input)).rejects.toThrow(
      "運営権限",
    );
    const d = await createDesign(env.db, env.clock, s.actor, input);
    const r = await executeStep(env.deps, proposalStep, {
      companyId: s.company.id,
      auditId: s.audit.id,
      revision: "bypass",
      designVersionId: d.id,
    });
    expect(r.status).toBe("failed");
    expect(await env.db.select().from(generationJobs)).toHaveLength(0);
    await expect(
      reviewDesign(env.db, env.clock, s.actor, {
        id: d.id,
        approve: false,
        note: "",
        factsChecked: false,
        rightsChecked: false,
        layoutChecked: false,
      }),
    ).rejects.toThrow("修正内容");
  });
  it("API処理を永続化して重複実行を防ぎ、失敗と中断を可視化する", async () => {
    const s = await seed();
    const d = await createDesign(env.db, env.clock, s.actor, {
      companyId: s.company.id,
      auditId: s.audit.id,
      requestKey: "api",
      brief: DEFAULT_DESIGN_BRIEF,
      source: "openai",
      model: "configured-image-model",
    });
    const generate = vi.fn(async () => ({ bytes: s.image.png, requestId: "request-fixture", usage: { images: 1 } }));
    await processDesignJobs(env.deps, { generate });
    await processDesignJobs(env.deps, { generate });
    expect(generate).toHaveBeenCalledTimes(1);
    const [stored] = await env.db.select().from(designVersions).where(eq(designVersions.id, d.id));
    expect(stored).toMatchObject({
      status: "in_review",
      requestId: "request-fixture",
      imageSha256: expect.any(String),
    });
    const failed = await createDesign(env.db, env.clock, s.actor, {
      companyId: s.company.id,
      auditId: s.audit.id,
      requestKey: "failure",
      brief: DEFAULT_DESIGN_BRIEF,
      source: "openai",
      model: "configured-image-model",
    });
    await processDesignJobs(env.deps, {
      generate: async () => {
        throw new Error("sensitive-provider-body");
      },
    });
    const [error] = await env.db.select().from(designVersions).where(eq(designVersions.id, failed.id));
    expect(error?.status).toBe("failed");
    expect(error?.error).not.toContain("sensitive");
  });
});
it("画像APIのリクエスト・失敗・不正ファイルを検証する", async () => {
  const transport = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({ data: [{ b64_json: Buffer.from("fixture").toString("base64") }], usage: { total_tokens: 1 } }),
        { headers: { "x-request-id": "fixture-id" } },
      ),
  );
  const provider = createOpenAIImageGenerator("fixture", transport as typeof fetch);
  const r = await provider.generate("design", "configured-model");
  expect(r.requestId).toBe("fixture-id");
  expect(JSON.parse(transport.mock.calls[0]![1]!.body as string)).toMatchObject({
    model: "configured-model",
    n: 1,
    output_format: "png",
  });
  const failed = createOpenAIImageGenerator("fixture", async () => new Response("private error", { status: 429 }));
  await expect(failed.generate("design", "model")).rejects.toThrow("HTTP 429");
  await expect(normalizeDesignImage(Buffer.from("<svg>unsafe</svg>"))).rejects.toThrow();
});

it("an image worker without credentials leaves queued work for a configured worker", async () => {
  const { company, audit, actor } = await seed();
  const d = await createDesign(env.db, env.clock, actor, {
    companyId: company.id,
    auditId: audit.id,
    brief: DEFAULT_DESIGN_BRIEF,
    requestKey: "missing-image-key",
    source: "openai",
    model: "test-model",
  });
  vi.stubEnv("OPENAI_API_KEY", "");
  try {
    await processDesignJobs(env.deps);
    expect((await env.db.select().from(designVersions).where(eq(designVersions.id, d.id)))[0]?.status).toBe("queued");
  } finally {
    vi.unstubAllEnvs();
  }
});

it("画像の設定がなくても中断を確定し、待機中と新しい実行を残して履歴を一度だけ記録する", async () => {
  const s = await seed();
  const stale = await createDesign(env.db, env.clock, s.actor, {
    companyId: s.company.id,
    auditId: s.audit.id,
    requestKey: "interrupted-image",
    brief: DEFAULT_DESIGN_BRIEF,
    source: "openai",
    model: "configured-image-model",
  });
  await env.db
    .update(designVersions)
    .set({
      status: "generating",
      startedAt: new Date(env.clock.now().getTime() - 11 * 60_000),
    })
    .where(eq(designVersions.id, stale.id));
  const [queued, recent] = await env.db
    .insert(designVersions)
    .values([
      { ...stale, id: undefined, version: 2, requestKey: "still-queued" },
      {
        ...stale,
        id: undefined,
        version: 3,
        requestKey: "still-running",
        status: "generating" as const,
        startedAt: env.clock.now(),
      },
    ])
    .returning();
  vi.stubEnv("OPENAI_API_KEY", "");
  try {
    await processDesignJobs(env.deps);
    await processDesignJobs(env.deps);
    const rows = await env.db.select().from(designVersions);
    expect(rows.find((r) => r.id === stale.id)).toMatchObject({
      status: "failed",
      finishedAt: env.clock.now(),
      error: expect.stringContaining("API側"),
    });
    expect(rows.find((r) => r.id === queued!.id)?.status).toBe("queued");
    expect(rows.find((r) => r.id === recent!.id)?.status).toBe("generating");
    const events = await env.db.select().from(auditEvents).where(eq(auditEvents.action, "design.failed"));
    expect(events).toMatchObject([{ targetId: stale.id }]);
    expect(events).toHaveLength(1);
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each(["success", "failure"])("中断確定後に届いた%sは、状態を戻さず失敗履歴も重ねない", async (outcome) => {
  const s = await seed();
  const d = await createDesign(env.db, env.clock, s.actor, {
    companyId: s.company.id,
    auditId: s.audit.id,
    requestKey: "late-image-result",
    brief: DEFAULT_DESIGN_BRIEF,
    source: "openai",
    model: "configured-image-model",
  });
  const started = deferred();
  const result = deferred<{ bytes: Buffer; requestId: string; usage: unknown }>();
  const work = processDesignJobs(env.deps, {
    generate: async () => {
      started.resolve();
      return result.promise;
    },
  });
  await started.promise;
  try {
    env.clock.advance(11 * 60_000);
    vi.stubEnv("OPENAI_API_KEY", "");
    await processDesignJobs(env.deps);
  } finally {
    if (outcome === "success") result.resolve({ bytes: s.image.png, requestId: "late-request-fixture", usage: {} });
    else result.reject(new Error("private-late-provider-error"));
    await work;
    vi.unstubAllEnvs();
  }
  const [stored] = await env.db.select().from(designVersions).where(eq(designVersions.id, d.id));
  expect(stored).toMatchObject({ status: "failed", imageBase64: null, requestId: null });
  expect(await env.db.select().from(auditEvents).where(eq(auditEvents.action, "design.failed"))).toHaveLength(1);
});
