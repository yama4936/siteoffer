#!/usr/bin/env python3
"""evaluation.json の項目レベルから総合点・カテゴリ点・カバー率を計算し、summary に書き戻す。

使い方:
  python3 score.py reports/sites/<domain>/<date>/evaluation.json [--config config/site-evaluation.json]

配点は references/rubric.md と一致させる。カテゴリの重みが設定で変更された場合は、
カテゴリ内の配点比を保ったまま拡大・縮小する。
"""
import argparse
import hashlib
import math
import json
import os
import sys

CATEGORIES = {
    "A": ("A_conversion", "問い合わせ導線"),
    "B": ("B_clarity", "情報の明確さ"),
    "C": ("C_trust", "信頼性"),
    "D": ("D_mobile", "スマホ対応"),
    "E": ("E_performance", "表示速度・技術品質"),
    "F": ("F_seo", "技術的SEO"),
    "G": ("G_accessibility", "アクセシビリティ"),
}
ITEMS = {
    "A1": (6, "問い合わせ手段の見つけやすさ"), "A2": (5, "スマホからの連絡しやすさ"),
    "A3": (5, "行動を促す文言・配置"), "A4": (4, "問い合わせフォームの負担"),
    "B1": (7, "ファーストビューの伝達力"), "B2": (7, "サービス内容の具体性"),
    "B3": (6, "判断材料（料金・流れ・FAQ・強み）"),
    "C1": (4, "会社情報"), "C2": (5, "実績・事例・お客様の声"), "C3": (3, "更新性"), "C4": (3, "HTTPS"),
    "D1": (8, "viewport・レスポンシブ"), "D2": (7, "スマホでの読みやすさ・操作性"),
    "E1": (6, "表示速度"), "E2": (4, "エラー・古い技術"),
    "F1": (3, "title・description"), "F2": (2, "見出し構造"), "F3": (3, "インデックス・クロール"),
    "F4": (2, "構造化データ・SNS表示"),
    "G1": (3, "画像の代替テキスト"), "G2": (3, "言語指定・フォームのラベル"), "G3": (4, "視認性"),
}
CRITICAL = {"A1": "CF-NO-CONTACT", "C4": "CF-NO-HTTPS", "D1": "CF-NOT-MOBILE",
            "C3": "CF-STALE", "E2": "CF-BROKEN", "F3": "CF-NOINDEX"}
STATUSES = {"scored", "not_applicable", "unevaluable"}


def item_points(cfg_weights):
    """設定のカテゴリ重みに合わせて各項目の配点を返す。"""
    pts = {}
    for c, (key, _) in CATEGORIES.items():
        ids = [i for i in ITEMS if i[0] == c]
        base = sum(ITEMS[i][0] for i in ids)
        w = cfg_weights.get(key, base) if cfg_weights else base
        for i in ids:
            pts[i] = ITEMS[i][0] * w / base
    return pts


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def calculate(ev, cfg):
    """入力を検証して再計算する。ファイルは変更せず、判定側も同じ計算を使う。"""
    errors = []
    if not isinstance(ev, dict) or ev.get("status") not in ("evaluated", "unevaluable"):
        raise ValueError("status は evaluated または unevaluable が必要")
    if not isinstance(cfg, dict):
        raise ValueError("設定はオブジェクトが必要")
    proposal = cfg.get("proposal", {})
    if not isinstance(proposal, dict):
        raise ValueError("proposal 設定はオブジェクトが必要")
    min_cov = proposal.get("min_coverage", 0.7)
    if not number(min_cov) or not 0 <= min_cov <= 1:
        errors.append("min_coverage は0〜1の有限数が必要")
    raw_weights = cfg.get("category_weights", {})
    if not isinstance(raw_weights, dict):
        raise ValueError("category_weights はオブジェクトが必要")
    weights = {k: v for k, v in raw_weights.items() if not k.startswith("_")}
    keys = {key for key, _ in CATEGORIES.values()}
    for key, value in weights.items():
        if key not in keys or not number(value) or value < 0:
            errors.append(f"category_weights.{key}: 定義済みカテゴリの0以上の有限数が必要")
    if errors:
        raise ValueError("\n- ".join(errors))
    pts = item_points(weights)
    if sum(pts.values()) <= 0:
        raise ValueError("カテゴリ配点の合計は0より大きい値が必要")
    if ev["status"] == "unevaluable":
        return ({"total_score": None, "score_confirmed": False, "coverage": 0.0,
                 "min_coverage": min_cov, "reason": ev.get("fatal_reason") or "評価不能"}, [])

    raw_items = ev.get("items")
    if not isinstance(raw_items, list):
        raise ValueError("items は全22項目の配列が必要")
    items = {}
    for pos, it in enumerate(raw_items):
        if not isinstance(it, dict) or not isinstance(it.get("id"), str):
            errors.append(f"items[{pos}]: id を持つオブジェクトが必要")
            continue
        i = it["id"]
        if i in items:
            errors.append(f"{i}: 項目IDが重複")
        items[i] = it
        if i not in ITEMS:
            errors.append(f"{i}: 未定義の項目ID")
            continue
        st = it.get("status")
        if not isinstance(st, str) or st not in STATUSES:
            errors.append(f"{i}: status が不正 ({st})")
        if st == "scored":
            if type(it.get("level")) is not int or it["level"] not in (0, 1, 2, 3):
                errors.append(f"{i}: scored の level は0〜3の整数が必要（真偽値不可）")
            obs = it.get("observations")
            if not isinstance(obs, list) or not obs:
                errors.append(f"{i}: scored なのに observations（根拠の配列）がない")
            else:
                for pos, observation in enumerate(obs):
                    if not isinstance(observation, dict) or not all(
                            nonempty(observation.get(k)) for k in ("fact", "url", "evidence")):
                        errors.append(f"{i}: observations[{pos}] に空でない fact・url・evidence が必要")
        if st in ("not_applicable", "unevaluable") and not nonempty(it.get("reason")):
            errors.append(f"{i}: {st} の理由（reason）がない")
    for i in ITEMS:
        if i not in items:
            errors.append(f"{i}: 項目がない（評価できない場合も status=unevaluable で記録する）")
    if errors:
        raise ValueError("\n- ".join(errors))

    by_cat, earned, possible, applicable = {}, 0.0, 0.0, 0.0
    for c, (_, label) in CATEGORIES.items():
        ce = cp = ca = 0.0
        for i in [i for i in ITEMS if i[0] == c]:
            it, p = items[i], pts[i]
            if it["status"] == "not_applicable":
                continue
            ca += p
            if it["status"] == "scored":
                cp += p
                ce += p * it["level"] / 3
        by_cat[c] = {"label": label, "earned": round(ce, 1), "possible": round(cp, 1),
                     "weight": round(ca, 1), "rate": round(ce / cp, 3) if cp else None}
        earned, possible, applicable = earned + ce, possible + cp, applicable + ca

    coverage = possible / applicable if applicable else 0.0
    total = round(earned / possible * 100, 1) if possible else None
    # 現在も level=0 の項目だけを残す。修正済みの過去フラグでは提案を発火させない。
    raw_flags = ev.get("critical_flags", [])
    if not isinstance(raw_flags, list) or any(
            not isinstance(flag, dict) or not isinstance(flag.get("id"), str) for flag in raw_flags):
        raise ValueError("critical_flags は文字列のidを持つオブジェクトの配列が必要")
    existing = {flag["id"]: flag for flag in raw_flags}
    critical = []
    for i, flag_id in CRITICAL.items():
        if items[i]["status"] == "scored" and items[i]["level"] == 0:
            old = existing.get(flag_id, {})
            flag = {"id": flag_id, "item": i}
            if old.get("item") == i and nonempty(old.get("fact")):
                flag["fact"] = old["fact"]
            critical.append(flag)

    summary = {
        "total_score": total,
        "score_confirmed": total is not None and coverage >= min_cov,
        "coverage": round(coverage, 3),
        "min_coverage": min_cov,
        "earned_points": round(earned, 1),
        "evaluated_points": round(possible, 1),
        "by_category": by_cat,
        "unevaluable_items": [i for i in ITEMS if items[i]["status"] == "unevaluable"],
        "not_applicable_items": [i for i in ITEMS if items[i]["status"] == "not_applicable"],
        "rubric_version": cfg.get("rubric_version", "0.1"),
    }
    # 数値が同じでも根拠・取得日時を変更したら、score.py の再実行が必要。
    snapshot = {k: v for k, v in ev.items() if k not in ("summary", "critical_flags")}
    snapshot["critical_flags"] = critical
    payload = {"evaluation": snapshot, "weights": weights, "min_coverage": min_cov,
               "rubric_version": summary["rubric_version"]}
    try:
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as e:
        raise ValueError("評価にJSONで表現できない値が含まれる") from e
    summary["input_digest"] = hashlib.sha256(encoded).hexdigest()
    return summary, critical


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("evaluation")
    ap.add_argument("--config", default="config/site-evaluation.json")
    a = ap.parse_args()
    with open(a.evaluation, encoding="utf-8") as f:
        ev = json.load(f)
    cfg = {}
    if os.path.exists(a.config):
        with open(a.config, encoding="utf-8") as f:
            cfg = json.load(f)

    def write():
        with open(a.evaluation, "w", encoding="utf-8") as f:
            json.dump(ev, f, ensure_ascii=False, indent=2)

    try:
        summary, critical = calculate(ev, cfg)
    except ValueError as e:
        # 古い点数・致命項目で判定を続けない。
        if isinstance(ev, dict):
            ev["summary"] = None
            ev["critical_flags"] = []
            write()
        print(f"検証エラー:\n- {e}", file=sys.stderr)
        return 1
    ev["summary"], ev["critical_flags"] = summary, critical
    write()
    if ev["status"] == "unevaluable":
        print("評価不能：総合点なし（低評価として扱わない）")
        return 0
    by_cat = summary["by_category"]
    total, coverage = summary["total_score"], summary["coverage"]

    # evaluation.md に貼る表
    lines = ["| カテゴリ | 得点 / 採点対象 | 配点 | 達成率 |", "| --- | --- | --- | --- |"]
    for c, d in by_cat.items():
        rate = f"{d['rate'] * 100:.0f}%" if d["rate"] is not None else "評価不能"
        lines.append(f"| {c}. {d['label']} | {d['earned']} / {d['possible']} | {d['weight']} | {rate} |")
    lines.append(f"| **総合** | **{total if total is not None else '評価不能'}** / 100 | | カバー率 {coverage * 100:.0f}% |")
    print("\n".join(lines))
    print("\nscore_confirmed:", ev["summary"]["score_confirmed"],
          "/ critical_flags:", [c["id"] for c in ev["critical_flags"]] or "なし")
    return 0


if __name__ == "__main__":
    sys.exit(main())
