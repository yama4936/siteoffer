import path from "node:path";
import { err, ok } from "@siteoffer/core";
import { siteAudits } from "@siteoffer/db";
import type { GenerationDeps } from "@siteoffer/generation";
import { runGenerationJob } from "@siteoffer/generation";
import type { Attachment, GenerationInput } from "@siteoffer/schemas";
import { eq } from "drizzle-orm";
import type { EvaluationGenerator, EvaluationGeneratorInput } from "./generator.ts";

/**
 * T5の生成ジョブ（runGenerationJob・用途 evaluation）を、診断の採点口 EvaluationGenerator に適合させる。
 *
 * - 1回の採点につき生成ジョブを1件作る。冪等キーは診断IDから作るので、同じ診断の採点が二重に実行されない
 *   （再診断は新しい診断ID＝新しいジョブ）。
 * - collect.py の観測は外部データの区画（指示として扱わせない）、スクリーンショットと評価指標・出力形式は
 *   添付（生成の作業ディレクトリの input/files/）として渡す。プロンプトは T5 の evaluation 用プロンプトを使い、
 *   診断側の buildEvaluationPrompt（input.prompt）は使わない。
 * - 出力は T5 の evaluationSchema と事実検査を通ったもの。model は実行記録の応答モデル（取れなければ null）。
 *   要求モデルは「使われたモデル」の確認にならないので使わない。
 */
export function createGenerationEvaluationGenerator(deps: GenerationDeps): EvaluationGenerator {
  return {
    async generate(input) {
      const [audit] = await deps.db
        .select({ companyId: siteAudits.companyId })
        .from(siteAudits)
        .where(eq(siteAudits.id, input.auditId));
      const r = await runGenerationJob(deps, {
        idempotencyKey: evaluationIdempotencyKey(input.auditId),
        companyId: audit?.companyId ?? null,
        purpose: "evaluation",
        input: toGenerationInput(input),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!r.ok) return err("generation_failed", r.message ?? r.error);
      const { job, output } = r.value;
      if (output === null) {
        return err("generation_failed", `生成ジョブ ${job.id} は ${job.status}（既存のジョブで出力がない）`);
      }
      return ok({ evaluation: output, model: job.responseModel ?? null, generationJobId: job.id });
    },
  };
}

export function evaluationIdempotencyKey(auditId: string): string {
  return `site_audit:${auditId}:evaluation`;
}

/** 添付のファイル名（作業ディレクトリ内の名前。英数字・._- のみ） */
function safeName(p: string): string {
  const base = path.basename(p).replace(/[^A-Za-z0-9_.-]/g, "_");
  return base.replace(/^\.+/, "_") || "file";
}

/** 診断の採点入力 → 生成ジョブの入力 */
export function toGenerationInput(input: EvaluationGeneratorInput): GenerationInput {
  const attachments: Attachment[] = [
    { name: "rubric.md", path: input.rubricPath, kind: "text", imagePolicy: null },
    { name: "output-format.md", path: input.outputFormatPath, kind: "text", imagePolicy: null },
  ];
  const used = new Set(attachments.map((a) => a.name));
  for (const [i, p] of input.screenshotPaths.entries()) {
    let name = safeName(p);
    if (used.has(name)) name = `screenshot-${i + 1}-${name}`;
    used.add(name);
    attachments.push({
      name,
      path: p,
      kind: "image",
      imagePolicy: {
        sourceType: "original_site",
        sourceUrl: input.targetUrl,
        rightsStatus: "unknown",
        allowedUses: ["analysis_only"],
        confirmedBy: null,
        confirmedAt: null,
        note: "サイト評価の画面証拠。営業デモ・納品サイトの素材には使わない",
      },
    });
  }
  const collectedAt = input.collected.collected_at;
  return {
    facts: [],
    externalData: [
      {
        id: "collected",
        sourceUrl: input.targetUrl,
        fetchedAt: typeof collectedAt === "string" ? collectedAt : null,
        content: JSON.stringify(input.collected, null, 2),
      },
    ],
    attachments,
    context: {
      task: "site_evaluation",
      auditId: input.auditId,
      targetUrl: input.targetUrl,
      screenshots: attachments.filter((a) => a.kind === "image").map((a) => a.name),
    },
  };
}
