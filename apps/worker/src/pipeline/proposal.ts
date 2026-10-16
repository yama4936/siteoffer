import { createHash } from "node:crypto";
import path from "node:path";
import { siteGenerationToSiteInput } from "@siteoffer/astro-site";
import { type Clock, createDesign, DEFAULT_DESIGN_BRIEF, recordEvent } from "@siteoffer/core";
import { companies, type Db, designVersions, proposals, proposalVersions, siteAudits } from "@siteoffer/db";
import { findGenerationJob, type GenerationDeps, runGenerationJob } from "@siteoffer/generation";
import type { CallScript, Faq, GenerationInput, ProposalText, SiteGenerationOutput } from "@siteoffer/schemas";
import { and, eq, max, sql } from "drizzle-orm";
import { emptyProposalContent, type ProposalContent } from "../content.ts";
import type { JobQueue } from "../deps.ts";
import { contentSiteUrl, withDesignReference } from "../design.ts";
import { PermanentError, PreconditionError, type StepDefinition } from "../execute.ts";
import { type ProposalPayload, type ProposalPayloadInput, proposalPayloadSchema, QUEUES, stepKeys } from "../queues.ts";
import { moveCompanyStatus, PIPELINE_ACTOR, PRE_REVIEW_STATUSES, PROTECTED } from "./status.ts";

export type ProposalVersionRow = typeof proposalVersions.$inferSelect;

/** 提案で生成する用途（この順に実行する） */
export const PROPOSAL_PURPOSES = ["proposal_text", "call_script", "faq", "demo_site"] as const;
type ProposalPurpose = (typeof PROPOSAL_PURPOSES)[number];

interface Outputs {
  proposal_text: ProposalText;
  call_script: CallScript;
  faq: Faq;
  demo_site: SiteGenerationOutput;
}

export interface ProposalStepResult {
  companyId: string;
  proposalVersionId: string;
  version: number;
  status: "in_review";
  demoArtifactDir: string;
  generationJobIds: ProposalContent["generationJobIds"];
}

/**
 * 診断の判定が create の企業について、改善提案文・電話台本・想定問答・デモサイト構成を生成し、
 * デモをAstroでビルド・検査して、提案版を in_review（運営確認待ち）で保存する。
 * - 版はステップの冪等キーごとに1つ。再試行は同じ版を使い、成功済みの生成は再実行しない。
 * - 再生成（revision が新しい値）は新しい版になり、既存の版（契約で選ばれた版を含む）は変えない。
 */
export const proposalStep: StepDefinition<
  ProposalPayload,
  ProposalStepResult | { status: "awaiting_design"; designVersionId: string }
> = {
  queue: QUEUES.proposal,
  kind: "proposal",
  key: stepKeys.proposal,
  async run(deps, payload, ctx) {
    const { db, clock } = deps;
    const key = stepKeys.proposal(payload);
    const [company] = await db.select().from(companies).where(eq(companies.id, payload.companyId));
    if (!company) throw new PreconditionError(`企業がない：${payload.companyId}`);
    if (PROTECTED.includes(company.suppression)) throw new PreconditionError(`営業抑止（${company.suppression}）`);
    const [audit] = await db.select().from(siteAudits).where(eq(siteAudits.id, payload.auditId));
    if (!audit || audit.companyId !== company.id) throw new PreconditionError("この企業の診断がない");
    if (audit.status !== "evaluated" || audit.decision !== "create") {
      throw new PreconditionError(`診断の判定が create ではない（${audit.status} / ${audit.decision ?? "なし"}）`);
    }

    if (!payload.designVersionId) {
      const model = process.env.SITEOFFER_IMAGE_MODEL?.trim();
      const design = await createDesign(db, clock, PIPELINE_ACTOR, {
        companyId: company.id,
        auditId: audit.id,
        requestKey: `initial:${createHash("sha256").update(key).digest("hex")}`,
        brief: DEFAULT_DESIGN_BRIEF,
        source: model && process.env.OPENAI_API_KEY ? "openai" : "import",
        ...(model ? { model } : {}),
      });
      return { status: "awaiting_design", designVersionId: design.id };
    }
    const [design] = await db.select().from(designVersions).where(eq(designVersions.id, payload.designVersionId));
    if (!design || design.companyId !== company.id || design.auditId !== audit.id || design.status !== "approved") {
      throw new PreconditionError("同じ企業・診断の承認済みデザインが必要です");
    }

    const version = await ensureProposalVersion(db, clock, {
      companyId: company.id,
      auditId: audit.id,
      idempotencyKey: key,
      revision: payload.revision,
    });
    if (version.status !== "generating") {
      throw new PreconditionError(`提案版 ${version.id} はすでに ${version.status}`);
    }

    await db
      .update(proposalVersions)
      .set({
        content: { ...(version.content as object), designVersionId: design.id, designSha256: design.imageSha256 },
      })
      .where(eq(proposalVersions.id, version.id));
    const input = await withDesignReference(
      await deps.buildGenerationInput(db, { company, audit }),
      design,
      path.join(deps.demoArtifactRoot, company.id, version.id, "reference"),
    );
    const genDeps: GenerationDeps = {
      db,
      clock,
      generator: deps.generation.generator,
      actor: PIPELINE_ACTOR,
      ...(deps.generation.limits ? { limits: deps.generation.limits } : {}),
      ...(deps.generation.limiter ? { limiter: deps.generation.limiter } : {}),
    };
    const outputs: Partial<Outputs> = {};
    const jobIds: ProposalContent["generationJobIds"] = {};
    for (const purpose of PROPOSAL_PURPOSES) {
      if (ctx.signal.aborted) throw new Error("制限時間を過ぎたため中断した");
      const r = await generateOnce(genDeps, {
        key,
        purpose,
        companyId: company.id,
        input,
        attempt: ctx.attempt,
        signal: ctx.signal,
      });
      (outputs as Record<string, unknown>)[purpose] = r.output;
      jobIds[purpose] = r.jobId;
    }
    const out = outputs as Outputs;
    await moveCompanyStatus(db, clock, {
      companyId: company.id,
      from: [...PRE_REVIEW_STATUSES],
      to: "generated",
      reason: "提案の生成が完了（デモのビルド・検査前）",
      meta: { proposalVersionId: version.id },
    });

    const content: ProposalContent = {
      ...emptyProposalContent({ idempotencyKey: key, auditId: audit.id, revision: payload.revision }),
      designVersionId: design.id,
      designSha256: design.imageSha256,
      proposalText: out.proposal_text,
      callScript: out.call_script,
      faq: out.faq,
      demoSite: out.demo_site,
      generationJobIds: jobIds,
      generator: deps.generation.generator.kind,
    };

    if (ctx.signal.aborted) throw new Error("制限時間を過ぎたため中断した");
    const workDir = path.join(deps.demoArtifactRoot, company.id, version.id);
    const built = await deps.siteBuilder.buildDemo({
      siteInput: {
        ...siteGenerationToSiteInput(out.demo_site, { mode: "demo" }),
        updatesUrl: contentSiteUrl(company.id, "demo"),
      },
      workDir,
    });
    if (ctx.signal.aborted) throw new Error("制限時間を過ぎたため中断した");
    if (!built.ok) {
      const reason = `デモのビルド・検査に失敗した（${built.reason}）：${built.message}`;
      if (built.retryable) throw new Error(reason);
      await saveVersion(db, clock, version.id, {
        status: "failed",
        content: { ...content, demoCheck: built.check ?? null, failure: reason },
      });
      throw new PermanentError(reason);
    }

    await saveVersion(db, clock, version.id, {
      status: "in_review",
      content: { ...content, demoCheck: built.check },
      demoArtifactDir: built.distDir,
      generationJobId: jobIds.demo_site ?? null,
    });
    await moveCompanyStatus(db, clock, {
      companyId: company.id,
      from: [...PRE_REVIEW_STATUSES],
      to: "in_review",
      reason: "提案版を運営確認待ちで保存",
      meta: { proposalVersionId: version.id, version: version.version },
    });
    return {
      companyId: company.id,
      proposalVersionId: version.id,
      version: version.version,
      status: "in_review",
      demoArtifactDir: built.distDir,
      generationJobIds: jobIds,
    };
  },
  async onGiveUp(deps, payload, reason) {
    const v = await findVersionByKey(deps.db, payload.companyId, stepKeys.proposal(payload));
    if (v && v.status === "generating") {
      const content = (v.content ?? {}) as ProposalContent;
      await saveVersion(deps.db, deps.clock, v.id, { status: "failed", content: { ...content, failure: reason } });
    }
    // 運営確認待ち・営業可能の企業（再生成の失敗）は状態を変えない
    await moveCompanyStatus(deps.db, deps.clock, {
      companyId: payload.companyId,
      from: ["collected", "site_confirmed", "audited", "generated", "on_hold"],
      to: "failed",
      reason: `提案の生成が止まった：${reason}`.slice(0, 500),
    });
  },
  summarize: (r) =>
    r.status === "awaiting_design"
      ? r
      : { proposalVersionId: r.proposalVersionId, version: r.version, status: r.status },
};

/** 生成を1件実行する。前の試行で成功した同じ用途の生成があれば、それを使う（再実行しない） */
async function generateOnce(
  genDeps: GenerationDeps,
  req: {
    key: string;
    purpose: ProposalPurpose;
    companyId: string;
    input: GenerationInput;
    attempt: number;
    signal: AbortSignal;
  },
): Promise<{ jobId: string; output: unknown }> {
  for (let a = 1; a < req.attempt; a++) {
    const prev = await findGenerationJob(genDeps.db, `${req.key}:${req.purpose}:a${a}`);
    if (prev?.status === "succeeded" && prev.output) return { jobId: prev.id, output: prev.output };
  }
  const r = await runGenerationJob(genDeps, {
    idempotencyKey: `${req.key}:${req.purpose}:a${req.attempt}`,
    companyId: req.companyId,
    purpose: req.purpose,
    input: req.input,
    signal: req.signal,
  });
  if (!r.ok) {
    const msg = `生成（${req.purpose}）に失敗した：${r.message ?? r.error}`;
    if (r.error === "invalid_input") throw new PermanentError(msg);
    throw new Error(msg);
  }
  if (r.value.output === null) throw new Error(`生成（${req.purpose}）のジョブが ${r.value.job.status}（出力なし）`);
  return { jobId: r.value.job.id, output: r.value.output };
}

async function findVersionByKey(db: Db, companyId: string, key: string): Promise<ProposalVersionRow | null> {
  const [row] = await db
    .select({ v: proposalVersions })
    .from(proposalVersions)
    .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
    .where(and(eq(proposals.companyId, companyId), sql`${proposalVersions.content}->>'idempotencyKey' = ${key}`));
  return row?.v ?? null;
}

/**
 * ステップの冪等キーに対応する提案版を返す。なければ新しい版（最大の版番号＋1、generating）を作る。
 * 版番号の採番は提案ごとのアドバイザリロックで直列化する（一意制約 proposal_id + version でも守られる）。
 */
export async function ensureProposalVersion(
  db: Db,
  clock: Clock,
  input: { companyId: string; auditId: string; idempotencyKey: string; revision: string },
): Promise<ProposalVersionRow> {
  return db.transaction(async (tx) => {
    await tx
      .insert(proposals)
      .values({ companyId: input.companyId })
      .onConflictDoNothing({ target: proposals.companyId });
    const [proposal] = await tx.select().from(proposals).where(eq(proposals.companyId, input.companyId));
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`siteoffer:proposal:${proposal!.id}`}))`);
    const [existing] = await tx
      .select()
      .from(proposalVersions)
      .where(
        and(
          eq(proposalVersions.proposalId, proposal!.id),
          sql`${proposalVersions.content}->>'idempotencyKey' = ${input.idempotencyKey}`,
        ),
      );
    if (existing) return existing;
    const [m] = await tx
      .select({ max: max(proposalVersions.version) })
      .from(proposalVersions)
      .where(eq(proposalVersions.proposalId, proposal!.id));
    const [row] = await tx
      .insert(proposalVersions)
      .values({
        proposalId: proposal!.id,
        version: (m?.max ?? 0) + 1,
        status: "generating",
        auditId: input.auditId,
        content: emptyProposalContent(input),
        createdAt: clock.now(),
      })
      .returning();
    await recordEvent(tx, clock, {
      actor: PIPELINE_ACTOR,
      action: "proposal_version.created",
      targetType: "proposal_version",
      targetId: row!.id,
      after: { version: row!.version, status: "generating", auditId: input.auditId, revision: input.revision },
    });
    return row!;
  });
}

/** 生成中（generating）の版だけを更新する。運営の確認後の版・契約で選ばれた版は変えない */
async function saveVersion(
  db: Db,
  clock: Clock,
  id: string,
  patch: {
    status: "in_review" | "failed";
    content: ProposalContent;
    demoArtifactDir?: string;
    generationJobId?: string | null;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(proposalVersions)
      .set(patch)
      .where(and(eq(proposalVersions.id, id), eq(proposalVersions.status, "generating")))
      .returning({ id: proposalVersions.id, version: proposalVersions.version });
    if (!updated) throw new PermanentError(`提案版 ${id} は生成中ではないため更新しない`);
    await recordEvent(tx, clock, {
      actor: PIPELINE_ACTOR,
      action: patch.status === "in_review" ? "proposal_version.in_review" : "proposal_version.failed",
      targetType: "proposal_version",
      targetId: id,
      before: { status: "generating" },
      after: {
        status: patch.status,
        version: updated.version,
        demoCheckOk: patch.content.demoCheck?.ok ?? null,
        failure: patch.content.failure,
      },
    });
  });
}

/**
 * 再生成を依頼する（運営の操作から呼ぶ想定）。新しい revision で送るため、新しい版として保存される。
 * 既存の版（契約で選ばれた版を含む）は変更しない。
 */
export async function requestRegeneration(
  queue: JobQueue,
  input: { companyId: string; auditId: string; revision?: string },
): Promise<ProposalPayload> {
  const payload = proposalPayloadSchema.parse({
    companyId: input.companyId,
    auditId: input.auditId,
    revision: input.revision ?? `regen:${crypto.randomUUID()}`,
  } satisfies ProposalPayloadInput);
  await queue.send(QUEUES.proposal, payload, { singletonKey: stepKeys.proposal(payload) });
  return payload;
}
