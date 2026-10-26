import { existsSync } from "node:fs";
import path from "node:path";
import { fixedClock } from "@siteoffer/core";
import { auditEvents, type Db, findings, siteAudits } from "@siteoffer/db";
import { createTestDb } from "@siteoffer/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createFixtureCollector } from "../src/collect.ts";
import { type AuditOptions, scriptPaths } from "../src/config.ts";
import { createPythonRunner, type PythonRunner } from "../src/python.ts";
import { runSiteAudit } from "../src/service.ts";
import { COLLECTED_FIXTURE, evaluationFixture, fixedGenerator, seedWebsite, tempOptions } from "./helpers.ts";

let db: Db, close: () => Promise<void>, options: AuditOptions, cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  ({ options, cleanup } = await tempOptions());
});
afterEach(async () => {
  await close();
  await cleanup();
});

it.each([
  { label: "文字化け", output: JSON.stringify({ decision: "create", reasons: ["読めない\uFFFD fixture-private"] }) },
  { label: "null", output: "null" },
  { label: "prototypeの判定値", output: JSON.stringify({ decision: "constructor", reasons: ["fixture-private"] }) },
  { label: "理由なし", output: JSON.stringify({ decision: "create", reasons: [] }) },
  {
    label: "文字列でない理由",
    output: JSON.stringify({ decision: "create", reasons: [{ private: "fixture-private" }] }),
  },
])("$label の判定を採用せず、診断を失敗として保存し、項目と判定資料を確定しない", async ({ output }) => {
  const { site } = await seedWebsite(db),
    real = createPythonRunner(),
    calls: string[] = [];
  const runner: PythonRunner = {
    async run(script, args, opts) {
      calls.push(script);
      if (script === scriptPaths(options.paths).decide)
        return { exitCode: 0, stdout: output, stderr: "", timedOut: false };
      return real.run(script, args, opts);
    },
  };
  const result = await runSiteAudit(
    db,
    fixedClock("2026-10-19T00:00:00Z"),
    {
      collector: createFixtureCollector(COLLECTED_FIXTURE),
      generator: fixedGenerator(evaluationFixture()).gen,
      runner,
      options,
    },
    { websiteId: site.id, actor: { kind: "system", job: "decision-validation-test" } },
  );
  if (!result.ok) throw Error(result.error);
  expect(result.value).toMatchObject({ status: "failed", decision: null });
  const [row] = await db.select().from(siteAudits).where(eq(siteAudits.id, result.value.auditId));
  expect(row).toMatchObject({ status: "failed", decision: null, decisionReason: null, totalScore: null });
  expect(row!.failureReason).toBeTruthy();
  expect(row!.failureReason).not.toContain("fixture-private");
  expect(await db.select().from(findings)).toHaveLength(0);
  const events = await db.select().from(auditEvents);
  expect(events.some((event) => event.action === "site_audit.evaluated")).toBe(false);
  expect(events.filter((event) => event.action === "site_audit.failed")).toHaveLength(1);
  expect(existsSync(path.join(row!.artifactDir!, "evaluation.json"))).toBe(true);
  expect(existsSync(path.join(row!.artifactDir!, "decision.json"))).toBe(false);
  expect(calls).toContain(scriptPaths(options.paths).score);
  expect(calls).toContain(scriptPaths(options.paths).decide);
});
