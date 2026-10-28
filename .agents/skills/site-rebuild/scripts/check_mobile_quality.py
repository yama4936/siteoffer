#!/usr/bin/env python3
"""site-rebuild のスマホ実画面レビュー証跡を検査する。"""

import hashlib
import json
import math
import os
import struct
import sys
import zlib


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


RENDER_SUFFIXES = {".html", ".htm", ".css", ".js", ".mjs", ".svg", ".png", ".jpg",
                   ".jpeg", ".webp", ".gif", ".ico", ".woff", ".woff2", ".avif"}


def site_digest(site_root):
    """レビューJSON等を除いた表示入力を追跡する。画像証跡はsiteの外へ保存する。"""
    digest = hashlib.sha256()
    paths = []
    for directory, dirs, files in os.walk(site_root):
        dirs.sort()
        for filename in files:
            if os.path.splitext(filename)[1].lower() in RENDER_SUFFIXES:
                paths.append(os.path.join(directory, filename))
    for target in sorted(paths):
        relative = os.path.relpath(target, site_root).replace(os.sep, "/")
        digest.update(relative.encode("utf-8") + b"\0")
        with open(target, "rb") as handle:
            digest.update(hashlib.sha256(handle.read()).digest())
    return "sha256:" + digest.hexdigest()


def screenshot_size(site_root, value):
    """証跡を成果物内のPNGに限定し、チャンクの破損と実ピクセル寸法を調べる。"""
    if not isinstance(value, str) or not value.strip():
        return None
    target = os.path.realpath(os.path.join(site_root, value))
    allowed_root = os.path.realpath(os.path.dirname(site_root))
    if not target.startswith(allowed_root + os.sep) or not os.path.isfile(target):
        return None
    try:
        with open(target, "rb") as handle:
            if handle.read(8) != b"\x89PNG\r\n\x1a\n":
                return None
            size, has_data = None, False
            while True:
                header = handle.read(8)
                if len(header) != 8:
                    return None
                length, kind = struct.unpack(">I4s", header)
                if length > 64 * 1024 * 1024:
                    return None
                data, crc = handle.read(length), handle.read(4)
                if len(data) != length or len(crc) != 4:
                    return None
                if zlib.crc32(kind + data) & 0xffffffff != struct.unpack(">I", crc)[0]:
                    return None
                if kind == b"IHDR":
                    if size is not None or length != 13:
                        return None
                    size = struct.unpack(">II", data[:8])
                    if min(size) <= 0:
                        return None
                elif size is None:
                    return None
                elif kind == b"IDAT":
                    has_data = has_data or length > 0
                elif kind == b"IEND":
                    return size if length == 0 and has_data and not handle.read(1) else None
    except (OSError, ValueError, struct.error):
        return None


def check_site(site_root):
    errors = []
    review = load_json(os.path.join(site_root, "quality-review.json"), errors)
    if not isinstance(review, dict):
        return errors

    if review.get("site_digest") != site_digest(site_root):
        fail(errors, "site_digest が現在の表示入力と一致しない。修正後に全画面を再確認・撮影する")

    if review.get("status") != "pass":
        fail(errors, "スマホ実画面レビュー完了時だけ status=pass にする")
    fatal = review.get("fatal_issues")
    if fatal != []:
        fail(errors, "fatal_issues は pass 時に空にする")
    scores = review.get("scores")
    mobile_score = scores.get("mobile") if isinstance(scores, dict) else None
    if not isinstance(mobile_score, (int, float)) or isinstance(mobile_score, bool) or not math.isfinite(mobile_score) or not 12 <= mobile_score <= 15:
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
    screenshot_paths = set()
    for index, page in enumerate(page_reviews):
        label = f"page_reviews[{index}]"
        if not isinstance(page, dict):
            fail(errors, f"{label} はオブジェクトにする")
            continue
        filename = page.get("file")
        if not isinstance(filename, str) or filename not in html_files or filename in reviewed_files:
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
                size = screenshot_size(site_root, screenshot)
                if size is None:
                    fail(errors, f"{label}.mobile.evidence[{item_index}] の画像がない・範囲外・有効なPNGでない: {screenshot}")
                else:
                    resolved = os.path.realpath(os.path.join(site_root, screenshot))
                    if resolved in screenshot_paths:
                        fail(errors, f"{label}.mobile.evidence は状態ごとに別の画像を使う: {screenshot}")
                    screenshot_paths.add(resolved)
                    if state != "full_page" and size != (390, 844):
                        fail(errors, f"{label} のviewport PNGは390×844が必要: {size}")
                    if state == "full_page" and (size[0] != 390 or size[1] < 844):
                        fail(errors, f"{label} の全長PNGは幅390・高さ844以上が必要: {size}")
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
    if len(sys.argv) == 3 and sys.argv[1] == "--digest":
        print(site_digest(os.path.realpath(sys.argv[2])))
        return 0
    if len(sys.argv) != 2:
        print(json.dumps({"ok": False, "errors": ["使い方: check_mobile_quality.py <site-dir>"]}, ensure_ascii=False))
        return 2
    site_root = os.path.realpath(sys.argv[1])
    errors = check_site(site_root)
    print(json.dumps({"ok": not errors, "errors": errors}, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
