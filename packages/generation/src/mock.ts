import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { requiresReferenceVisual } from "./design-reference.ts";
import { promptVersion } from "./prompt.ts";
import type { GenerationPurpose } from "./schemas.ts";
import type { ExecutionRecord, GenerateRequest, Generator, GeneratorResult } from "./types.ts";
import { validateOutput } from "./validate.ts";

/** 固定応答の置き場所（リポジトリの fixtures/codex/） */
export const CODEX_FIXTURES_DIR = fileURLToPath(new URL("../../../fixtures/codex/", import.meta.url));

export function loadCodexFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${CODEX_FIXTURES_DIR}${name}.json`, "utf8"));
}

export interface MockGeneratorOptions {
  /** 用途ごとに固定応答を差し替える（スキーマ違反の確認などに使う） */
  overrides?: Partial<Record<GenerationPurpose, unknown>>;
}

/**
 * fixtures/codex/ の固定応答を返す生成器。Codexは呼ばない。
 * 出力は実生成と同じ検証（Zod・事実検査）を通す。モックでの成功は実生成の成功ではない（24.3）。
 * 実行記録の取得できない値（モデル・版・スレッドID・usage）はすべてnull。
 */
export class MockGenerator implements Generator {
  readonly kind = "mock";
  readonly requestedModel = null;
  readonly calls: GenerateRequest<unknown>[] = [];
  private readonly options: MockGeneratorOptions;

  constructor(options: MockGeneratorOptions = {}) {
    this.options = options;
  }

  promptVersion(purpose: GenerationPurpose): string {
    return promptVersion(purpose);
  }

  async generate<T>(req: GenerateRequest<T>): Promise<GeneratorResult<T>> {
    this.calls.push(req as GenerateRequest<unknown>);
    const record: ExecutionRecord = {
      generator: this.kind,
      requestedModel: null,
      responseModel: null,
      sdkVersion: null,
      cliVersion: null,
      promptVersion: this.promptVersion(req.purpose),
      threadId: null,
      requestId: null,
      usage: null,
    };
    if (req.signal?.aborted) return { ok: false, error: "aborted", message: "中断された", record };
    const overridden = this.options.overrides && req.purpose in this.options.overrides;
    const raw = overridden ? this.options.overrides?.[req.purpose] : loadCodexFixture(req.purpose);
    // 固定の架空デザイン。画像を解析した結果ではない。旧サービスが読むfixture自体は変更しない。
    if (!overridden && requiresReferenceVisual(req.purpose, req.input)) {
      (raw as { theme: Record<string, unknown> }).theme.visual = {
        headingFont: "sans",
        bodyFont: "sans",
        headingScale: "standard",
        background: "#ffffff",
        surface: "#f6f7f9",
        text: "#1a1a1a",
        headerTone: "brand",
        buttonTone: "accent",
        spacing: "comfortable",
        corners: "soft",
        contentWidth: "standard",
        heroTextShare: 60,
        heroFrame: "contained",
        heroImageRatio: "landscape",
        mobileHeroOrder: "text-first",
        serviceLayout: "grid",
      };
    }
    const v = validateOutput(req.purpose, req.input, req.outputSchema, raw);
    if (!v.ok) return { ok: false, error: v.error, message: v.message, record };
    return { ok: true, output: v.output, record };
  }
}
