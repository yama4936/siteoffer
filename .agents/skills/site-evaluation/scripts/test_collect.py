#!/usr/bin/env python3
"""collect.py のページ選択と追記モードを、ネットワークなしで回帰テストする。"""

import argparse
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import collect  # noqa: E402


def link(href, text=""):
    return {"href": href, "text": text, "kind": "web"}


TOP = {
    "url": "https://example.co.jp/",
    "final_url": "https://example.co.jp/",
    "internal_links": [
        link("https://example.co.jp/", "HOME"),
        link("https://example.co.jp/index.html", "トップ"),
        link("https://example.co.jp/company/", "会社概要"),
        link("https://example.co.jp/works/", "施工実績"),
        link("https://example.co.jp/products/", "商品紹介"),
        link("https://example.co.jp/access/", "アクセス"),
        link("https://example.co.jp/works/#top", "施工実績"),
        link("https://example.co.jp/catalog.pdf", "カタログ"),
    ],
}


class PickPagesTest(unittest.TestCase):
    def test_menu_pages_fill_after_kind_pages(self):
        picked = collect.pick_pages(TOP, 15)
        urls = [u for _, u in picked]
        self.assertEqual(picked[0], ("company", "https://example.co.jp/company/"))
        self.assertIn("https://example.co.jp/access/", urls)
        self.assertIn("https://example.co.jp/products/", urls)
        self.assertNotIn("https://example.co.jp/catalog.pdf", urls)
        self.assertNotIn("https://example.co.jp/index.html", urls)
        self.assertEqual(len(urls), len({collect.page_key(u) for u in urls}))

    def test_limit_counts_top_page(self):
        self.assertEqual(len(collect.pick_pages(TOP, 3)), 2)

    def test_children_follow_path(self):
        works = {"url": "https://example.co.jp/works/", "final_url": "https://example.co.jp/works/"}
        links = [(u, link(u)) for u in (
            "https://example.co.jp/works/house/",
            "https://example.co.jp/works/shop/",
            "https://example.co.jp/blog/1",
            "https://example.co.jp/works/house/")]
        seen = {collect.page_key("https://example.co.jp/works/")}
        got = collect.pick_children([(works, links)], seen, 5)
        self.assertEqual([u for _, u in got],
                         ["https://example.co.jp/works/house/", "https://example.co.jp/works/shop/"])
        self.assertEqual(len(collect.pick_children([(works, links)], set(), 1)), 1)


class FakeFetcher:
    def __init__(self):
        self.calls = []

    def allowed(self, url):
        return True

    def raw(self, url, method="GET", max_bytes=5_000_000):
        self.calls.append(url)
        body = ("<html><head><title>流れ</title></head><body><h1>ご利用の流れ</h1><p>" + "あ" * 50 +
                '</p><a href="/works/1.html">事例1</a><a href="/catalog.pdf">PDF</a></body></html>')
        return 200, body.encode("utf-8"), {"final_url": url, "headers": {"content-type": "text/html; charset=utf-8"}}


class AddPagesTest(unittest.TestCase):
    def test_appends_body_without_refetching(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp)
            (out / "collected.json").write_text(json.dumps({
                "target_url": "https://example.co.jp/",
                "site": {"final_url": "https://example.co.jp/"},
                "pages": [{"url": "https://example.co.jp/", "final_url": "https://example.co.jp/", "role": "top"}],
            }), encoding="utf-8")
            fetcher = FakeFetcher()
            a = argparse.Namespace(out=str(out), url="https://example.co.jp/", reason="B3の根拠",
                                   add_url=["https://example.co.jp/flow/", "https://example.co.jp/",
                                            "https://other.example/flow/"])
            self.assertEqual(collect.add_pages(a, fetcher, 10), 0)
            data = json.loads((out / "collected.json").read_text(encoding="utf-8"))
            self.assertEqual(fetcher.calls, ["https://example.co.jp/flow/"])
            added = data["pages"][-1]
            self.assertEqual(added["role"], "additional")
            self.assertEqual(added["added_reason"], "B3の根拠")
            self.assertEqual(len(added["text_excerpt"]), 10)
            self.assertTrue(added["text_truncated"])
            self.assertEqual(added["page_links"], [{"href": "https://example.co.jp/works/1.html", "text": "事例1"}])
            self.assertNotIn("internal_links", added)
            results = data["additional_collections"][0]["results"]
            self.assertEqual([r.get("skipped") for r in results], [None, "already_collected", "other_host"])

    def test_missing_collected_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = argparse.Namespace(out=tmp, url="https://example.co.jp/", reason="", add_url=["https://example.co.jp/a"])
            self.assertEqual(collect.add_pages(a, FakeFetcher(), 10), 2)


if __name__ == "__main__":
    unittest.main()
