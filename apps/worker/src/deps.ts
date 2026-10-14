import type { AuditDeps } from "@siteoffer/audit";
import type { Clock } from "@siteoffer/core";
import type { Db } from "@siteoffer/db";
import type { DiscoveryProvider, SearchProvider } from "@siteoffer/discovery";
import type { ConcurrencyLimiter, GenerationLimits, Generator } from "@siteoffer/generation";
import type { GenerationInputBuilder } from "./input.ts";
import type { QueueName, StepKind, StepPolicy } from "./queues.ts";
import type { SiteBuilder } from "./site-builder.ts";

/** 次の処理をキューへ送る口。本番は pg-boss、テストはメモリ上のキュー */
export interface JobQueue {
  send(name: QueueName, data: object, options: { singletonKey: string }): Promise<void>;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  info: (msg, meta) => console.log(`[worker] ${msg}`, meta ?? ""),
  warn: (msg, meta) => console.warn(`[worker] ${msg}`, meta ?? ""),
  error: (msg, meta) => console.error(`[worker] ${msg}`, meta ?? ""),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** ワーカーの処理が使う部品。設定（config.ts）から組み立てる。テストでは個別に差し替える */
export interface WorkerDeps {
  db: Db;
  clock: Clock;
  queue: JobQueue;
  logger: Logger;
  discovery: {
    /** 有効な企業候補の取得元（名前 → 実装）。収集ジョブの provider で選ぶ */
    providers: Record<string, DiscoveryProvider>;
    search?: SearchProvider;
    thirdPartyDomains?: readonly string[];
  };
  /** 診断（collect.py → 採点 → score.py → decide.py） */
  audit: AuditDeps;
  /** 提案の生成 */
  generation: {
    generator: Generator;
    limits?: Partial<GenerationLimits>;
    limiter?: ConcurrencyLimiter;
  };
  buildGenerationInput: GenerationInputBuilder;
  siteBuilder: SiteBuilder;
  /** デモのビルド結果の保存先（Gitに入れない場所） */
  demoArtifactRoot: string;
  /** 納品版のビルド結果の保存先（Gitに入れない場所） */
  deliveryArtifactRoot: string;
  policies: Record<StepKind, StepPolicy>;
  /** 収集ジョブが running のまま、これより長く経っていれば失敗に戻す */
  discoveryStaleAfterMs: number;
}
