import { err, ok, type Result } from "@siteoffer/core";
import type { Json } from "./collect.ts";
import { ITEM_IDS } from "./items.ts";

export interface Observation {
  fact: string;
  url?: string;
  evidence?: string;
}

export interface EvaluationItem {
  id: string;
  status: "scored" | "unevaluable" | "not_applicable";
  level?: number;
  observations?: Observation[];
  reason?: string;
  inference?: boolean;
  improvement_hint?: string;
}

export interface CriticalFlag {
  id: string;
  item?: string;
  fact?: string;
}

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * 生成器の出力を、アプリが管理する値で上書きして evaluation.json の形にそろえる。
 * 対象URL・取得日時は collect.py の取得結果を正とし（AC-05）、生成器に書き換えさせない。
 * summary は score.py が書くので空にする。
 */
export function prepareEvaluation(
  raw: unknown,
  ctx: { collected: Json; evaluatedAt: Date; model: string | null; rubricVersion: string },
): Result<Json, "invalid_evaluation"> {
  if (!isObj(raw)) return err("invalid_evaluation", "evaluation がオブジェクトでない");
  if (!Array.isArray(raw.items)) return err("invalid_evaluation", "evaluation.items が配列でない");
  const ev: Json = {};
  for (const [k, v] of Object.entries(raw)) if (!k.startsWith("_")) ev[k] = v;
  const site = isObj(ctx.collected.site) ? ctx.collected.site : {};
  ev.schema_version = typeof ev.schema_version === "string" ? ev.schema_version : "0.1";
  ev.rubric_version = ctx.rubricVersion;
  ev.status = ev.status === "unevaluable" ? "unevaluable" : "evaluated";
  ev.target_url = ctx.collected.target_url;
  ev.final_url = typeof site.final_url === "string" ? site.final_url : (ev.final_url ?? null);
  ev.collected_at = ctx.collected.collected_at;
  ev.evaluated_at = ctx.evaluatedAt.toISOString();
  ev.evaluator = { skill: "site-evaluation", model: ctx.model ?? "不明" };
  if (!Array.isArray(ev.critical_flags)) ev.critical_flags = [];
  ev.summary = {};
  return ok(ev);
}

/**
 * 根拠の検証（保存前の防御）。score.py の検証（scored なら observations が空でない）に加え、
 * 各 observation に観測事実（fact）があることを確かめる。満たさなければ監査全体を保存しない。
 */
export function checkEvidence(items: unknown): Result<EvaluationItem[], "missing_evidence"> {
  if (!Array.isArray(items)) return err("missing_evidence", "items が配列でない");
  const problems: string[] = [];
  for (const it of items) {
    if (!isObj(it)) {
      problems.push("項目がオブジェクトでない");
      continue;
    }
    if (it.status !== "scored") continue;
    const obs = it.observations;
    if (!Array.isArray(obs) || obs.length === 0) {
      problems.push(`${String(it.id)}: scored なのに observations（根拠）がない`);
    } else if (!obs.every((o) => isObj(o) && typeof o.fact === "string" && o.fact.trim() !== "")) {
      problems.push(`${String(it.id)}: observations に観測事実（fact）のないものがある`);
    }
  }
  if (problems.length) return err("missing_evidence", problems.join("\n"));
  return ok(items as EvaluationItem[]);
}

/** サイトを確認できなかったときの evaluation.json（output-format.md：全項目 unevaluable・fatal_reason） */
export function unevaluableEvaluation(ctx: {
  targetUrl: string;
  collectedAt: unknown;
  reason: string;
  evaluatedAt: Date;
  rubricVersion: string;
}): Json {
  return {
    schema_version: "0.1",
    rubric_version: ctx.rubricVersion,
    status: "unevaluable",
    target_url: ctx.targetUrl,
    final_url: null,
    collected_at: typeof ctx.collectedAt === "string" ? ctx.collectedAt : null,
    evaluated_at: ctx.evaluatedAt.toISOString(),
    evaluator: { skill: "site-evaluation", model: "不明" },
    fatal_reason: ctx.reason,
    items: ITEM_IDS.map((id) => ({ id, status: "unevaluable", reason: ctx.reason })),
    critical_flags: [],
    summary: {},
  };
}
