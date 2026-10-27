#!/usr/bin/env python3
"""site-rebuild の content-plan 検査を回帰テストする。"""

import json
import pathlib
import subprocess
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).with_name("check.py")


class ContentPlanCheckTest(unittest.TestCase):
    def make_site(self, root: pathlib.Path) -> None:
        (root / "index.html").write_text(
            """<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="会社案内"><meta name="robots" content="noindex"><title>会社案内</title></head><body><p>非公式の改善案（デモ）</p><h1>株式会社例の会社案内</h1></body></html>""",
            encoding="utf-8",
        )
        self.write_json(root / "design-brief.json", {
            "audience": "相談先を探す人", "primary_action": "電話する",
            "brand_traits": ["信頼感"], "preserve": ["社名"], "change": ["導線"],
            "visual_direction": {"style": "professional", "hero_layout": "centered",
                                 "section_rhythm": "continuous", "signature_motif": "罫線",
                                 "image_strategy": "none"},
            "content_strategy": "業務から連絡先の順", "avoid": ["根拠のない実績"],
        })
        self.write_json(root / "quality-review.json", {
            "status": "not_run", "scores": {}, "total": 0, "fatal_issues": [], "viewports": [],
        })
        self.write_json(root / "content-plan.json", {
            "schema_version": "0.1",
            "company": {"name": "株式会社例", "source_ref": "evaluation.json company.name"},
            "audience_questions": [{"question": "何の会社か", "answered_by": ["company-name"]}],
            "selected_content": [{
                "id": "company-name", "kind": "identity", "purpose": "会社を識別する",
                "copy": {"heading": "株式会社例の会社案内"},
                "placement": [{"page": "index.html", "section": "h1"}],
                "source_refs": [{"artifact": "evaluation.json", "path": "company.name"}],
                "selection_reason": "確認済みの正式名称", "freshness": {"status": "timeless", "basis": "取得時点の会社名"},
                "status": "ready",
            }],
            "excluded_content": [],
            "review": {"visible_claims_traced": True, "copy_ready": True,
                       "cta_targets_verified": True, "reviewed_at": "2026-10-27T12:00:00+09:00"},
        })
        self.write_json(root / "rebuild.json", {
            "pages": [{"file": "index.html"}], "actions_applied": [], "inherited": {},
            "needs_confirmation": [], "content_plan_ref": "content-plan.json",
            "content_selection": {"selected_count": 1, "excluded_count": 0,
                                  "visible_claims_traced": True},
            "check": {"quality_status": "not_run", "quality_score": 0},
        })

    @staticmethod
    def write_json(path: pathlib.Path, value: object) -> None:
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def run_check(self, root: pathlib.Path) -> tuple[int, dict]:
        result = subprocess.run(
            ["python3", str(SCRIPT), str(root)], capture_output=True, text=True, check=False,
        )
        return result.returncode, json.loads(result.stdout)

    def test_valid_content_plan_passes_with_not_run_warning(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_site(root)
            code, result = self.run_check(root)
            self.assertEqual(0, code)
            self.assertTrue(result["ok"])

    def test_non_ready_content_and_placeholder_fail(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_site(root)
            plan = json.loads((root / "content-plan.json").read_text(encoding="utf-8"))
            plan["selected_content"][0]["status"] = "draft"
            self.write_json(root / "content-plan.json", plan)
            html = (root / "index.html").read_text(encoding="utf-8").replace(
                "</body>", "<p>サンプルテキスト</p></body>"
            )
            (root / "index.html").write_text(html, encoding="utf-8")
            code, result = self.run_check(root)
            self.assertEqual(1, code)
            checks = {item["check"] for item in result["errors"]}
            self.assertIn("content_plan", checks)
            self.assertIn("internal_annotation", checks)


if __name__ == "__main__":
    unittest.main()
