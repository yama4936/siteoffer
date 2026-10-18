import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ThreadEvent, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { CodexGenerator } from "../src/codex.ts";
import { loadCodexFixture } from "../src/mock.ts";
import { type CodexLike, runCodexTurn } from "../src/sandbox/codex-turn.ts";
import { NoopSandboxRunner } from "../src/sandbox/noop.ts";
import type { SandboxRequest } from "../src/sandbox/types.ts";
import { generationOutputSchemas } from "../src/schemas.ts";
import { fixtureInput } from "./helpers.ts";

const baseReq = (purpose: "faq" | "proposal_text") => ({
  purpose,
  input: fixtureInput(),
  outputSchema: generationOutputSchemas[purpose] as z.ZodType<unknown>,
  jobId: "job-1",
  attempt: 1,
  timeoutMs: 60_000,
});

describe("CodexGenerator（NoopSandboxRunner 経由。実Codexは動かさない）", () => {
  it("作業ディレクトリ・構造化出力のスキーマ・タイムアウトを渡し、応答をZod検証して記録を返す", async () => {
    const runner = new NoopSandboxRunner([
      {
        threadId: "thread-abc",
        finalResponse: JSON.stringify(loadCodexFixture("faq")),
        usage: { input_tokens: 10, output_tokens: 5 },
        sdkVersion: "0.162.1",
        cliVersion: "0.162.1",
      },
    ]);
    let inputSeen: { facts: string; external: boolean } | null = null;
    const wrapped = {
      kind: runner.kind,
      run: async (spec: Parameters<NoopSandboxRunner["run"]>[0]) => {
        // 実行中に作業ディレクトリへ入力ファイルが置かれていること
        inputSeen = {
          facts: readFileSync(path.join(spec.workDir, "input/facts.json"), "utf8"),
          external: existsSync(path.join(spec.workDir, "input/external/site-top.txt")),
        };
        return runner.run(spec);
      },
    };
    const gen = new CodexGenerator(wrapped);
    const r = await gen.generate(baseReq("faq"));

    expect(r.ok).toBe(true);
    expect(r.record).toMatchObject({
      generator: "codex",
      requestedModel: null,
      responseModel: null,
      requestId: null,
      threadId: "thread-abc",
      sdkVersion: "0.162.1",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const call = runner.calls[0]!;
    expect(call.timeoutMs).toBe(60_000);
    expect(call.request.model).toBeNull();
    expect(call.request.outputSchema).toMatchObject({ type: "object" });
    expect(call.request.thread).toMatchObject({
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      approvalPolicy: "never",
    });
    expect(inputSeen!.external).toBe(true);
    expect(inputSeen!.facts).not.toContain("外壁塗装80万円から");
    // 終了後は作業ディレクトリを消す
    expect(existsSync(call.workDir)).toBe(false);
  });

  it("モデルIDは設定から渡す", async () => {
    const runner = new NoopSandboxRunner([{ finalResponse: JSON.stringify(loadCodexFixture("faq")) }]);
    const gen = new CodexGenerator(runner, { model: "test-model-id" });
    const r = await gen.generate(baseReq("faq"));
    expect(r.record.requestedModel).toBe("test-model-id");
    expect(runner.calls[0]!.request.model).toBe("test-model-id");
  });

  it("スキーマ違反の応答は失敗し、スレッドIDは記録に残る", async () => {
    const runner = new NoopSandboxRunner([{ threadId: "thread-x", finalResponse: JSON.stringify({ items: [] }) }]);
    const r = await new CodexGenerator(runner).generate(baseReq("faq"));
    expect(r).toMatchObject({ ok: false, error: "schema_violation" });
    expect(r.record.threadId).toBe("thread-x");
  });

  it("実行場所の失敗はそのまま返す", async () => {
    const runner = new NoopSandboxRunner([{ fail: "sandbox_error", message: "container exited" }]);
    const r = await new CodexGenerator(runner).generate(baseReq("proposal_text"));
    expect(r).toMatchObject({ ok: false, error: "sandbox_error" });
  });

  it.each([false, true])("停止未確認・実行場所の例外ではマウント元を削除しない（例外: %s）", async (throws) => {
    const root = await mkdtemp(path.join(tmpdir(), "siteoffer-stop-test-"));
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith("siteoffer-stop-test-"))
      throw Error("Unexpected test path");
    let workDir = "";
    try {
      const generator = new CodexGenerator(
        {
          kind: "test-only",
          async run(spec) {
            workDir = spec.workDir;
            if (throws) throw new Error("private runtime error");
            return {
              ok: false,
              error: "sandbox_stop_unconfirmed",
              message: "stop unknown",
              result: null,
              stopped: false,
            };
          },
        },
        { workRoot: root },
      );
      const result = await generator.generate(baseReq("faq"));
      expect(result).toMatchObject({ ok: false, error: "sandbox_stop_unconfirmed" });
      expect(existsSync(path.join(workDir, "input/facts.json"))).toBe(true);
      expect(await readdir(root)).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("private runtime error");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** Codex SDK の Thread と同じ形の偽物。runStreamed のイベントを返す */
function fakeCodex(
  events: ThreadEvent[],
  seen: { thread?: ThreadOptions; turn?: TurnOptions; input?: unknown },
): CodexLike {
  return {
    startThread(options?: ThreadOptions) {
      seen.thread = options;
      return {
        id: null,
        async runStreamed(input: unknown, turn?: TurnOptions) {
          seen.input = input;
          seen.turn = turn;
          return {
            events: (async function* () {
              for (const e of events) yield e;
            })(),
          };
        },
      } as unknown as ReturnType<CodexLike["startThread"]>;
    },
  };
}

const sandboxReq: SandboxRequest = {
  prompt: "p",
  outputSchema: { type: "object" },
  model: null,
  images: ["input/files/shot.png"],
  thread: {
    sandboxMode: "workspace-write",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    approvalPolicy: "never",
    modelReasoningEffort: null,
  },
};

describe("runCodexTurn（コンテナ内の処理。SDKの偽物で確認）", () => {
  it("スレッドID・最終応答・usageを取り出し、構造化出力のスキーマと作業ディレクトリを渡す", async () => {
    const seen: { thread?: ThreadOptions; turn?: TurnOptions; input?: unknown } = {};
    const usage = {
      input_tokens: 1,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 2,
      reasoning_output_tokens: 0,
    };
    const r = await runCodexTurn(sandboxReq, {
      codex: fakeCodex(
        [
          { type: "thread.started", thread_id: "t-1" },
          { type: "turn.started" },
          { type: "item.completed", item: { id: "i", type: "agent_message", text: '{"a":1}' } },
          { type: "turn.completed", usage },
        ],
        seen,
      ),
      workingDirectory: "/work",
      sdkVersion: "0.162.1",
      cliVersion: null,
    });
    expect(r).toMatchObject({
      ok: true,
      threadId: "t-1",
      finalResponse: '{"a":1}',
      usage,
      responseModel: null,
      cliVersion: null,
    });
    expect(seen.thread).toMatchObject({
      workingDirectory: "/work",
      skipGitRepoCheck: true,
      networkAccessEnabled: false,
    });
    expect(seen.thread).not.toHaveProperty("model");
    expect(seen.turn?.outputSchema).toEqual({ type: "object" });
    expect(seen.input).toEqual([
      { type: "text", text: "p" },
      { type: "local_image", path: path.resolve("/work/input/files/shot.png") },
    ]);
  });

  it("ターンが失敗してもスレッドIDを残す", async () => {
    const r = await runCodexTurn(sandboxReq, {
      codex: fakeCodex(
        [
          { type: "thread.started", thread_id: "t-2" },
          { type: "turn.failed", error: { message: "rate limited" } },
        ],
        {},
      ),
      workingDirectory: "/work",
      sdkVersion: null,
      cliVersion: null,
    });
    expect(r).toMatchObject({ ok: false, threadId: "t-2", error: "rate limited", usage: null });
  });
});
