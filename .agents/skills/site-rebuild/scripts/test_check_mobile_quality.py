#!/usr/bin/env python3

import json
import pathlib
import subprocess
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).with_name("check_mobile_quality.py")


class MobileQualityCheckTest(unittest.TestCase):
    def make_site(self, root):
        site = root / "site"
        review_dir = root / "review"
        site.mkdir()
        review_dir.mkdir()
        (site / "index.html").write_text("<!doctype html><title>例</title>", encoding="utf-8")
        for name in ("index-mobile-viewport.png", "index-mobile-full.png"):
            (review_dir / name).write_bytes(b"png")
        review = {
            "status": "pass",
            "fatal_issues": [],
            "scores": {"mobile": 12},
            "viewports": [{"width": 1440, "height": 1000}, {"width": 390, "height": 844}],
            "page_reviews": [{
                "file": "index.html",
                "mobile": {
                    "viewport": {"width": 390, "height": 844},
                    "evidence": [
                        {"state": "initial_viewport", "screenshot": "../review/index-mobile-viewport.png"},
                        {"state": "full_page", "screenshot": "../review/index-mobile-full.png"},
                    ],
                    "checks": {
                        "horizontal_overflow": False,
                        "content_overlap": False,
                        "fixed_ui_obscures": False,
                        "duplicate_primary_actions": False,
                        "text_readable": True,
                        "navigation_usable": True,
                        "scan_path_clear": True,
                        "tap_targets_usable": True,
                        "table_content_usable": True,
                    },
                    "observations": ["先頭画面を確認"],
                },
            }],
        }
        self.write_review(site, review)
        return site, review

    @staticmethod
    def write_review(site, review):
        (site / "quality-review.json").write_text(
            json.dumps(review, ensure_ascii=False), encoding="utf-8",
        )

    def run_check(self, site):
        result = subprocess.run(
            ["python3", str(SCRIPT), str(site)], capture_output=True, text=True, check=False,
        )
        return result.returncode, json.loads(result.stdout)

    def test_complete_review_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            site, _review = self.make_site(pathlib.Path(directory))
            code, result = self.run_check(site)
            self.assertEqual(0, code, result)

    def test_low_mobile_score_and_string_height_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            site, review = self.make_site(pathlib.Path(directory))
            review["scores"]["mobile"] = 0
            review["viewports"][1]["height"] = "844px"
            self.write_review(site, review)
            code, result = self.run_check(site)
            self.assertEqual(1, code)
            self.assertTrue(any("12/15" in message for message in result["errors"]))
            self.assertTrue(any("width=390" in message for message in result["errors"]))

    def test_missing_page_and_screenshot_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            site, review = self.make_site(root)
            (site / "about.html").write_text("<!doctype html><title>会社</title>", encoding="utf-8")
            review["page_reviews"][0]["mobile"]["evidence"][0]["screenshot"] = "../review/missing.png"
            self.write_review(site, review)
            code, result = self.run_check(site)
            self.assertEqual(1, code)
            messages = " ".join(result["errors"])
            self.assertIn("画像がない", messages)
            self.assertIn("about.html", messages)

    def test_unresolved_mobile_check_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            site, review = self.make_site(pathlib.Path(directory))
            review["page_reviews"][0]["mobile"]["checks"]["fixed_ui_obscures"] = True
            self.write_review(site, review)
            code, result = self.run_check(site)
            self.assertEqual(1, code)
            self.assertTrue(any("fixed_ui_obscures" in message for message in result["errors"]))


if __name__ == "__main__":
    unittest.main()
