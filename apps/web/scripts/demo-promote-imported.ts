/**
 * デモ専用：pnpm reports:import で取り込んだ実在企業（reports/sites の評価）を、営業画面で見られるところまで進める。
 * 起動中の pnpm demo のDBにだけ使う。正の設定（config/site-evaluation.json）・開発用DBには触れない。
 *
 * 1. 取り込んだ診断（評価済み）の判定を create に書き換える。閾値による判定ではなく、デモのための手動変更として理由と操作履歴に残す
 * 2. 提案の生成キュー（pipeline.proposal）へ送る。生成はデモのワーカー（モック）が行い、提案版は運営確認待ちになる
 * 3. 運営確認待ちになった版を運営アカウントで承認し、デモ用の販売・報酬条件の版で営業可能にする（運営画面と同じ関数）
 *
 * 既定は総合点80点以下。以前の70点以下から、地域・業種と候補の質の幅を広げるためのデモ専用値。
 * --max-score <点>：既定値を一時的に上書きする。超える企業は営業可能を取り下げる（運営画面の withdrawSellable）。
 *   正の設定の閾値（null）は変えない。
 *
 * 再実行してよい：営業可能の企業は飛ばし、送信は singletonKey で重複しない。
 * 実行：pnpm demo を起動したまま、別の端末で pnpm demo:promote-imported（apps/web/scripts に置くのは、運営画面と同じ関数を web の設定で読むため）
 */
import { createRequire } from "node:module";
import { recordEvent, systemClock } from "@siteoffer/core";
import { companies, createDb, siteAudits } from "@siteoffer/db";
import { eq } from "drizzle-orm";
import { DEMO_DATABASE_URL, REPO_ROOT } from "../../../demo/paths.ts";
import { latestProposalVersion, makeSellable, reviewProposalVersion, withdrawSellable } from "../lib/ops/commands";

interface BossModule {
  PgBoss: new (opts: {
    connectionString: string;
    schema: string;
  }) => {
    start(): Promise<unknown>;
    stop(opts?: { graceful?: boolean }): Promise<void>;
    send(name: string, data: object, opts: { singletonKey: string }): Promise<string | null>;
    on(event: "error", fn: (e: unknown) => void): void;
  };
}

const PROPOSAL_QUEUE = "pipeline.proposal";
const TERMS_VERSION = "demo-2026-10";
const OPS_EMAIL = "ops@example.test";
const WAIT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SCORE = 80;
const REASON = "デモ用に手動で create に変更（閾値による判定ではない。scripts/import-reports.ts で取り込んだ評価）";

const { PgBoss } = createRequire(new URL("../../worker/package.json", import.meta.url))("pg-boss") as BossModule;
const { db, close } = createDb(DEMO_DATABASE_URL);
const boss = new PgBoss({ connectionString: DEMO_DATABASE_URL, schema: "pgboss" });
boss.on("error", (e) => console.error("[pg-boss]", e));
const deps = { db, clock: systemClock };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const maxScoreArg = process.argv.indexOf("--max-score");
const maxScore = maxScoreArg >= 0 ? Number(process.argv[maxScoreArg + 1]) : DEFAULT_MAX_SCORE;
if (!Number.isFinite(maxScore)) throw new Error("--max-score には数値を指定する");

try {
  const opsUser = await db.query.users.findFirst({ where: (t, { eq }) => eq(t.email, OPS_EMAIL) });
  if (opsUser?.role !== "ops") throw new Error(`運営アカウント ${OPS_EMAIL} がない（pnpm demo のシード前？）`);
  const ops = { kind: "ops", userId: opsUser.id } as const;
  const terms = await db.query.productTerms.findFirst({ where: (t, { eq }) => eq(t.version, TERMS_VERSION) });
  if (!terms) throw new Error(`販売・報酬条件の版 ${TERMS_VERSION} がない`);

  let imported = (await db.select().from(siteAudits)).filter(
    (a) => a.status === "evaluated" && a.artifactDir?.startsWith(`${REPO_ROOT}reports/sites/`),
  );
  if (!imported.length) throw new Error("取り込んだ評価がない。先に pnpm reports:import を実行する");
  const allCompanies = new Map((await db.select().from(companies)).map((c) => [c.id, c]));

  // 0. 点数で絞る：上限を超える企業は営業可能を取り下げ、以降の処理から外す
  const within = (a: (typeof imported)[number]) => Number(a.totalScore) <= maxScore;
  let withdrawn = 0;
  for (const a of imported.filter((a) => !within(a))) {
    const company = allCompanies.get(a.companyId);
    if (company?.pipelineStatus !== "sellable") continue;
    const r = await withdrawSellable(deps, ops, {
      companyId: company.id,
      reason: `デモで総合点${maxScore}点以下に絞るため（${a.totalScore}点）`,
    });
    if (r.ok) withdrawn++;
    else console.log(`取り下げできない：${company.name}（${r.message ?? r.error}）`);
  }
  console.log(`${maxScore}点を超える企業の営業可能を取り下げた：${withdrawn}社`);
  imported = imported.filter(within);

  // 1・2. 判定を create にして生成キューへ送る
  await boss.start();
  const pending = new Map<string, string>(); // companyId → 企業名
  for (const a of imported) {
    const company = allCompanies.get(a.companyId);
    if (!company || company.pipelineStatus === "sellable") continue;
    if (a.decision !== "create") {
      await db.transaction(async (tx) => {
        await tx
          .update(siteAudits)
          .set({ decision: "create", decisionReason: REASON, updatedAt: systemClock.now() })
          .where(eq(siteAudits.id, a.id));
        await recordEvent(tx, systemClock, {
          actor: { kind: "system", job: "demo-promote-imported" },
          action: "site_audit.decision_overridden",
          targetType: "site_audit",
          targetId: a.id,
          before: { decision: a.decision },
          after: { decision: "create", reason: REASON },
        });
      });
    }
    const latest = await latestProposalVersion(db, company.id);
    if (!latest) {
      const payload = { companyId: company.id, auditId: a.id, revision: "initial" };
      await boss.send(PROPOSAL_QUEUE, payload, { singletonKey: `proposal:${company.id}:${a.id}:initial` });
    }
    pending.set(company.id, company.name);
  }
  console.log(`生成待ち・承認待ち ${pending.size}社（生成はデモのワーカーが順に行う）`);

  // 3. 運営確認待ちになったものから承認して営業可能にする
  const started = Date.now();
  let sellable = 0;
  const failed: string[] = [];
  while (pending.size && Date.now() - started < WAIT_MS) {
    for (const [companyId, name] of [...pending]) {
      const latest = await latestProposalVersion(db, companyId);
      if (!latest || latest.status === "generating") continue;
      if (latest.status === "in_review") {
        const r = await reviewProposalVersion(deps, ops, { proposalVersionId: latest.id, decision: "approved" });
        if (!r.ok) {
          failed.push(`${name}：承認できない（${r.message ?? r.error}）`);
          pending.delete(companyId);
          continue;
        }
      } else if (latest.status !== "approved") {
        failed.push(`${name}：提案版が ${latest.status}`);
        pending.delete(companyId);
        continue;
      }
      const s = await makeSellable(deps, ops, { companyId, productTermsId: terms.id });
      if (s.ok) {
        sellable++;
        console.log(`営業可能：${name}`);
      } else failed.push(`${name}：営業可能にできない（${s.message ?? s.error}）`);
      pending.delete(companyId);
    }
    if (pending.size) await sleep(5000);
  }
  console.log(`営業可能にした ${sellable}社、失敗 ${failed.length}社、時間切れで残り ${pending.size}社`);
  for (const f of failed) console.log(`  ${f}`);
  if (pending.size) console.log("  残りはワーカーの生成が終わってから、もう一度実行すると続きを進める");
} finally {
  await boss.stop({ graceful: false }).catch(() => {});
  await close();
}
