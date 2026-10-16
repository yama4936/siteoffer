import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { attachDesignImage, type DesignVersion, recordEvent } from "@siteoffer/core";
import { companies, designVersions, proposalVersions } from "@siteoffer/db";
import { createOpenAIImageGenerator, type ImageGenerator, normalizeDesignImage } from "@siteoffer/generation/images";
import type { GenerationInput } from "@siteoffer/schemas";
import { and, asc, eq, isNotNull, lt, sql } from "drizzle-orm";
import type { WorkerDeps } from "./deps.ts";
import { QUEUES, stepKeys } from "./queues.ts";

const actor = { kind: "system", job: "design-worker" } as const;

/** Durable claim before API call. A crash is surfaced, never silently charged again. */
export async function processDesignJobs(deps: WorkerDeps, provider?: ImageGenerator) {
  const { db, clock } = deps;
  // A worker without image credentials must leave queued images for a configured worker.
  if (!provider && !process.env.OPENAI_API_KEY?.trim()) return;
  await db
    .update(designVersions)
    .set({
      status: "failed",
      error: "処理が中断されました。API側の実行状況を確認して新しい版で再実行してください",
      finishedAt: clock.now(),
    })
    .where(
      and(
        eq(designVersions.status, "generating"),
        lt(designVersions.startedAt, new Date(clock.now().getTime() - 10 * 60_000)),
      ),
    );
  const [candidate] = await db
    .select({ id: designVersions.id })
    .from(designVersions)
    .where(eq(designVersions.status, "queued"))
    .orderBy(asc(designVersions.createdAt))
    .limit(1);
  if (!candidate) return;
  const [d] = await db
    .update(designVersions)
    .set({ status: "generating", startedAt: clock.now() })
    .where(and(eq(designVersions.id, candidate.id), eq(designVersions.status, "queued")))
    .returning();
  if (!d) return;
  try {
    const [company] = await db
      .select({ suppression: companies.suppression })
      .from(companies)
      .where(eq(companies.id, d.companyId));
    if (company?.suppression !== "none") throw new Error("企業が営業抑止中のため停止しました");
    const generator = provider ?? createOpenAIImageGenerator(process.env.OPENAI_API_KEY ?? "");
    const result = await generator.generate(d.prompt, d.model!);
    await attachDesignImage(db, clock, actor, d.id, await normalizeDesignImage(result.bytes), "generating", {
      requestId: result.requestId,
      usage: result.usage,
    });
  } catch (error) {
    // Only application-authored messages may be stored. Transport failures can contain credentials/URLs.
    const message =
      error instanceof Error && /^(画像|企業|静止画|640|変換後)/.test(error.message)
        ? error.message
        : "画像生成が完了しませんでした。通信・利用上限を確認し、新しい版で再実行してください";
    await db.transaction(async (tx) => {
      await tx
        .update(designVersions)
        .set({ status: "failed", error: message, finishedAt: clock.now() })
        .where(and(eq(designVersions.id, d.id), eq(designVersions.status, "generating")));
      await recordEvent(tx, clock, {
        actor,
        action: "design.failed",
        targetType: "design",
        targetId: d.id,
        after: { message },
      });
    });
  }
}

/** DB is an outbox. Re-sending after a crash is harmless because step keys are immutable. */
export async function intakeDesignBuilds(deps: WorkerDeps) {
  const rows = await deps.db
    .select({ id: designVersions.id, companyId: designVersions.companyId, auditId: designVersions.auditId })
    .from(designVersions)
    .where(
      and(
        eq(designVersions.status, "approved"),
        isNotNull(designVersions.buildRequestedAt),
        sql`not exists (select 1 from ${proposalVersions} where ${proposalVersions.content}->>'designVersionId' = ${designVersions.id}::text)`,
      ),
    )
    .orderBy(asc(designVersions.buildRequestedAt))
    .limit(20);
  for (const d of rows) {
    const payload = { companyId: d.companyId, auditId: d.auditId, designVersionId: d.id, revision: `design:${d.id}` };
    await deps.queue.send(QUEUES.proposal, payload, { singletonKey: stepKeys.proposal(payload) });
  }
}

export async function withDesignReference(
  input: GenerationInput,
  design: DesignVersion,
  directory: string,
): Promise<GenerationInput> {
  if (design.status !== "approved" || !design.imageBase64 || !design.imageSha256)
    throw new Error("承認済みデザインの画像がありません");
  const bytes = Buffer.from(design.imageBase64, "base64");
  if (createHash("sha256").update(bytes).digest("hex") !== design.imageSha256)
    throw new Error("デザイン画像の整合性エラー");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `design-${design.id}.png`);
  await writeFile(file, bytes);
  return {
    ...input,
    attachments: [
      ...input.attachments,
      {
        name: "approved-design.png",
        path: file,
        kind: "image",
        imagePolicy: {
          sourceType: design.source === "openai" ? "generated" : "operator_upload",
          sourceUrl: null,
          rightsStatus: "use_approved",
          allowedUses: ["analysis_only"],
          confirmedBy: design.reviewedBy,
          confirmedAt: design.reviewedAt?.toISOString() ?? null,
          note: "承認済みのレイアウト参照。画像全体をサイトとして貼り付けない。写実素材の本番転用は別途確認。",
        },
      },
    ],
    context: {
      ...input.context,
      approvedDesign: {
        id: design.id,
        version: design.version,
        sha256: design.imageSha256,
        brief: design.brief,
        instruction:
          "approved-design.pngの配色・余白・書体の方向・情報階層・PC/スマホ配置を再現する。確認済み事実のみをHTMLに使用し、画像内の装飾文字や架空情報を事実として転記しない。画像を全面に敷いた実装は禁止。既存の更新・フォーム機能を欠落させない。",
      },
    },
  };
}

/** The generated static site links to the live CMS; no client script or third-party embed is required. */
export function contentSiteUrl(
  companyId: string,
  mode: "demo" | "delivery",
  origin = process.env.SITEOFFER_CONTENT_ORIGIN,
) {
  if (!origin || mode === "demo") return undefined;
  const base = new URL(origin);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password)
    throw new Error("SITEOFFER_CONTENT_ORIGIN must be an HTTP(S) origin");
  if (base.protocol === "http:" && !["localhost", "127.0.0.1"].includes(base.hostname))
    throw new Error("公開記事の接続先にはHTTPSが必要です");
  return new URL(`/published/${companyId}/news`, base.origin).href;
}
