#!/usr/bin/env python3

import json
import pathlib
import struct
import subprocess
import tempfile
import unittest
import zlib

from check_mobile_quality import site_digest


SCRIPT = pathlib.Path(__file__).with_name("check_mobile_quality.py")


class MobileQualityCheckTest(unittest.TestCase):
    def make_site(self, root):
        site = root / "site"
        review_dir = root / "review"
        site.mkdir()
        review_dir.mkdir()
        (site / "index.html").write_text("<!doctype html><title>例</title>", encoding="utf-8")
        for name in ("index-mobile-viewport.png", "index-mobile-full.png"):
            self.write_png(review_dir / name, 390, 844)
        review = {
            "site_digest": site_digest(str(site)),
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
    def write_png(path, width, height, *, image_data=None, color_type=2, split=False):
        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
        if image_data is None:
            channels = 4 if color_type == 6 else 3
            image_data = zlib.compress((b"\0" + b"\xff" * width * channels) * height)
        chunks = [image_data[:len(image_data) // 2], image_data[len(image_data) // 2:]] if split else [image_data]
        path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0))
                         + b"".join(chunk(b"IDAT", data) for data in chunks) + chunk(b"IEND", b""))

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

    def test_disguised_or_wrong_size_screenshot_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            site, _review = self.make_site(pathlib.Path(directory))
            screenshot = site.parent / "review/index-mobile-viewport.png"
            screenshot.write_bytes(b"not a screenshot")
            code, result = self.run_check(site)
            self.assertEqual(1, code)
            self.assertIn("PNG", " ".join(result["errors"]))
            self.write_png(screenshot, 1440, 1000)
            code, result = self.run_check(site)
            self.assertEqual(1, code)
            self.assertIn("390×844", " ".join(result["errors"]))

    def test_invalid_pixel_stream_cannot_be_screenshot_evidence(self):
        for invalid in (b"not zlib image data", zlib.compress(b"\0"),
                        zlib.compress((b"\5" + b"\xff" * 390 * 3) * 844),
                        zlib.compress((b"\0" + b"\xff" * 390 * 3) * 845)):
            with self.subTest(invalid_length=len(invalid)), tempfile.TemporaryDirectory() as directory:
                site, _review = self.make_site(pathlib.Path(directory))
                screenshot = site.parent / "review/index-mobile-viewport.png"
                self.write_png(screenshot, 390, 844, image_data=invalid)
                code, result = self.run_check(site)
                self.assertEqual(1, code, result)
                self.assertIn("PNG", " ".join(result["errors"]))

    def test_rgba_and_split_pixel_stream_are_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            site, _review = self.make_site(pathlib.Path(directory))
            self.write_png(site.parent / "review/index-mobile-viewport.png", 390, 844,
                           color_type=6, split=True)
            code, result = self.run_check(site)
            self.assertEqual(0, code, result)

    def test_changed_render_input_invalidates_old_review(self):
        with tempfile.TemporaryDirectory() as directory:
            site, _review = self.make_site(pathlib.Path(directory))
            (site / "style.css").write_text("body { font-size: 8px; }", encoding="utf-8")
            code, result = self.run_check(site)
            self.assertEqual(1, code)
            self.assertIn("site_digest", " ".join(result["errors"]))

    def test_one_image_cannot_prove_two_states(self):
        with tempfile.TemporaryDirectory() as directory:
            site, review = self.make_site(pathlib.Path(directory))
            evidence = review["page_reviews"][0]["mobile"]["evidence"]
            evidence[1]["screenshot"] = evidence[0]["screenshot"]
            self.write_review(site, review)
            code, result = self.run_check(site)
            self.assertEqual(1, code)
            self.assertIn("状態ごとに別", " ".join(result["errors"]))


if __name__ == "__main__":
    unittest.main()
