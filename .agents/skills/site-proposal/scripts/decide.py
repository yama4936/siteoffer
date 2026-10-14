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
import sys


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
            cfg = json.load(f).get("proposal", {})

    s = ev.get("summary") or {}
    threshold = a.threshold if a.threshold is not None else cfg.get("threshold")
    source = "user_override" if a.threshold is not None else "config"
    crit_trigger = cfg.get("critical_flags_trigger")
    crit = [c.get("id") for c in ev.get("critical_flags", [])]
    out = {"evaluation": a.evaluation, "total_score": s.get("total_score"),
           "coverage": s.get("coverage"), "threshold": threshold, "threshold_source": source,
           "critical_flags": crit, "critical_flags_trigger": crit_trigger, "reasons": []}

    def done(decision, reason):
        out["decision"] = decision
        out["reasons"].append(reason)
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    if ev.get("status") == "unevaluable":
        return done("pending", "サイトを評価できていない（評価不能）。低評価として扱わない")
    if not s:
        return done("pending", "summary がない。site-evaluation の score.py を先に実行する")
    if not s.get("score_confirmed"):
        return done("pending", f"カバー率 {s.get('coverage')} が最小値 {s.get('min_coverage')} 未満で、総合点が確定していない")

    if crit and crit_trigger is True:
        return done("create", f"致命項目 {crit} があり、設定で致命項目による作成が有効")

    if threshold is None:
        reason = "提案書作成の閾値が未設定（config/site-evaluation.json の proposal.threshold が null）"
        if crit:
            reason += f"。致命項目 {crit} あり（致命項目による作成ルールも未決）"
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
