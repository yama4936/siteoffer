#!/usr/bin/env python3
"""evaluation.json の項目レベルから総合点・カテゴリ点・カバー率を計算し、summary に書き戻す。

使い方:
  python3 score.py reports/sites/<domain>/<date>/evaluation.json [--config config/site-evaluation.json]

配点は references/rubric.md と一致させる。カテゴリの重みが設定で変更された場合は、
カテゴリ内の配点比を保ったまま拡大・縮小する。
"""
import argparse
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
    weights = {k: v for k, v in cfg.get("category_weights", {}).items() if not k.startswith("_")}
    min_cov = cfg.get("proposal", {}).get("min_coverage", 0.7)
    pts = item_points(weights)

    def write(e):
        with open(a.evaluation, "w", encoding="utf-8") as f:
            json.dump(e, f, ensure_ascii=False, indent=2)

    if ev.get("status") == "unevaluable":
        ev["summary"] = {"total_score": None, "score_confirmed": False, "coverage": 0.0,
                         "min_coverage": min_cov, "reason": ev.get("fatal_reason", "評価不能")}
        write(ev)
        print("評価不能：総合点なし（低評価として扱わない）")
        return 0

    errors = []
    items = {it.get("id"): it for it in ev.get("items", [])}
    for i in ITEMS:
        if i not in items:
            errors.append(f"{i}: 項目がない（評価できない場合も status=unevaluable で記録する）")
    for i, it in items.items():
        if i not in ITEMS:
            errors.append(f"{i}: 未定義の項目ID")
            continue
        st = it.get("status")
        if st not in STATUSES:
            errors.append(f"{i}: status が不正 ({st})")
        if st == "scored":
            if it.get("level") not in (0, 1, 2, 3):
                errors.append(f"{i}: scored なのに level が 0〜3 でない")
            if not it.get("observations"):
                errors.append(f"{i}: scored なのに observations（根拠）がない")
        if st in ("not_applicable", "unevaluable") and not it.get("reason"):
            errors.append(f"{i}: {st} の理由（reason）がない")
    if errors:
        # 古い summary が残ると、修正前の点数で提案書の判定が進んでしまうため消す
        ev["summary"] = None
        write(ev)
        print("検証エラー:\n- " + "\n- ".join(errors), file=sys.stderr)
        return 1

    by_cat, earned, possible, applicable = {}, 0.0, 0.0, 0.0
    for c, (key, label) in CATEGORIES.items():
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
    crit = [{"id": CRITICAL[i], "item": i} for i in CRITICAL
            if items[i]["status"] == "scored" and items[i]["level"] == 0]
    # 手で記録された致命項目の根拠は残し、IDの重複だけ除く
    existing = {c.get("id"): c for c in ev.get("critical_flags", [])}
    for c in crit:
        existing.setdefault(c["id"], c)

    ev["critical_flags"] = list(existing.values())
    ev["summary"] = {
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
    write(ev)

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
