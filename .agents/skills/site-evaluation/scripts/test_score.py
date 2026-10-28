#!/usr/bin/env python3
"""採点と提案判定の再実行・入力整合を、外部通信なしで検証する。"""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
import score  # noqa: E402

DECIDE = Path(__file__).resolve().parents[2] / "site-proposal/scripts/decide.py"
CONFIG = {"rubric_version": "0.1", "proposal": {
    "threshold": 70, "critical_flags_trigger": True, "min_coverage": 0.7}}


def evaluation():
    return {"status": "evaluated", "items": [
        {"id": item, "status": "scored", "level": 3, "observations": [
            {"fact": "確認済みの事実", "url": "https://example.com/", "evidence": "本文の見出し"}]}
        for item in score.ITEMS], "critical_flags": []}


def scored(ev, cfg=CONFIG):
    ev = copy.deepcopy(ev)
    ev["summary"], ev["critical_flags"] = score.calculate(ev, cfg)
    return ev


class ScoreTest(unittest.TestCase):
    def test_recalculation_removes_resolved_or_unevaluable_flags(self):
        ev = evaluation()
        ev["items"][0]["level"] = 0
        ev["critical_flags"] = [{"id": "CF-NO-CONTACT", "item": "A1", "fact": "窓口がない"}]
        first = scored(ev)
        self.assertEqual(first["critical_flags"], ev["critical_flags"])
        self.assertEqual(scored(first), first)
        for status in ("scored", "unevaluable", "not_applicable"):
            updated = copy.deepcopy(first)
            updated["items"][0].update(status=status, level=3, reason="確認対象が変わった")
            self.assertEqual(scored(updated)["critical_flags"], [])

    def test_all_good_is_100_and_unknown_old_flag_is_removed(self):
        ev = evaluation()
        ev["critical_flags"] = [{"id": "CF-BROKEN", "item": "E2"}, {"id": "invented"}]
        out = scored(ev)
        self.assertEqual(out["summary"]["total_score"], 100)
        self.assertEqual(out["critical_flags"], [])

    def test_duplicate_boolean_fraction_and_empty_evidence_are_rejected(self):
        for case in ("duplicate", "boolean", "fraction", "empty", "string", "missing_fact"):
            with self.subTest(case=case):
                ev = evaluation()
                if case == "duplicate":
                    ev["items"].append(copy.deepcopy(ev["items"][0]))
                elif case == "boolean":
                    ev["items"][0]["level"] = True
                elif case == "fraction":
                    ev["items"][0]["level"] = 1.0
                elif case == "empty":
                    ev["items"][0]["observations"] = [{}]
                elif case == "string":
                    ev["items"][0]["observations"] = "根拠ではない"
                else:
                    ev["items"][0]["observations"][0]["fact"] = "   "
                with self.assertRaises(ValueError):
                    score.calculate(ev, CONFIG)

    def test_invalid_config_and_item_shapes_are_rejected(self):
        for cfg in ({"proposal": {"min_coverage": True}}, {"proposal": {"min_coverage": float("nan")}},
                    {"category_weights": {"A_conversion": -1}}, {"category_weights": {"typo": 1}}):
            with self.subTest(cfg=cfg), self.assertRaises(ValueError):
                score.calculate(evaluation(), cfg)
        for items in (None, {}, [None], [{"id": []}]):
            ev = evaluation()
            ev["items"] = items
            with self.subTest(items=items), self.assertRaises(ValueError):
                score.calculate(ev, CONFIG)

    def test_coverage_and_not_applicable_have_different_denominators(self):
        ev = evaluation()
        ev["items"][0].update(status="unevaluable", reason="取得不可")
        ev["items"][1].update(status="not_applicable", reason="該当しない")
        summary, _ = score.calculate(ev, CONFIG)
        self.assertEqual(summary["total_score"], 100)
        self.assertEqual(summary["coverage"], round(89 / 95, 3))
        self.assertEqual(summary["unevaluable_items"], ["A1"])
        self.assertEqual(summary["not_applicable_items"], ["A2"])

    def test_cli_failure_clears_previous_summary_and_flags(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "evaluation.json"
            ev = scored(evaluation())
            ev["items"] = []
            ev["critical_flags"] = [{"id": "CF-BROKEN", "item": "E2"}]
            path.write_text(json.dumps(ev), encoding="utf-8")
            result = subprocess.run([sys.executable, str(Path(score.__file__)), str(path)], capture_output=True)
            self.assertEqual(result.returncode, 1)
            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertIsNone(saved["summary"])
            self.assertEqual(saved["critical_flags"], [])

    def test_unhashable_input_shapes_clear_old_results(self):
        for field in ("item_status", "critical_id"):
            for invalid in ([], {}):
                with self.subTest(field=field, invalid=invalid), tempfile.TemporaryDirectory() as tmp:
                    ev = scored(evaluation())
                    if field == "item_status":
                        ev["items"][0]["status"] = invalid
                    else:
                        ev["critical_flags"] = [{"id": invalid}]
                    path = Path(tmp) / "evaluation.json"
                    path.write_text(json.dumps(ev), encoding="utf-8")
                    result = subprocess.run([sys.executable, score.__file__, str(path)],
                                            text=True, capture_output=True)
                    self.assertEqual(result.returncode, 1)
                    self.assertNotIn("Traceback", result.stderr)
                    saved = json.loads(path.read_text(encoding="utf-8"))
                    self.assertIsNone(saved["summary"])
                    self.assertEqual(saved["critical_flags"], [])

    def test_unevaluable_clears_old_critical_flags(self):
        summary, flags = score.calculate({"status": "unevaluable", "critical_flags": [{"id": "CF-BROKEN"}]}, CONFIG)
        self.assertFalse(summary["score_confirmed"])
        self.assertIsNone(summary["total_score"])
        self.assertEqual(flags, [])


class DecideTest(unittest.TestCase):
    def decide(self, ev, cfg=CONFIG, extra=()):
        with tempfile.TemporaryDirectory() as tmp:
            path, config = Path(tmp) / "evaluation.json", Path(tmp) / "config.json"
            path.write_text(json.dumps(ev), encoding="utf-8")
            config.write_text(json.dumps(cfg), encoding="utf-8")
            before = path.read_bytes()
            result = subprocess.run([sys.executable, str(DECIDE), str(path), "--config", str(config), *extra],
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(path.read_bytes(), before, "判定は評価ファイルを書き換えない")
            return json.loads(result.stdout)

    def test_current_recalculated_results_keep_threshold_and_critical_behavior(self):
        self.assertEqual(self.decide(scored(evaluation()))["decision"], "skip")
        ev = evaluation()
        ev["items"][0]["level"] = 0
        self.assertEqual(self.decide(scored(ev))["decision"], "create")
        ev = evaluation()
        for item in ev["items"]:
            item["level"] = 1
        self.assertEqual(self.decide(scored(ev))["decision"], "create")

    def test_stale_summary_or_changed_evidence_is_pending(self):
        for case in ("items", "score", "evidence", "date", "flags", "boolean"):
            with self.subTest(case=case):
                ev = scored(evaluation())
                if case == "items":
                    ev["items"] = []
                elif case == "score":
                    ev["summary"]["total_score"] = 0
                elif case == "evidence":
                    ev["items"][0]["observations"][0]["fact"] = "後から書き換えた"
                elif case == "date":
                    ev["collected_at"] = "2026-10-28T10:00:00+09:00"
                elif case == "flags":
                    ev["critical_flags"] = [{"id": "CF-BROKEN", "item": "E2"}]
                else:
                    ev["summary"]["coverage"] = True
                self.assertEqual(self.decide(ev)["decision"], "pending")

    def test_malformed_input_shapes_are_pending(self):
        for field in ("item_status", "critical_id"):
            for invalid in ([], {}):
                with self.subTest(field=field, invalid=invalid):
                    ev = scored(evaluation())
                    if field == "item_status":
                        ev["items"][0]["status"] = invalid
                    else:
                        ev["critical_flags"] = [{"id": invalid}]
                    self.assertEqual(self.decide(ev)["decision"], "pending")

    def test_changed_weights_or_minimum_coverage_requires_recalculation(self):
        ev = scored(evaluation())
        for key in ("weights", "coverage"):
            cfg = copy.deepcopy(CONFIG)
            if key == "weights":
                cfg["category_weights"] = {"A_conversion": 30}
            else:
                cfg["proposal"]["min_coverage"] = 1
            self.assertEqual(self.decide(ev, cfg)["decision"], "pending")
            self.assertEqual(self.decide(scored(ev, cfg), cfg)["decision"], "skip")

    def test_invalid_thresholds_and_trigger_are_pending(self):
        for threshold in (-1, 101, True, "70", float("inf")):
            cfg = copy.deepcopy(CONFIG)
            cfg["proposal"]["threshold"] = threshold
            self.assertEqual(self.decide(scored(evaluation()), cfg)["decision"], "pending")
        cfg = copy.deepcopy(CONFIG)
        cfg["proposal"]["critical_flags_trigger"] = "true"
        self.assertEqual(self.decide(scored(evaluation()), cfg)["decision"], "pending")
        self.assertEqual(self.decide(scored(evaluation()), extra=("--threshold", "nan"))["decision"], "pending")

    def test_low_coverage_and_unevaluable_cannot_trigger_creation(self):
        ev = evaluation()
        for item in ev["items"]:
            item.update(status="unevaluable", reason="取得失敗")
        ev["items"][0].update(status="scored", level=0)
        self.assertEqual(self.decide(scored(ev))["decision"], "pending")
        self.assertEqual(self.decide({"status": "unevaluable"})["decision"], "pending")

    def test_threshold_unset_override_and_equal_boundary(self):
        cfg = copy.deepcopy(CONFIG)
        cfg["proposal"]["threshold"] = None
        ev = scored(evaluation(), cfg)
        self.assertEqual(self.decide(ev, cfg)["decision"], "pending")
        out = self.decide(ev, cfg, ("--threshold", "100"))
        self.assertEqual(out["decision"], "skip")
        self.assertEqual(out["threshold_source"], "user_override")


if __name__ == "__main__":
    unittest.main()
