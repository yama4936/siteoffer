import { createDeliveryForContract, transitionDelivery } from "@siteoffer/core";
import { createDiscoveryJob } from "@siteoffer/discovery";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedDeliveryBase } from "../../../packages/core/src/delivery/test-helpers.ts";
import { createIntakeState, type IntakeLoop, startIntakeLoop } from "../src/intake.ts";
import { QUEUES } from "../src/queues.ts";
import { deferred, fakeSiteBuilder, setupEnv, type TestEnv } from "./helpers.ts";

const images = vi.hoisted(() => vi.fn<() => Promise<void>>());
const designs = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock("../src/design.ts", async (original) => ({
  ...(await original<typeof import("../src/design.ts")>()),
  processDesignJobs: images,
  intakeDesignBuilds: designs,
}));

let env: TestEnv;
let loop: IntakeLoop | undefined;
let release: (() => void) | undefined;
beforeEach(() => {
  designs.mockResolvedValue(undefined);
});
afterEach(async () => {
  release?.();
  await loop?.stop();
  await env?.cleanup();
  loop = undefined;
  release = undefined;
  images.mockReset();
  designs.mockReset();
});
async function discovery() {
  const r = await createDiscoveryJob(env.db, env.clock, { provider: "fixture", criteria: {} });
  if (!r.ok) throw new Error(r.error);
  return r.value.jobId;
}
function sent(id: string) {
  return env.queue.sent.filter(
    (r) => r.name === QUEUES.discovery && (r.data as { discoveryJobId: string }).discoveryJobId === id,
  );
}

describe("処理間で待たせない受付", () => {
  it("画像生成中も新しい収集を受け付け、停止は実行中の画像を待ち、次の受付を作らない", async () => {
    env = await setupEnv();
    const blocked = deferred();
    release = () => blocked.resolve();
    images.mockImplementation(() => blocked.promise);
    const first = await discovery();
    loop = startIntakeLoop(env.deps, 15, createIntakeState());
    await vi.waitFor(() => expect(sent(first)).toHaveLength(1), { timeout: 1200 });
    const second = await discovery();
    await vi.waitFor(() => expect(sent(second)).toHaveLength(1), { timeout: 1200 });
    expect(images).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    const third = await discovery();
    expect(stopped).toBe(false);
    blocked.resolve();
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent(third)).toEqual([]);
    expect(images).toHaveBeenCalledTimes(1);
  });

  it("納品ビルド中も画像と収集を繰り返し受け付け、同じビルドを重ねない", async () => {
    env = await setupEnv();
    const base = await seedDeliveryBase(env.db);
    const created = await createDeliveryForContract(env.db, env.clock, base.ops, base.contract.id);
    if (!created.ok) throw new Error(created.error);
    const moved = await transitionDelivery(env.db, env.clock, base.ops, created.value.delivery.id, "building");
    if (!moved.ok) throw new Error(moved.error);
    const blocked = deferred();
    const entered = vi.fn();
    const builder = fakeSiteBuilder().builder;
    release = () => blocked.resolve();
    env.deps.siteBuilder = {
      ...builder,
      buildDelivery: async (input) => {
        entered();
        await blocked.promise;
        return builder.buildDelivery(input);
      },
    };
    images.mockResolvedValue(undefined);
    loop = startIntakeLoop(env.deps, 15);
    await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const first = await discovery();
    await vi.waitFor(() => expect(sent(first)).toHaveLength(1), { timeout: 1200 });
    await vi.waitFor(() => expect(images.mock.calls.length).toBeGreaterThan(2), { timeout: 1200 });
    expect(entered).toHaveBeenCalledTimes(1);
  });

  it("画像の例外を他の受付に波及させず、次回に画像処理を再開する", async () => {
    env = await setupEnv();
    images.mockRejectedValueOnce(new Error("fixture-image-failure")).mockResolvedValue(undefined);
    const errors = vi.fn();
    env.deps.logger = { ...env.deps.logger, error: errors };
    const first = await discovery();
    loop = startIntakeLoop(env.deps, 15);
    await vi.waitFor(() => expect(sent(first)).toHaveLength(1));
    await vi.waitFor(() => expect(images.mock.calls.length).toBeGreaterThan(1));
    expect(errors).toHaveBeenCalledTimes(1);
    const second = await discovery();
    await vi.waitFor(() => expect(sent(second)).toHaveLength(1));
  });

  it("制作依頼の受付エラーでも収集を受け付け、次回の受付で復旧する", async () => {
    env = await setupEnv();
    images.mockResolvedValue(undefined);
    designs.mockRejectedValueOnce(new Error("fixture-design-queue-failure")).mockResolvedValue(undefined);
    const errors = vi.fn();
    env.deps.logger = { ...env.deps.logger, error: errors };
    const first = await discovery();
    loop = startIntakeLoop(env.deps, 15);
    await vi.waitFor(() => expect(sent(first)).toHaveLength(1));
    await vi.waitFor(() => expect(designs.mock.calls.length).toBeGreaterThan(1));
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it("収集専用モードは収集だけを実行する", async () => {
    env = await setupEnv();
    env.deps.discoveryOnly = true;
    const first = await discovery();
    const report = vi.fn(async () => {});
    loop = startIntakeLoop(env.deps, 15, undefined, report);
    await vi.waitFor(() => expect(sent(first)).toHaveLength(1));
    await loop.stop();
    expect(images).not.toHaveBeenCalled();
    expect(designs).not.toHaveBeenCalled();
    expect(report.mock.calls.every((call) => (call as unknown[])[1] === "dispatch")).toBe(true);
  });
});
