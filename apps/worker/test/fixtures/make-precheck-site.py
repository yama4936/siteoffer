"""AIの事前チェックのテスト用に、site-rebuild の check.py・check_mobile_quality.py を通る最小の改善後サイトを作る。

使い方: python3 -I make-precheck-site.py <site-rebuild の scripts ディレクトリ> <出力する site ディレクトリ>

サイト本体（HTML・content-plan.json 等）は、スキル自身の回帰テスト（scripts/test_check.py）の最小サイトをそのまま使う。
企業名は test_check.py の汎用の例示（株式会社例）で、実在企業の情報は含まない。
このファイルでは、品質レビュー（quality-review.json）を合格の形に置き換え、スマホ確認の画像（単色の有効なPNG）と
表示入力のダイジェスト（check_mobile_quality.site_digest）を足す。
"""
import json
import pathlib
import struct
import sys
import zlib

scripts, site = sys.argv[1], pathlib.Path(sys.argv[2])
sys.path.insert(0, scripts)
import check_mobile_quality  # noqa: E402
import test_check  # noqa: E402


def png(width, height):
    """白一色のPNG（check_mobile_quality が寸法とチャンクを検査するため、置き物ではなく有効な画像にする）"""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    rows = b"".join(b"\0" + b"\xff" * width for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))

site.mkdir(parents=True, exist_ok=True)
test_check.ContentPlanCheckTest("test_valid_content_plan_passes_with_not_run_warning").make_site(site)

review = site.parent / "review"
review.mkdir(exist_ok=True)
(review / "index-mobile-viewport.png").write_bytes(png(390, 844))
(review / "index-mobile-full.png").write_bytes(png(390, 1600))

scores = {"brand_specificity": 17, "visual_hierarchy": 17, "information_design": 17,
          "content_trust": 13, "mobile": 13, "polish": 8}
(site / "quality-review.json").write_text(json.dumps({
    "status": "pass", "site_digest": check_mobile_quality.site_digest(str(site)), "scores": scores, "total": sum(scores.values()), "fatal_issues": [],
    "viewports": [{"width": 1440, "height": 900}, {"width": 390, "height": 844}],
    "page_reviews": [{"file": "index.html", "mobile": {
        "viewport": {"width": 390, "height": 844},
        "evidence": [{"state": "initial_viewport", "screenshot": "../review/index-mobile-viewport.png"},
                     {"state": "full_page", "screenshot": "../review/index-mobile-full.png"}],
        "checks": {"horizontal_overflow": False, "content_overlap": False, "fixed_ui_obscures": False,
                   "duplicate_primary_actions": False, "text_readable": True, "navigation_usable": True,
                   "scan_path_clear": True, "tap_targets_usable": True, "table_content_usable": True},
        "observations": ["横スクロールなし、主要情報を欠落させていない"]}}],
}, ensure_ascii=False), encoding="utf-8")
