import { createHash } from "node:crypto";
import { type Actor, type Clock, err, ok, type Result, recordEvent } from "@siteoffer/core";
import { type Db, type DbOrTx, generationJobs } from "@siteoffer/db";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { type GenerationLimits, resolveLimits } from "./config.ts";
import {
  GENERATION_HEARTBEAT_MS,
  GENERATION_INTERRUPTED_MESSAGE,
  GENERATION_LEASE_MS,
  GenerationLeaseLost,
  ownedGeneration,
  recoverExpiredGenerationJobs,
  renewGenerationLease,
} from "./lease.ts";
import { ConcurrencyLimiter, GenerationWaitAborted } from "./limiter.ts";
import {
  type GenerationInput,
  type GenerationOutputOf,
  type GenerationPurpose,
  generationInputSchema,
  generationOutputSchemas,
} from "./schemas.ts";
import type { ExecutionRecord, Generator, GeneratorErrorCode, GeneratorResult } from "./types.ts";

export type GenerationJob = typeof generationJobs.$inferSelect;

export interface GenerationDeps {
  db: Db;
  clock: Clock;
  generator: Generator;
  limits?: Partial<GenerationLimits>;
  /** 同時実行数の上限。複数の呼び出しで共有する。省略時は limits.maxConcurrent で作ったものを毎回使う */
  limiter?: ConcurrencyLimiter;
  actor?: Actor;
}

export interface GenerationJobRequest<P extends GenerationPurpose, T = GenerationOutputOf<P>> {
  /** 二重実行防止のキー。再生成は新しいキー（新しい版）で行う */
  idempotencyKey: string;
  companyId: string | null;
  purpose: P;
  input: GenerationInput;
  /** 省略時は用途の既定スキーマ */
  outputSchema?: z.ZodType<T>;
  /** 親の制作・提案処理の中断。待機と実行中の生成器へ伝える。 */
  signal?: AbortSignal;
}

export interface GenerationJobOutcome<T> {
  job: GenerationJob;
  /** 検証済みの出力。既存ジョブが未完了・失敗ならnull */
  output: T | null;
  /** 同じ冪等キーの既存ジョブを返した */
  reused: boolean;
}

export type GenerationJobError = "invalid_input" | "generation_failed";

/** 再試行しない失敗（外部からの中断） */
const NON_RETRYABLE: GeneratorErrorCode[] = ["aborted"];

const SYSTEM_ACTOR: Actor = { kind: "system", job: "generation" };

/** 入力の参照。本文は保存せず、ハッシュと識別子だけを残す */
function inputRef(input: GenerationInput) {
  return {
    sha256: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
    factKeys: input.facts.map((f) => f.key),
    needsReviewFactKeys: input.facts.filter((f) => f.status === "needs_review").map((f) => f.key),
    externalDataIds: input.externalData.map((d) => d.id),
    attachments: input.attachments.map((a) => a.name),
    imagePolicies: input.attachments
      .filter((a) => a.kind === "image")
      .map((a) => ({ name: a.name, policy: a.imagePolicy })),
  };
}

function emptyRecord(generator: Generator, purpose: GenerationPurpose): ExecutionRecord {
  return {
    generator: generator.kind,
    requestedModel: generator.requestedModel,
    responseModel: null,
    sdkVersion: null,
    cliVersion: null,
    promptVersion: generator.promptVersion(purpose),
    threadId: null,
    requestId: null,
    usage: null,
  };
}

function recordColumns(r: ExecutionRecord) {
  return {
    requestedModel: r.requestedModel,
    responseModel: r.responseModel,
    sdkVersion: r.sdkVersion,
    cliVersion: r.cliVersion,
    promptVersion: r.promptVersion,
    threadId: r.threadId,
    requestId: r.requestId,
    usage: r.usage,
  };
}

async function updateJob(
  db: DbOrTx,
  clock: Clock,
  id: string,
  values: Partial<typeof generationJobs.$inferInsert>,
): Promise<GenerationJob> {
  // 行ロックの待ち時間中に期限を過ぎた場合も、取得後の時刻で再照合する。
  await db.select({ id: generationJobs.id }).from(generationJobs).where(eq(generationJobs.id, id)).for("update");
  const terminal = values.status === "succeeded" || values.status === "failed";
  const [row] = await db
    .update(generationJobs)
    .set({ ...values, ...(terminal ? { leaseUntil: null } : {}) })
    .where(ownedGeneration(id, clock.now()))
    .returning();
  if (!row) throw new GenerationLeaseLost();
  return row;
}

/** 1回の試行。タイムアウトしたら generator の完了を待たずに打ち切る */
async function attemptOnce<T>(
  generator: Generator,
  purpose: GenerationPurpose,
  input: GenerationInput,
  outputSchema: z.ZodType<T>,
  jobId: string,
  attempt: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<GeneratorResult<T>> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let cause: "timeout" | "aborted" | undefined;
  let stop!: (value: "timeout" | "aborted") => void;
  const stopped = new Promise<"timeout" | "aborted">((resolve) => {
    stop = resolve;
  });
  const cancel = (reason: "timeout" | "aborted") => {
    if (cause) return;
    cause = reason;
    stop(reason);
    ac.abort();
  };
  const onAbort = () => cancel("aborted");
  const failure = (error: "timeout" | "aborted"): GeneratorResult<T> => ({
    ok: false,
    error,
    message: error === "timeout" ? `${timeoutMs}msで打ち切った` : "親の処理が中断されたため生成を停止しました",
    record: emptyRecord(generator, purpose),
  });
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) return failure("aborted");
    timer = setTimeout(() => cancel("timeout"), timeoutMs);
    const r = await Promise.race([
      generator.generate({ purpose, input, outputSchema, jobId, attempt, timeoutMs, signal: ac.signal }),
      stopped,
    ]);
    // 中断に協調しない生成器が遅れて成功しても採用しない。タイムアウトと親からの中断を区別する。
    if (cause) return failure(cause);
    if (typeof r === "string") return failure(r);
    return r;
  } catch (e) {
    if (cause) return failure(cause);
    return {
      ok: false,
      error: "sandbox_error",
      message: (e as Error).message,
      record: emptyRecord(generator, purpose),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 生成ジョブを実行する（10.3・10.4・24.3）。
 * - 同じ冪等キーのジョブがあれば実行せずにそれを返す。
 * - 再試行上限・1回のタイムアウト・同時実行数の上限を守る。
 * - 実行記録は試行ごとに generation_jobs に保存し、取れない値はnullのまま。
 */
export async function runGenerationJob<P extends GenerationPurpose, T = GenerationOutputOf<P>>(
  deps: GenerationDeps,
  req: GenerationJobRequest<P, T>,
): Promise<Result<GenerationJobOutcome<T>, GenerationJobError>> {
  const { db, clock, generator } = deps;
  const actor = deps.actor ?? SYSTEM_ACTOR;
  const limits = resolveLimits(deps.limits);
  const limiter = deps.limiter ?? new ConcurrencyLimiter(limits.maxConcurrent);
  const outputSchema = (req.outputSchema ?? generationOutputSchemas[req.purpose]) as z.ZodType<T>;

  const parsedInput = generationInputSchema.safeParse(req.input);
  if (!parsedInput.success) return err("invalid_input", parsedInput.error.message);
  const input = parsedInput.data;

  // 作成（冪等キーの一意制約で二重作成を防ぐ）
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(generationJobs)
      .values({
        idempotencyKey: req.idempotencyKey,
        companyId: req.companyId,
        purpose: req.purpose,
        status: "queued",
        leaseUntil: new Date(clock.now().getTime() + GENERATION_LEASE_MS),
        generator: generator.kind,
        requestedModel: generator.requestedModel,
        promptVersion: generator.promptVersion(req.purpose),
        inputRef: inputRef(input),
        createdAt: clock.now(),
      })
      .onConflictDoNothing({ target: generationJobs.idempotencyKey })
      .returning();
    if (row) {
      await recordEvent(tx, clock, {
        actor,
        action: "generation.job_created",
        targetType: "generation_job",
        targetId: row.id,
        after: { purpose: row.purpose, generator: row.generator, idempotencyKey: row.idempotencyKey },
      });
    }
    return row;
  });

  if (!created) {
    const [existing] = await db
      .select()
      .from(generationJobs)
      .where(eq(generationJobs.idempotencyKey, req.idempotencyKey));
    const job = existing!;
    return ok({ job, output: job.status === "succeeded" ? (job.output as T) : null, reused: true });
  }

  // 待機中も更新する。ジョブを取得し直す方式ではないため、失効後の復活は認めない。
  const lease = new AbortController();
  const signal = req.signal ? AbortSignal.any([req.signal, lease.signal]) : lease.signal;
  let ping: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (!ping)
      ping = renewGenerationLease(db, clock, created.id)
        .then((owned) => {
          if (!owned) lease.abort();
        })
        .catch(() => {
          lease.abort();
        })
        .finally(() => {
          ping = null;
        });
  }, GENERATION_HEARTBEAT_MS);
  timer.unref();
  try {
    return await limiter
      .run(async () => {
        let job = created;
        let last: Extract<GeneratorResult<T>, { ok: false }> | null = null;

        for (let attempt = 1; attempt <= limits.maxAttempts; attempt++) {
          job = await db.transaction(async (tx) => {
            const row = await updateJob(tx, clock, job.id, {
              status: "running",
              attempts: attempt,
              startedAt: job.startedAt ?? clock.now(),
            });
            await recordEvent(tx, clock, {
              actor,
              action: "generation.attempt_started",
              targetType: "generation_job",
              targetId: job.id,
              after: { attempt },
            });
            return row;
          });

          const r = await attemptOnce(
            generator,
            req.purpose,
            input,
            outputSchema,
            job.id,
            attempt,
            limits.timeoutMs,
            signal,
          );

          if (r.ok) {
            const sha256 = createHash("sha256").update(JSON.stringify(r.output)).digest("hex");
            job = await db.transaction(async (tx) => {
              const row = await updateJob(tx, clock, job.id, {
                ...recordColumns(r.record),
                status: "succeeded",
                output: r.output,
                outputRef: { storage: "generation_jobs.output", sha256 },
                errorCode: null,
                error: null,
                finishedAt: clock.now(),
              });
              await recordEvent(tx, clock, {
                actor,
                action: "generation.succeeded",
                targetType: "generation_job",
                targetId: job.id,
                after: { attempt, threadId: r.record.threadId, outputSha256: sha256 },
              });
              return row;
            });
            return ok({ job, output: r.output, reused: false });
          }

          last = r;
          const final = attempt >= limits.maxAttempts || NON_RETRYABLE.includes(r.error);
          job = await db.transaction(async (tx) => {
            const row = await updateJob(tx, clock, job.id, {
              ...recordColumns(r.record),
              status: final ? "failed" : "running",
              errorCode: r.error,
              error: r.message.slice(0, 2000),
              ...(final ? { finishedAt: clock.now() } : {}),
            });
            await recordEvent(tx, clock, {
              actor,
              action: final ? "generation.failed" : "generation.attempt_failed",
              targetType: "generation_job",
              targetId: job.id,
              after: { attempt, errorCode: r.error, threadId: r.record.threadId },
            });
            return row;
          });
          if (final) break;
        }

        return err("generation_failed", `${job.id}: ${last?.error ?? "unknown"}: ${last?.message ?? ""}`);
      }, signal)
      .catch(async (error: unknown) => {
        if (!(error instanceof GenerationWaitAborted)) throw error;
        // 実行枠を待っている間の中断も永続化する。生成器を呼ばず、試行回数は増やさない。
        await db.transaction(async (tx) => {
          await updateJob(tx, clock, created.id, {
            status: "failed",
            errorCode: "aborted",
            error: "親の処理が中断されたため生成を停止しました",
            finishedAt: clock.now(),
          });
          await recordEvent(tx, clock, {
            actor,
            action: "generation.failed",
            targetType: "generation_job",
            targetId: created.id,
            after: { errorCode: "aborted" },
          });
        });
        return err("generation_failed", "親の処理が中断されたため生成を停止しました");
      });
  } catch (error) {
    if (!(error instanceof GenerationLeaseLost)) throw error;
    await recoverExpiredGenerationJobs(db, clock, created.id);
    return err("generation_failed", GENERATION_INTERRUPTED_MESSAGE);
  } finally {
    clearInterval(timer);
    if (ping) await ping;
  }
}

/** 冪等キーでジョブを探す */
export async function findGenerationJob(db: DbOrTx, idempotencyKey: string): Promise<GenerationJob | null> {
  const [row] = await db.select().from(generationJobs).where(eq(generationJobs.idempotencyKey, idempotencyKey));
  return row ?? null;
}
