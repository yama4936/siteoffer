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
            """<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="会社案内"><meta name="robots" content="noindex"><title>会社案内</title></head><body><p>非公式の改善案（デモ）</p><h1 data-siteoffer-field="company.name">株式会社例の会社案内</h1></body></html>""",
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
            "schema_version": "0.2",
            "company": {"name": "株式会社例", "source_ref": "evaluation.json company.name"},
            "source_profile": {
                "distinctive_terms": ["株式会社例"], "tone": "簡潔な敬体",
                "content_priorities": ["会社情報"],
                "source_refs": [{"artifact": "evaluation.json", "path": "company.name"}],
            },
            "audience_questions": [{"question": "何の会社か", "answered_by": ["company-name"]}],
            "source_coverage": {
                "status": "complete", "observed_navigation": ["会社案内"],
                "collected_sources": ["evaluation.json company.name"], "missing_sources": [],
                "basis": "取得済み資料と画面を照合",
            },
            "decision_coverage": [
                {"id": "identity", "status": "answered", "answered_by": ["company-name"], "reason": "会社名を確認"},
                {"id": "offer", "status": "answered", "answered_by": ["company-name"], "reason": "テスト用の最小根拠"},
                {"id": "fit", "status": "not_applicable", "answered_by": [], "reason": "テスト対象外"},
                {"id": "specifics", "status": "not_applicable", "answered_by": [], "reason": "テスト対象外"},
                {"id": "proof", "status": "not_applicable", "answered_by": [], "reason": "テスト対象外"},
                {"id": "trust", "status": "answered", "answered_by": ["company-name"], "reason": "会社名を確認"},
                {"id": "action", "status": "answered", "answered_by": ["company-name"], "reason": "テスト用の主要行動"},
            ],
            "page_plan": [{
                "file": "index.html", "purpose": "会社を識別する",
                "audience_questions": ["identity", "trust"], "content_ids": ["company-name"],
                "reason_separate": "サイト全体の入口",
            }],
            "media_plan": {"usable_assets": [], "excluded_assets": [],
                           "missing_essential_assets": [], "notes": "画像を使わない"},
            "update_plan": {"mode": "fixed_fields_only", "connection_status": "planned",
                            "content_types": [], "placements": [], "migration_required": False,
                            "reason": "固定項目だけを更新する"},
            "selected_content": [{
                "id": "company-name", "kind": "identity", "purpose": "会社を識別する",
                "copy": {"heading": "株式会社例の会社案内"},
                "placement": [{"page": "index.html", "section": "h1"}],
                "source_refs": [{"artifact": "evaluation.json", "path": "company.name"}],
                "selection_reason": "確認済みの正式名称",
                "source_fidelity": {"mode": "verbatim_fact", "preserved_terms": ["株式会社例"],
                                    "meaning_preserved": True, "editorial_changes": "見出し用に会社案内を付加"},
                "freshness": {"status": "timeless", "basis": "取得時点の会社名"},
                "status": "ready",
            }],
            "excluded_content": [],
            "review": {"visible_claims_traced": True, "copy_ready": True,
                       "cta_targets_verified": True, "source_fidelity_reviewed": True,
                       "presentation_ready": True, "reviewed_at": "2026-10-27T12:00:00+09:00"},
            "readiness": {"status": "ready_for_customer_review", "blocking_gaps": [],
                          "production_blockers": ["顧客確認"]},
        })
        self.write_json(root / "rebuild.json", {
            "pages": [{"file": "index.html"}], "actions_applied": [], "inherited": {},
            "needs_confirmation": [], "content_plan_ref": "content-plan.json",
            "content_selection": {"selected_count": 1, "excluded_count": 0,
                                  "visible_claims_traced": True},
            "admin_schema_ref": "admin-schema.json",
            "admin_integration": {"status": "planned", "editable_fields": 1,
                                  "editable_images": 0, "article_types": 0,
                                  "inquiry_form": True},
            "check": {"quality_status": "not_run", "quality_score": 0},
        })
        self.write_json(root / "admin-schema.json", {
            "schema_version": "0.1", "company_ref": "evaluation.json company",
            "integration_status": "planned",
            "editable_fields": [{
                "id": "company.name", "label": "会社名", "type": "short_text",
                "source_content_ids": ["company-name"],
                "bindings": [{"page": "index.html", "section": "h1"}],
                "required": True, "constraints": {"max_length": 100},
            }],
            "editable_images": [],
            "articles": {"enabled": False, "types": [], "list_placements": [],
                         "images_allowed": False, "migration_required": False},
            "inquiry_form": {
                "enabled": True, "form_id": "primary-contact", "display_page": "index.html",
                "fields": [
                    {"id": "name", "label": "お名前", "type": "text", "required": True},
                    {"id": "privacy_consent", "label": "個人情報の取り扱いに同意する",
                     "type": "consent", "required": True},
                ],
                "store_in_siteoffer": True, "customer_inbox": True,
                "email_notification": True, "status_management": False,
                "privacy_notice_required": True, "spam_controls": ["honeypot", "rate_limit"],
            },
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

    def test_site_improvement_meta_copy_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_site(root)
            html = (root / "index.html").read_text(encoding="utf-8").replace(
                "</body>",
                "<section><h2>知りたい情報へ、迷わず進める構成に。</h2>"
                "<p>画像だけのメニューを、読み上げやスマホでも内容が伝わるテキストへ。"
                "訪問者の目的に沿って整理しました。</p></section></body>",
            )
            (root / "index.html").write_text(html, encoding="utf-8")
            code, result = self.run_check(root)
            self.assertEqual(1, code)
            checks = {item["check"] for item in result["errors"]}
            self.assertIn("irrelevant_meta_copy", checks)

    def test_incomplete_or_untraced_source_copy_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_site(root)
            plan = json.loads((root / "content-plan.json").read_text(encoding="utf-8"))
            del plan["selected_content"][0]["source_fidelity"]
            plan["readiness"] = {"status": "incomplete", "blocking_gaps": ["主要サービス本文"],
                                 "production_blockers": []}
            self.write_json(root / "content-plan.json", plan)
            code, result = self.run_check(root)
            self.assertEqual(1, code)
            messages = [item["message"] for item in result["errors"]]
            self.assertTrue(any("source_fidelity" in message for message in messages))
            self.assertTrue(any("完成原稿になっていない" in message for message in messages))

    def test_incomplete_source_coverage_or_decision_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_site(root)
            plan = json.loads((root / "content-plan.json").read_text(encoding="utf-8"))
            plan["source_coverage"]["status"] = "incomplete"
            plan["source_coverage"]["missing_sources"] = ["施工例"]
            plan["decision_coverage"][1]["status"] = "missing"
            plan["decision_coverage"][1]["answered_by"] = []
            self.write_json(root / "content-plan.json", plan)
            code, result = self.run_check(root)
            self.assertEqual(1, code)
            messages = [item["message"] for item in result["errors"]]
            self.assertTrue(any("主要情報が未取得" in message for message in messages))
            self.assertTrue(any("未回答" in message for message in messages))

    def test_admin_schema_binding_and_inquiry_contract_fail_when_inconsistent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_site(root)
            schema = json.loads((root / "admin-schema.json").read_text(encoding="utf-8"))
            schema["editable_fields"][0]["id"] = "company.other_name"
            schema["inquiry_form"]["email_notification"] = False
            self.write_json(root / "admin-schema.json", schema)
            code, result = self.run_check(root)
            self.assertEqual(1, code)
            messages = [item["message"] for item in result["errors"]]
            self.assertTrue(any("HTML binding" in message for message in messages))
            self.assertTrue(any("email_notification" in message for message in messages))


if __name__ == "__main__":
    unittest.main()
