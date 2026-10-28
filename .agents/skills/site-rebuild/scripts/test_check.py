#!/usr/bin/env python3
"""site-rebuild の content-plan 検査を回帰テストする。"""

import json
import pathlib
import subprocess
import tempfile
import unittest

import test_check_mobile_quality as mobile_fixtures


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
            "schema_version": "0.3",
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
            "site_architecture": {
                "mode": "single_page", "reason": "テスト用の情報が1ページで完結する",
                "primary_navigation": ["index.html"],
                "mobile_content_equivalence_reviewed": True,
            },
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
                "claim_ids": ["claim-company-name"],
                "source_fidelity": {"mode": "verbatim_fact", "preserved_terms": ["株式会社例"],
                                    "meaning_preserved": True, "editorial_changes": "見出し用に会社案内を付加"},
                "freshness": {"status": "timeless", "basis": "取得時点の会社名"},
                "status": "ready",
            }],
            "source_content_inventory": [{
                "id": "source-company-name", "kind": "identity", "label": "正式名称",
                "importance": "essential",
                "source_refs": [{"artifact": "evaluation.json", "path": "company.name"}],
                "source_text_length": 5, "disposition": "retained",
                "target_content_ids": ["company-name"], "target_pages": ["index.html"],
                "reason": "正式名称を見出しへ保持",
            }],
            "feature_inventory": [{
                "id": "feature-navigation", "kind": "navigation",
                "original_behavior": "トップページから会社情報を閲覧できる",
                "importance": "supporting",
                "evidence": [{"artifact": "collected.json", "path": "site.navigation_links_top"}],
                "handling": "preserved", "target": "index.html の通常リンク",
                "target_refs": [{"artifact": "html", "path": "index.html"}],
                "user_visible_difference": "なし", "verification_status": "verified",
            }],
            "parity_review": {
                "unaccounted_content_ids": [], "unaccounted_feature_ids": [],
                "demo_status": "complete", "production_status": "equivalent_or_improved",
                "information_summary": {"source_items": 1, "retained": 1, "consolidated": 0,
                                        "excluded": 0, "blocked": 0},
                "feature_summary": {"source_features": 1, "preserved": 1, "replaced": 0,
                                    "planned": 0, "out_of_scope": 0, "blocked": 0},
                "comparison_notes": "文字数は参考値とし、元の情報と機能を意味単位で照合",
            },
            "fact_verification": {
                "company_identity_checked": True,
                "claims": [{
                    "id": "claim-company-name", "kind": "identity",
                    "statement": "正式名称は株式会社例", "content_ids": ["company-name"],
                    "source_refs": [{"artifact": "evaluation.json", "path": "company.name",
                                     "evidence": "会社名欄",
                                     "observed_at": "2026-10-27T11:30:00+09:00"}],
                    "freshness": {"status": "timeless", "basis": "評価時点の会社名"},
                    "conflicts": [], "surfaces": ["body", "title"],
                    "source_value": "株式会社例", "display_value": "株式会社例",
                    "status": "verified",
                }],
                "unresolved_claim_ids": [],
                "reviewed_surfaces": ["body", "title", "description", "cta", "structured_data"],
                "reviewed_at": "2026-10-27T12:00:00+09:00",
            },
            "excluded_content": [],
            "review": {"visible_claims_traced": True, "copy_ready": True,
                       "cta_targets_verified": True, "source_fidelity_reviewed": True,
                       "facts_verified": True, "presentation_ready": True,
                       "reviewed_at": "2026-10-27T12:00:00+09:00"},
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

    def test_unresolved_or_changed_fact_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_site(root)
            plan = json.loads((root / "content-plan.json").read_text(encoding="utf-8"))
            claim = plan["fact_verification"]["claims"][0]
            claim["status"] = "conflicted"
            claim["conflicts"] = ["会社概要とフッターで表記が異なる"]
            claim["display_value"] = "株式会社別例"
            plan["fact_verification"]["unresolved_claim_ids"] = ["claim-company-name"]
            plan["review"]["facts_verified"] = False
            self.write_json(root / "content-plan.json", plan)
            code, result = self.run_check(root)
            self.assertEqual(1, code)
            messages = " ".join(item["message"] for item in result["errors"])
            self.assertIn("status は表示前に verified", messages)
            self.assertIn("conflicts", messages)
            self.assertIn("重要値が出典と表示で一致しない", messages)
            self.assertIn("unresolved_claim_ids", messages)
            self.assertIn("review.facts_verified", messages)

    def test_untracked_selected_content_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_site(root)
            plan = json.loads((root / "content-plan.json").read_text(encoding="utf-8"))
            plan["selected_content"][0]["claim_ids"] = ["claim-missing"]
            self.write_json(root / "content-plan.json", plan)
            code, result = self.run_check(root)
            self.assertEqual(1, code)
            messages = " ".join(item["message"] for item in result["errors"])
            self.assertIn("未定義ID", messages)
            self.assertIn("claimの対応が一致しない", messages)

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

    def test_site_architecture_requires_matching_mode_and_mobile_review(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_site(root)
            plan = json.loads((root / "content-plan.json").read_text(encoding="utf-8"))
            plan["site_architecture"]["mode"] = "multi_page"
            plan["site_architecture"]["mobile_content_equivalence_reviewed"] = False
            self.write_json(root / "content-plan.json", plan)
            code, result = self.run_check(root)
            self.assertEqual(1, code)
            messages = " ".join(item["message"] for item in result["errors"])
            self.assertIn("HTML数", messages)
            self.assertIn("mobile_content_equivalence_reviewed", messages)

    def test_multipage_requires_unique_metadata_and_link_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_site(root)
            duplicate = (root / "index.html").read_text(encoding="utf-8").replace(
                "data-siteoffer-field=\"company.name\"", ""
            )
            (root / "services.html").write_text(duplicate, encoding="utf-8")
            plan = json.loads((root / "content-plan.json").read_text(encoding="utf-8"))
            plan["site_architecture"] = {
                "mode": "multi_page", "reason": "サービスを独立して説明する",
                "primary_navigation": ["index.html", "services.html"],
                "mobile_content_equivalence_reviewed": True,
            }
            plan["page_plan"].append({
                "file": "services.html", "purpose": "サービスを説明する",
                "audience_questions": ["offer"], "content_ids": ["company-name"],
                "reason_separate": "独立した説明がある",
            })
            self.write_json(root / "content-plan.json", plan)
            rebuild = json.loads((root / "rebuild.json").read_text(encoding="utf-8"))
            rebuild["pages"].append({"file": "services.html"})
            self.write_json(root / "rebuild.json", rebuild)
            code, result = self.run_check(root)
            self.assertEqual(1, code)
            checks = {item["check"] for item in result["errors"]}
            self.assertIn("unique_metadata", checks)
            self.assertIn("navigation", checks)

    def test_valid_multipage_navigation_passes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_site(root)
            index = (root / "index.html").read_text(encoding="utf-8").replace(
                "</body>", '<a href="services.html">業務内容</a></body>',
            )
            (root / "index.html").write_text(index, encoding="utf-8")
            (root / "services.html").write_text(
                "<!doctype html><html lang=\"ja\"><head>"
                "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
                "<meta name=\"description\" content=\"確認済みの業務内容\">"
                "<meta name=\"robots\" content=\"noindex\"><title>業務内容</title></head>"
                "<body><p>非公式の改善案（デモ）</p><h1>業務内容</h1>"
                "<a href=\"index.html\">トップ</a></body></html>",
                encoding="utf-8",
            )
            plan = json.loads((root / "content-plan.json").read_text(encoding="utf-8"))
            plan["site_architecture"] = {
                "mode": "multi_page", "reason": "サービスを独立して説明する",
                "primary_navigation": ["index.html", "services.html"],
                "mobile_content_equivalence_reviewed": True,
            }
            plan["page_plan"].append({
                "file": "services.html", "purpose": "サービスを説明する",
                "audience_questions": ["offer"], "content_ids": ["company-name"],
                "reason_separate": "独立した説明がある",
            })
            self.write_json(root / "content-plan.json", plan)
            rebuild = json.loads((root / "rebuild.json").read_text(encoding="utf-8"))
            rebuild["pages"].append({"file": "services.html"})
            self.write_json(root / "rebuild.json", rebuild)
            code, result = self.run_check(root)
            self.assertEqual(0, code, result)

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

    def test_unaccounted_or_blocked_source_content_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_site(root)
            plan = json.loads((root / "content-plan.json").read_text(encoding="utf-8"))
            plan["source_content_inventory"][0]["disposition"] = "blocked"
            plan["source_content_inventory"][0]["target_content_ids"] = []
            plan["source_content_inventory"][0]["target_pages"] = []
            plan["parity_review"]["unaccounted_content_ids"] = ["source-company-name"]
            plan["parity_review"]["information_summary"] = {
                "source_items": 1, "retained": 0, "consolidated": 0, "excluded": 0, "blocked": 1,
            }
            self.write_json(root / "content-plan.json", plan)
            code, result = self.run_check(root)
            self.assertEqual(1, code)
            checks = {item["check"] for item in result["errors"]}
            self.assertIn("content_parity", checks)
            self.assertIn("parity_review", checks)

    def test_unaccounted_feature_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_site(root)
            plan = json.loads((root / "content-plan.json").read_text(encoding="utf-8"))
            plan["parity_review"]["unaccounted_feature_ids"] = ["feature-navigation"]
            self.write_json(root / "content-plan.json", plan)
            code, result = self.run_check(root)
            self.assertEqual(1, code)
            self.assertTrue(any(item["check"] == "parity_review" for item in result["errors"]))

    def test_primary_planned_feature_requires_production_gap(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_site(root)
            plan = json.loads((root / "content-plan.json").read_text(encoding="utf-8"))
            feature = plan["feature_inventory"][0]
            feature.update({"importance": "primary", "handling": "planned",
                            "verification_status": "planned",
                            "user_visible_difference": "デモでは送信せず、本番接続後に利用可能"})
            plan["parity_review"]["feature_summary"] = {
                "source_features": 1, "preserved": 0, "replaced": 0,
                "planned": 1, "out_of_scope": 0, "blocked": 0,
            }
            self.write_json(root / "content-plan.json", plan)
            code, result = self.run_check(root)
            self.assertEqual(1, code)
            messages = " ".join(item["message"] for item in result["errors"])
            self.assertIn("production_status=gaps_remaining", messages)

    def test_primary_blocked_feature_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_site(root)
            plan = json.loads((root / "content-plan.json").read_text(encoding="utf-8"))
            feature = plan["feature_inventory"][0]
            feature.update({"importance": "primary", "handling": "blocked",
                            "verification_status": "blocked"})
            plan["parity_review"]["feature_summary"] = {
                "source_features": 1, "preserved": 0, "replaced": 0,
                "planned": 0, "out_of_scope": 0, "blocked": 1,
            }
            self.write_json(root / "content-plan.json", plan)
            code, result = self.run_check(root)
            self.assertEqual(1, code)
            self.assertTrue(any("主要機能が欠落" in item["message"] for item in result["errors"]))

    def test_inventory_target_must_exist(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_site(root)
            plan = json.loads((root / "content-plan.json").read_text(encoding="utf-8"))
            plan["source_content_inventory"][0]["target_content_ids"] = ["missing-content"]
            plan["source_content_inventory"][0]["target_pages"] = ["missing.html"]
            self.write_json(root / "content-plan.json", plan)
            code, result = self.run_check(root)
            self.assertEqual(1, code)
            self.assertTrue(any("対応先が存在しない" in item["message"] for item in result["errors"]))

    def test_parity_summary_must_match_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_site(root)
            plan = json.loads((root / "content-plan.json").read_text(encoding="utf-8"))
            plan["parity_review"]["information_summary"]["retained"] = 0
            plan["parity_review"]["feature_summary"]["preserved"] = 0
            self.write_json(root / "content-plan.json", plan)
            code, result = self.run_check(root)
            self.assertEqual(1, code)
            messages = " ".join(item["message"] for item in result["errors"])
            self.assertIn("information_summary", messages)
            self.assertIn("feature_summary", messages)


    def test_integrated_quality_gate_rejects_false_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_site(root)
            self.write_json(root / "quality-review.json", {
                "status": "pass", "fatal_issues": [], "total": 85,
                "scores": {"brand_specificity": 20, "visual_hierarchy": 20,
                           "information_design": 20, "content_trust": 15,
                           "mobile": 0, "polish": 10},
                "viewports": [{"width": 1440, "height": 1000}, {"width": 390, "height": 844}],
            })
            code, result = self.run_check(root)
            self.assertEqual(1, code)
            self.assertIn("mobile_quality", {item["check"] for item in result["errors"]})
            self.assertIn("page_reviews", " ".join(item["message"] for item in result["errors"]))

    def test_integrated_quality_gate_accepts_current_real_png_review(self) -> None:
        from check_mobile_quality import site_digest
        with tempfile.TemporaryDirectory() as directory:
            parent = pathlib.Path(directory)
            helper = mobile_fixtures.MobileQualityCheckTest()
            site, review = helper.make_site(parent)
            self.make_site(site)
            review.update(site_digest=site_digest(str(site)), total=87,
                          scores={"brand_specificity": 17, "visual_hierarchy": 17,
                                  "information_design": 18, "content_trust": 14,
                                  "mobile": 13, "polish": 8})
            helper.write_review(site, review)
            code, result = self.run_check(site)
            self.assertEqual(0, code, result)

    def test_binding_cannot_point_at_different_real_page(self) -> None:
        # Test the binding contract independently of unrelated page-architecture rules.
        import importlib.util
        from types import SimpleNamespace
        spec = importlib.util.spec_from_file_location("site_checker", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.make_site(root)
            checker = module.Checker(str(root))
            checker.pages = {
                "index.html": SimpleNamespace(field_bindings={"company.name"}, image_bindings=set()),
                "about.html": SimpleNamespace(field_bindings=set(), image_bindings=set()),
            }
            schema = json.loads((root / "admin-schema.json").read_text())
            schema["editable_fields"][0]["bindings"] = [{"page": "about.html", "section": "h1"}]
            self.write_json(root / "admin-schema.json", schema)
            checker.check_admin_schema({"selected_content": [{"id": "company-name"}]})
            self.assertTrue(any("表示ページがbindingsと不一致" in item["message"] for item in checker.errors))


class BlockedRecordCheckTest(unittest.TestCase):
    RECORD = {
        "schema_version": "0.1", "status": "blocked", "stage": "source_coverage",
        "checked_at": "2026-10-28T13:00:00+09:00",
        "missing_sources": [{"label": "施工の流れ", "url": "https://example.co.jp/flow",
                             "found_in": "主メニュー", "reason": "未取得", "needed_for": ["specifics"]}],
        "blocking_gaps": [{"question": "proof", "reason": "実績の詳細が未取得"}],
        "next_actions": [{"action": "collect_add_url", "urls": ["https://example.co.jp/flow"]}],
    }

    def run_blocked(self, record, make_site=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            path = root / "rebuild-blocked.json"
            path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
            if make_site:
                (root / "site").mkdir()
            done = subprocess.run(["python3", str(SCRIPT), "--blocked", str(path)],
                                  capture_output=True, text=True, check=False)
            return done.returncode, json.loads(done.stdout)

    def test_valid_record_passes(self):
        code, result = self.run_blocked(self.RECORD)
        self.assertEqual(code, 0, result)

    def test_leftover_site_and_bad_fields_fail(self):
        record = dict(self.RECORD, stage="other", next_actions=[{"action": "collect_add_url"}],
                      blocking_gaps=[{"question": "price", "reason": "x"}])
        code, result = self.run_blocked(record, make_site=True)
        self.assertEqual(code, 1)
        messages = " ".join(e["message"] for e in result["errors"])
        for word in ("stage", "urls", "blocking_gaps", "site/"):
            self.assertIn(word, messages)

    def test_missing_sources_required(self):
        code, _ = self.run_blocked(dict(self.RECORD, missing_sources=[]))
        self.assertEqual(code, 1)



if __name__ == "__main__":
    unittest.main()
