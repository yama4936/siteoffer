import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { err, ok } from "@siteoffer/core";
import { companies, type Db, websites } from "@siteoffer/db";
import { type AuditOptions, defaultAuditOptions } from "../src/config.ts";
import type { EvaluationGenerator, EvaluationGeneratorInput } from "../src/generator.ts";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const FIXTURES = path.join(REPO_ROOT, "fixtures/audit");
export const COLLECTED_FIXTURE = path.join(FIXTURES, "collected/kakuu-koumuten.collected.json");
export const EVALUATION_FIXTURE = path.join(FIXTURES, "evaluations/kakuu-koumuten.evaluation.json");
export const SITE_DIR = path.join(FIXTURES, "sites/kakuu-koumuten");

type Ev = { items: Array<Record<string, unknown>>; [k: string]: unknown };

/** 固定応答の評価JSON（毎回コピーを返す） */
export function evaluationFixture(): Ev {
  return JSON.parse(readFileSync(EVALUATION_FIXTURE, "utf8")) as Ev;
}

/** 固定応答の生成器。受け取った入力を記録する */
export function fixedGenerator(evaluation: unknown, model: string | null = null) {
  const calls: EvaluationGeneratorInput[] = [];
  const gen: EvaluationGenerator = {
    async generate(input) {
      calls.push(input);
      return ok({ evaluation: structuredClone(evaluation), model });
    },
  };
  return { gen, calls };
}

export const failingGenerator: EvaluationGenerator = {
  async generate() {
    return err("generation_failed", "モックの失敗");
  },
};

/** 一時ディレクトリを成果物の保存先にした設定。configOverride を渡すと一時の設定ファイルを作る */
export async function tempOptions(configOverride?: (cfg: { proposal: Record<string, unknown> }) => void): Promise<{
  options: AuditOptions;
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "siteoffer-audit-"));
  const base = defaultAuditOptions({}, { paths: { repoRoot: REPO_ROOT }, screenshot: false });
  let configPath = base.paths.configPath;
  if (configOverride) {
    const cfg = JSON.parse(await readFile(base.paths.configPath, "utf8"));
    configOverride(cfg);
    configPath = path.join(dir, "site-evaluation.json");
    await writeFile(configPath, JSON.stringify(cfg));
  }
  const options: AuditOptions = {
    ...base,
    paths: { ...base.paths, artifactRoot: path.join(dir, "artifacts"), configPath },
  };
  return { options, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function seedWebsite(db: Db, url = "https://kakuu-koumuten.example/") {
  const [company] = await db.insert(companies).values({ name: "架空工務店" }).returning();
  const u = new URL(url);
  const [site] = await db
    .insert(websites)
    .values({ companyId: company!.id, url, normalizedUrl: u.href, domain: u.host, isPrimary: true })
    .returning();
  return { company: company!, site: site! };
}

/** fixtures/audit/sites の架空サイトを配信するローカルHTTPサーバー（127.0.0.1） */
export async function startFixtureServer(root: string = SITE_DIR) {
  const requests: string[] = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.url ?? "");
    const rel = (req.url ?? "/").split("?")[0]!;
    const file = path.resolve(root, `.${rel === "/" ? "/index.html" : rel}`);
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      const type = file.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
      res.writeHead(200, { "content-type": type }).end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
