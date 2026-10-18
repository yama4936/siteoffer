import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withReferencePalette } from "./design-palette.ts";
import { referencePalette, requireReferenceVisualSchema, requiresReferenceVisual } from "./design-reference.ts";
import { toCodexOutputSchema } from "./json-schema.ts";
import { buildPrompt, promptVersion } from "./prompt.ts";
import type { SandboxRequest, SandboxRunner, SandboxRunSpec } from "./sandbox/types.ts";
import type { GenerationInput, GenerationPurpose } from "./schemas.ts";
import type { ExecutionRecord, GenerateRequest, Generator, GeneratorResult } from "./types.ts";
import { validateRawOutput } from "./validate.ts";

export interface CodexGeneratorConfig {
  /** 要求モデル。未指定ならSDK・CLIの既定を使い、記録上の要求モデルはnull */
  model?: string | null;
  modelReasoningEffort?: SandboxRequest["thread"]["modelReasoningEffort"];
  /**
   * コンテナ内でのCodex自身のサンドボックス。隔離の本体はコンテナで、
   * Codexのサンドボックスがコンテナ内で動くかは未確認のため設定で切り替えられるようにする。
   */
  sandboxMode?: SandboxRequest["thread"]["sandboxMode"];
  /** 作業ディレクトリを作る親ディレクトリ。既定はOSの一時ディレクトリ配下 */
  workRoot?: string;
  /** 終了後に作業ディレクトリを残す（調査用）。既定は削除 */
  keepWorkDir?: boolean;
}

/**
 * Codex SDKによる生成。実行は必ず SandboxRunner（本番はジョブごとのDockerコンテナ）を通す。
 * SDKを呼ぶのはコンテナ内のエントリ（sandbox/container-entry.ts）だけで、このクラスはSDKを直接呼ばない。
 * 1ジョブ1スレッド（試行ごとに新しいスレッド）。スレッドIDは実行記録に入る。
 */
export class CodexGenerator implements Generator {
  readonly kind = "codex";
  readonly requestedModel: string | null;
  private readonly runner: SandboxRunner;
  private readonly config: CodexGeneratorConfig;

  constructor(runner: SandboxRunner, config: CodexGeneratorConfig = {}) {
    this.runner = runner;
    this.config = config;
    this.requestedModel = config.model ?? null;
  }

  promptVersion(purpose: GenerationPurpose): string {
    return promptVersion(purpose);
  }

  async generate<T>(req: GenerateRequest<T>): Promise<GeneratorResult<T>> {
    const record: ExecutionRecord = {
      generator: this.kind,
      requestedModel: this.requestedModel,
      responseModel: null,
      sdkVersion: null,
      cliVersion: null,
      promptVersion: this.promptVersion(req.purpose),
      threadId: null,
      requestId: null,
      usage: null,
    };
    if (req.signal?.aborted) return { ok: false, error: "aborted", message: "中断された", record };
    let input: GenerationInput;
    try {
      input = await withReferencePalette(req.purpose, req.input);
    } catch {
      return {
        ok: false,
        error: "schema_violation",
        message: "承認済みのデザイン画像を確認できません。画像の変更・形式・大きさを確認してください。",
        record,
      };
    }
    const prompt = buildPrompt(req.purpose, input);
    record.promptVersion = prompt.version;

    const workDir = await this.createWorkDir(req.jobId, req.attempt);
    try {
      await writeInputFiles(workDir, input);

      const spec: SandboxRunSpec = {
        jobId: req.jobId,
        workDir,
        request: this.buildRequest(prompt.text, { ...req, input }),
        timeoutMs: req.timeoutMs,
      };
      if (req.signal) spec.signal = req.signal;

      const outcome = await this.runner.run(spec);
      if (outcome.result) {
        record.threadId = outcome.result.threadId;
        record.usage = outcome.result.usage;
        record.responseModel = outcome.result.responseModel;
        record.sdkVersion = outcome.result.sdkVersion;
        record.cliVersion = outcome.result.cliVersion;
      }
      if (!outcome.ok) return { ok: false, error: outcome.error, message: outcome.message, record };

      const v = validateRawOutput(req.purpose, input, req.outputSchema, outcome.result.finalResponse);
      if (!v.ok) return { ok: false, error: v.error, message: v.message, record };
      return { ok: true, output: v.output, record };
    } finally {
      if (!this.config.keepWorkDir) await rm(workDir, { recursive: true, force: true });
    }
  }

  private buildRequest<T>(promptText: string, req: GenerateRequest<T>): SandboxRequest {
    const outputSchema = toCodexOutputSchema(req.outputSchema);
    if (requiresReferenceVisual(req.purpose, req.input))
      requireReferenceVisualSchema(outputSchema, referencePalette(req.input));
    return {
      prompt: promptText,
      outputSchema,
      model: this.requestedModel,
      images: req.input.attachments.filter((a) => a.kind === "image").map((a) => `input/files/${a.name}`),
      thread: {
        sandboxMode: this.config.sandboxMode ?? "workspace-write",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        approvalPolicy: "never",
        modelReasoningEffort: this.config.modelReasoningEffort ?? null,
      },
    };
  }

  private async createWorkDir(jobId: string, attempt: number): Promise<string> {
    const root = this.config.workRoot ?? path.join(os.tmpdir(), "siteoffer-gen");
    await mkdir(root, { recursive: true });
    return mkdtemp(path.join(root, `${jobId}-${attempt}-`));
  }
}

/** 作業ディレクトリに入力ファイルを置く。未確認の事実の値は書かない */
async function writeInputFiles(workDir: string, input: GenerationInput): Promise<void> {
  const inDir = path.join(workDir, "input");
  await mkdir(path.join(inDir, "external"), { recursive: true });
  await mkdir(path.join(inDir, "files"), { recursive: true });
  await mkdir(path.join(workDir, "out"), { recursive: true });

  const facts = input.facts.map((f) => ({ ...f, value: f.status === "confirmed" ? f.value : null }));
  await writeFile(path.join(inDir, "facts.json"), JSON.stringify(facts, null, 2));
  await writeFile(path.join(inDir, "context.json"), JSON.stringify(input.context, null, 2));
  for (const d of input.externalData) {
    await writeFile(path.join(inDir, "external", `${d.id}.txt`), d.content);
  }
  for (const a of input.attachments) {
    await copyFile(a.path, path.join(inDir, "files", a.name));
  }
}
