#!/usr/bin/env python3
"""評価結果と設定から、改善提案書を作るかを判定する。

出力（標準出力・JSON）:
  decision: "create" | "skip" | "pending"
  reasons:  判定理由の配列

使い方:
  python3 decide.py reports/sites/<domain>/<date>/evaluation.json \
      [--config config/site-evaluation.json] [--threshold 60]

--threshold はユーザーがその場で明示した値だけを渡す。設定の値より優先し、判定結果に記録する。
"""
import argparse
import json
import os
from pathlib import Path
import sys


# 収集・採点と同じ定義を使う。skill一式をsandboxへコピーした場合も相対配置で解決する。
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "site-evaluation" / "scripts"))
from score import calculate, number  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("evaluation")
    ap.add_argument("--config", default="config/site-evaluation.json")
    ap.add_argument("--threshold", type=float)
    a = ap.parse_args()

    with open(a.evaluation, encoding="utf-8") as f:
        ev = json.load(f)
    cfg = {}
    if os.path.exists(a.config):
        with open(a.config, encoding="utf-8") as f:
            cfg = json.load(f)

    raw_proposal = cfg.get("proposal", {}) if isinstance(cfg, dict) else {}
    proposal = raw_proposal if isinstance(raw_proposal, dict) else {}
    raw_summary = ev.get("summary") if isinstance(ev, dict) else None
    s = raw_summary if isinstance(raw_summary, dict) else {}
    threshold = a.threshold if a.threshold is not None else proposal.get("threshold")
    source = "user_override" if a.threshold is not None else "config"
    crit_trigger = proposal.get("critical_flags_trigger")
    crit = []
    out = {"evaluation": a.evaluation, "total_score": s.get("total_score") if number(s.get("total_score")) else None,
           "coverage": s.get("coverage") if number(s.get("coverage")) else None,
           "threshold": threshold if number(threshold) else None, "threshold_source": source,
           "critical_flags": crit, "critical_flags_trigger": crit_trigger, "reasons": []}

    def done(decision, reason):
        out["decision"] = decision
        out["reasons"].append(reason)
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    if not isinstance(raw_proposal, dict):
        return done("pending", "proposal 設定はオブジェクトが必要")
    if threshold is not None and (not number(threshold) or not 0 <= threshold <= 100):
        return done("pending", "閾値は0〜100の有限数が必要")
    if crit_trigger is not None and type(crit_trigger) is not bool:
        return done("pending", "critical_flags_trigger は true・false・null のいずれかが必要")
    try:
        expected, flags = calculate(ev, cfg)
    except ValueError as e:
        return done("pending", f"評価の検証エラー。score.py で修正・再計算する: {e}")
    crit = [c["id"] for c in flags]
    out["critical_flags"] = crit
    if ev.get("status") == "unevaluable":
        return done("pending", "サイトを評価できていない（評価不能）。低評価として扱わない")
    if not s:
        return done("pending", "summary がない。site-evaluation の score.py を先に実行する")
    try:
        summary_matches = json.dumps(s, sort_keys=True, allow_nan=False) == json.dumps(expected, sort_keys=True)
    except (TypeError, ValueError):
        summary_matches = False
    if not summary_matches or ev.get("critical_flags", []) != flags:
        return done("pending", "summary または致命項目が現在の評価・配点設定と一致しない。score.py を再実行する")
    if not expected["score_confirmed"]:
        return done("pending", f"カバー率 {s.get('coverage')} が最小値 {s.get('min_coverage')} 未満で、総合点が確定していない")

    if crit and crit_trigger is True:
        return done("create", f"致命項目 {crit} があり、設定で致命項目による作成が有効")

    if threshold is None:
        reason = "提案書作成の閾値が未設定（config/site-evaluation.json の proposal.threshold が null）"
        if crit:
            reason += f"。致命項目 {crit} あり（致命項目による作成は無効または未決）"
        return done("pending", reason)

    total = s["total_score"]
    if total < threshold:
        return done("create", f"総合点 {total} が閾値 {threshold} 未満")
    reason = f"総合点 {total} が閾値 {threshold} 以上"
    if crit:
        reason += f"。ただし致命項目 {crit} あり（致命項目による作成は無効または未決）"
    return done("skip", reason)


if __name__ == "__main__":
    sys.exit(main())
