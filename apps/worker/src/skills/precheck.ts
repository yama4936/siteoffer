/**
 * 改善後サイトのAIの事前チェック。運営の最終確認の前に、ワーカー自身が site-rebuild の検査スクリプトを動かして判定する。
 * Codex が書いた site-check.json・rebuild.json の check 欄は信用しない（成果物の自己申告のため）。
 *
 * 判定の根拠（.agents/skills/site-rebuild）：
 * - scripts/check.py：errors[].check の分類ごとに4項目へ振り分ける。全体の ok も合格の条件にする
 * - scripts/check_mobile_quality.py：スマホ実画面レビューの証跡（390×844、各ページの状態・画像）
 * - quality-review.json の合格線：80点以上（check.py・references/design-quality.md）、
 *   スマホ12/15以上（references/design-quality.md・check_mobile_quality.py）、PC幅1000以上・スマホ幅430以下（check.py）
 * - review.facts_verified は site/content-plan.json にある（references/content-selection.md・fact-verification.md）
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { proposalPrecheckSchema } from "@siteoffer/schemas";
import type { PrecheckItem, PrecheckItemKey, ProposalAiCheck } from "./precheck-types.ts";

export type { PrecheckItem, PrecheckItemKey, ProposalAiCheck } from "./precheck-types.ts";

/** quality-review.json の合格線（check.py の「pass には80点以上が必要」） */
export const QUALITY_PASS_TOTAL = 80;
/** スマホ品質の合格線（design-quality.md「scores.mobile は12/15以上」） */
export const MOBILE_PASS_SCORE = 12;
/** check.py が PC・スマホのレビューとみなす幅 */
export const PC_MIN_WIDTH = 1000;
export const MOBILE_MAX_WIDTH = 430;

export const PRECHECK_ITEM_LABEL: Record<PrecheckItemKey, string> = {
  company: "会社情報",
  devices: "PC・スマホ表示",
  links: "リンク・フォーム・外部読み込み",
  continuity: "元サイトからの引き継ぎ",
};

/**
 * check.py の errors[].check を項目へ振り分ける。指定の分類（会社＝fact_verification、リンク＝リンク・form・外部リソース、
 * 引き継ぎ＝content_parity・feature_parity・parity_review、表示＝quality_review）に加え、
 * 残りの分類も意味の近い項目へ入れる（全体の判定は check.py の ok を使うため、どの項目にも出ない不合格を作らない）。
 * ここにない分類は company に「分類外」として入れる。
 */
export const CHECK_GROUPS: Record<PrecheckItemKey, readonly string[]> = {
  company: ["fact_verification", "content_plan", "internal_annotation", "demo_notice", "rebuild_json", "admin_schema"],
  devices: [
    "quality_review",
    "quality_artifact",
    "design_brief",
    "viewport",
    "lang",
    "title",
    "description",
    "img_alt",
    "role_img_label",
    "h1_count",
    "parse_error",
  ],
  links: ["broken_link", "root_absolute_path", "external_resource", "form", "tracking", "navigation", "index"],
  continuity: ["content_parity", "feature_parity", "parity_review"],
};

const MAX_DETAILS = 30;

export interface PythonResult {
  /** 終了コード。起動できない・時間切れは null */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 起動できなかった理由（python3 がない等） */
  spawnError?: string;
}
export type PythonRunner = (script: string, args: string[]) => Promise<PythonResult>;

/**
 * python3 -E -s（環境変数・ユーザーの site-packages を読まない）で動かす。
 * -I は使わない：検査スクリプトは同じディレクトリの check_mobile_quality を import するため、
 * スクリプトの場所（リポジトリ内の信頼できる .agents/skills）だけは import の対象にする。作業ディレクトリは一時ディレクトリにする
 */
export const runPython: PythonRunner = (script, args) =>
  new Promise((resolve) => {
    execFile(
      "python3",
      ["-E", "-s", script, ...args],
      {
        cwd: os.tmpdir(),
        timeout: 120_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C.UTF-8", LANG: "C.UTF-8" },
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        const code = (error as { code?: unknown }).code;
        if (typeof code === "number") return resolve({ code, stdout, stderr });
        resolve({ code: null, stdout, stderr, spawnError: error.message.slice(0, 300) });
      },
    );
  });

/** 検査スクリプトを動かせない（スクリプト・python3 がない、出力が読めない）。サイトの不合格とは区別する */
export class PrecheckUnavailableError extends Error {}

export interface PrecheckInput {
  repoRoot: string;
  /** 改善後サイトの実体（resolveImprovementSiteDir の結果） */
  siteDir: string;
  company: { officialSiteStatus: string; suppression: string };
  now: Date;
  python?: PythonRunner;
}

export function precheckScripts(repoRoot: string) {
  const dir = path.join(repoRoot, ".agents/skills/site-rebuild/scripts");
  return { checkPy: path.join(dir, "check.py"), mobilePy: path.join(dir, "check_mobile_quality.py") };
}

function sha256(data: string | Buffer) {
  return createHash("sha256").update(data).digest("hex");
}

/** site/ 配下のファイルのハッシュ。リンクは辿らず、名前とリンク先の文字列だけを含める */
export async function siteDigest(root: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (rel: string) => {
    const entries = await readdir(path.join(root, rel), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) lines.push(`F ${p} ${sha256(await readFile(path.join(root, p)))}`);
      else lines.push(`O ${p}`);
    }
  };
  await walk("");
  return `sha256:${sha256(lines.join("\n"))}`;
}

type CheckError = { file?: unknown; line?: unknown; check?: unknown; message?: unknown };

function parseOutput(name: string, r: PythonResult): { ok: boolean; errors: unknown[] } {
  if (r.spawnError || r.code === null)
    throw new PrecheckUnavailableError(`${name} を実行できません：${r.spawnError ?? "時間切れ"}`);
  if (r.code !== 0 && r.code !== 1)
    throw new PrecheckUnavailableError(`${name} が異常終了しました（終了コード ${r.code}）`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new PrecheckUnavailableError(`${name} の出力をJSONとして読めません`);
  }
  const o = parsed as { ok?: unknown; errors?: unknown };
  if (typeof o?.ok !== "boolean" || !Array.isArray(o.errors))
    throw new PrecheckUnavailableError(`${name} の出力に ok・errors がありません`);
  // 終了コードと ok が食い違う出力は信用しない
  if (o.ok !== (r.code === 0)) throw new PrecheckUnavailableError(`${name} の終了コードと ok が一致しません`);
  return { ok: o.ok, errors: o.errors };
}

function describe(e: CheckError) {
  const where = typeof e.file === "string" ? `${e.file}${typeof e.line === "number" ? `:${e.line}` : ""} ` : "";
  const check = typeof e.check === "string" ? `[${e.check}] ` : "";
  return `${where}${check}${String(e.message ?? "")}`.slice(0, 300);
}

function limit(details: string[]) {
  const clipped = details.map((d) => d.slice(0, 4000));
  return clipped.length > MAX_DETAILS
    ? [...clipped.slice(0, MAX_DETAILS), `ほか${clipped.length - MAX_DETAILS}件`]
    : clipped;
}

async function readSiteJson(siteDir: string, name: string): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await readFile(path.join(siteDir, name), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * 事前チェックを行う。検査スクリプトを動かせないときは PrecheckUnavailableError を投げる（不合格として保存しない）。
 */
export async function runProposalPrecheck(input: PrecheckInput): Promise<ProposalAiCheck> {
  const python = input.python ?? runPython;
  const { checkPy, mobilePy } = precheckScripts(input.repoRoot);
  let checkerHash: string;
  try {
    checkerHash = sha256(await readFile(checkPy));
    await readFile(mobilePy);
  } catch {
    throw new PrecheckUnavailableError(`検査スクリプトがありません：${path.relative(input.repoRoot, checkPy)}`);
  }
  const digest = await siteDigest(input.siteDir);
  const [checkRaw, mobileRaw] = await Promise.all([
    python(checkPy, [input.siteDir]),
    python(mobilePy, [input.siteDir]),
  ]);
  const check = parseOutput("check.py", checkRaw);
  const mobile = parseOutput("check_mobile_quality.py", mobileRaw);

  const grouped: Record<PrecheckItemKey, string[]> = { company: [], devices: [], links: [], continuity: [] };
  for (const raw of check.errors) {
    const e = (raw && typeof raw === "object" ? raw : { message: String(raw) }) as CheckError;
    const key = (Object.keys(CHECK_GROUPS) as PrecheckItemKey[]).find((k) =>
      CHECK_GROUPS[k].includes(String(e.check ?? "")),
    );
    if (key) grouped[key].push(`check.py ${describe(e)}`);
    else grouped.company.push(`check.py（分類外） ${describe(e)}`);
  }

  // 会社情報：事実確認の完了・公式サイトの確認・営業抑止
  const plan = await readSiteJson(input.siteDir, "content-plan.json");
  const review = (plan?.review ?? null) as Record<string, unknown> | null;
  if (review?.facts_verified !== true)
    grouped.company.push("content-plan.json の review.facts_verified が true ではありません");
  if (input.company.officialSiteStatus !== "confirmed")
    grouped.company.push(`公式サイトが確認済みではありません（${input.company.officialSiteStatus}）`);
  if (input.company.suppression !== "none")
    grouped.company.push(`営業抑止が設定されています（${input.company.suppression}）`);

  // PC・スマホ表示：品質レビューの点数・致命項目・確認した幅と、スマホ実画面の証跡
  const qr = await readSiteJson(input.siteDir, "quality-review.json");
  const scores = (qr?.scores ?? null) as Record<string, unknown> | null;
  const total = qr?.total;
  const mobileScore = scores?.mobile;
  const widths = Array.isArray(qr?.viewports)
    ? (qr.viewports as unknown[]).map((v) => (v && typeof v === "object" ? (v as { width?: unknown }).width : null))
    : [];
  if (!qr) grouped.devices.push("quality-review.json がないか、読めません");
  else {
    if (qr.status !== "pass") grouped.devices.push(`品質レビューが合格（pass）ではありません（${String(qr.status)}）`);
    if (!isNum(total) || total < QUALITY_PASS_TOTAL)
      grouped.devices.push(`品質レビューの総合点が${QUALITY_PASS_TOTAL}点未満です（${String(total)}）`);
    if (!isNum(mobileScore) || mobileScore < MOBILE_PASS_SCORE)
      grouped.devices.push(`スマホ品質が${MOBILE_PASS_SCORE}/15点未満です（${String(mobileScore)}）`);
    if (!Array.isArray(qr.fatal_issues) || qr.fatal_issues.length > 0)
      grouped.devices.push("品質レビューに致命項目（fatal_issues）が残っています");
    if (!widths.some((w) => isNum(w) && w >= PC_MIN_WIDTH)) grouped.devices.push("PC幅の表示レビューがありません");
    if (!widths.some((w) => isNum(w) && w <= MOBILE_MAX_WIDTH))
      grouped.devices.push("スマホ幅の表示レビューがありません");
  }
  for (const m of mobile.errors) grouped.devices.push(`check_mobile_quality.py ${String(m).slice(0, 300)}`);

  const passSummary: Record<PrecheckItemKey, string> = {
    company: "掲載した会社情報は確認済みの事実と一致し、公式サイト確認済み・営業抑止なしです",
    devices: `PC・スマホの表示レビューは合格です（総合${String(total)}点、スマホ${String(mobileScore)}/15点）`,
    links: "リンク切れ・フォーム・外部読み込みの問題はありません",
    continuity: "元サイトの情報・機能の引き継ぎに漏れはありません",
  };
  const items: PrecheckItem[] = (Object.keys(grouped) as PrecheckItemKey[]).map((key) => {
    const details = grouped[key];
    const ok = details.length === 0;
    return {
      key,
      ok,
      summary: ok ? passSummary[key] : `${PRECHECK_ITEM_LABEL[key]}に${details.length}件の問題があります`,
      details: limit(details),
    };
  });
  // 運営画面と同じスキーマで検証してから返す（形が崩れた結果は画面で「未実施」扱いになり承認できないため）
  return proposalPrecheckSchema.parse({
    status: check.ok && mobile.ok && items.every((i) => i.ok) ? "passed" : "failed",
    checkedAt: input.now.toISOString(),
    checker: { checkPy: checkerHash },
    siteDigest: digest,
    items,
  });
}

/** 監査記録・実行結果に入れる要約（詳細は版の content.aiCheck にある） */
export function summarizeAiCheck(c: ProposalAiCheck) {
  return {
    status: c.status,
    checkedAt: c.checkedAt,
    checkPy: c.checker.checkPy,
    siteDigest: c.siteDigest,
    failedItems: c.items.filter((i) => !i.ok).map((i) => i.key),
  };
}

export function precheckFailureMessage(c: ProposalAiCheck) {
  const failed = c.items.filter((i) => !i.ok).map((i) => PRECHECK_ITEM_LABEL[i.key]);
  return failed.length
    ? `AIの事前チェックに不合格：${failed.join("、")}`
    : "AIの事前チェックに不合格：検査スクリプト（check.py）の判定が不合格";
}
