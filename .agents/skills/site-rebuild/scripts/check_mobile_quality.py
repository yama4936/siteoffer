#!/usr/bin/env python3
"""site-rebuild のスマホ実画面レビュー証跡を検査する。"""

import json
import os
import sys


NEGATIVE_CHECKS = (
    "horizontal_overflow",
    "content_overlap",
    "fixed_ui_obscures",
    "duplicate_primary_actions",
)
POSITIVE_CHECKS = (
    "text_readable",
    "navigation_usable",
    "scan_path_clear",
    "tap_targets_usable",
    "table_content_usable",
)
REQUIRED_STATES = {"initial_viewport", "full_page"}


def fail(errors, message):
    errors.append(message)


def load_json(path, errors):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        fail(errors, f"quality-review.json を読めない: {exc}")
        return None


def screenshot_exists(site_root, value):
    if not isinstance(value, str) or not value.strip():
        return False
    target = os.path.realpath(os.path.join(site_root, value))
    allowed_root = os.path.realpath(os.path.dirname(site_root))
    if not (target == allowed_root or target.startswith(allowed_root + os.sep)):
        return False
    return os.path.isfile(target)


def check_site(site_root):
    errors = []
    review = load_json(os.path.join(site_root, "quality-review.json"), errors)
    if not isinstance(review, dict):
        return errors

    if review.get("status") != "pass":
        fail(errors, "スマホ実画面レビュー完了時だけ status=pass にする")
    fatal = review.get("fatal_issues")
    if fatal != []:
        fail(errors, "fatal_issues は pass 時に空にする")
    scores = review.get("scores")
    mobile_score = scores.get("mobile") if isinstance(scores, dict) else None
    if not isinstance(mobile_score, (int, float)) or isinstance(mobile_score, bool) or mobile_score < 12:
        fail(errors, "scores.mobile は12/15以上が必要")

    viewports = review.get("viewports")
    has_standard_mobile = False
    if isinstance(viewports, list):
        for viewport in viewports:
            if not isinstance(viewport, dict):
                continue
            width, height = viewport.get("width"), viewport.get("height")
            if width == 390 and height == 844:
                has_standard_mobile = True
    if not has_standard_mobile:
        fail(errors, "viewports に数値の width=390, height=844 が必要")

    html_files = set()
    for directory, _dirs, files in os.walk(site_root):
        for name in files:
            if name.lower().endswith((".html", ".htm")):
                html_files.add(os.path.relpath(os.path.join(directory, name), site_root).replace(os.sep, "/"))

    page_reviews = review.get("page_reviews")
    if not isinstance(page_reviews, list):
        fail(errors, "page_reviews は全HTMLの配列にする")
        return errors

    reviewed_files = set()
    for index, page in enumerate(page_reviews):
        label = f"page_reviews[{index}]"
        if not isinstance(page, dict):
            fail(errors, f"{label} はオブジェクトにする")
            continue
        filename = page.get("file")
        if filename not in html_files or filename in reviewed_files:
            fail(errors, f"{label}.file が不正・重複・実在HTMLと不一致: {filename}")
        else:
            reviewed_files.add(filename)
        mobile = page.get("mobile")
        if not isinstance(mobile, dict):
            fail(errors, f"{label}.mobile がない")
            continue
        viewport = mobile.get("viewport")
        if not isinstance(viewport, dict) or viewport.get("width") != 390 or viewport.get("height") != 844:
            fail(errors, f"{label}.mobile.viewport は390×844の数値にする")
        evidence = mobile.get("evidence")
        states = set()
        if not isinstance(evidence, list) or not evidence:
            fail(errors, f"{label}.mobile.evidence がない")
        else:
            for item_index, item in enumerate(evidence):
                if not isinstance(item, dict):
                    fail(errors, f"{label}.mobile.evidence[{item_index}] はオブジェクトにする")
                    continue
                state = item.get("state")
                if isinstance(state, str):
                    states.add(state)
                screenshot = item.get("screenshot")
                if not screenshot_exists(site_root, screenshot):
                    fail(errors, f"{label}.mobile.evidence[{item_index}] の画像がない・範囲外: {screenshot}")
        missing_states = sorted(REQUIRED_STATES - states)
        if missing_states:
            fail(errors, f"{label}.mobile.evidence に不足状態がある: {missing_states}")
        checks = mobile.get("checks")
        if not isinstance(checks, dict):
            fail(errors, f"{label}.mobile.checks がない")
        else:
            for key in NEGATIVE_CHECKS:
                if checks.get(key) is not False:
                    fail(errors, f"{label}.mobile.checks.{key} は false が必要")
            for key in POSITIVE_CHECKS:
                if checks.get(key) is not True:
                    fail(errors, f"{label}.mobile.checks.{key} は true が必要")
        observations = mobile.get("observations")
        if not isinstance(observations, list) or not observations or not all(
                isinstance(value, str) and value.strip() for value in observations):
            fail(errors, f"{label}.mobile.observations は1件以上必要")

    missing_pages = sorted(html_files - reviewed_files)
    extra_pages = sorted(reviewed_files - html_files)
    if missing_pages or extra_pages:
        fail(errors, f"page_reviews とHTMLが一致しない: missing={missing_pages} extra={extra_pages}")
    return errors


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"ok": False, "errors": ["使い方: check_mobile_quality.py <site-dir>"]}, ensure_ascii=False))
        return 2
    site_root = os.path.realpath(sys.argv[1])
    errors = check_site(site_root)
    print(json.dumps({"ok": not errors, "errors": errors}, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
