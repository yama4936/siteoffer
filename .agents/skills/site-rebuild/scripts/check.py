#!/usr/bin/env python3
"""改善後サイト（静的HTML/CSS）を検査する。

検査内容:
  - 内部リンク・参照ファイルの存在（ページ内アンカーの有無は警告）
  - 先頭スラッシュの絶対パス（サブパス配信で壊れる）
  - 外部リソースの読み込み（script / link / img / source / iframe / video / audio / object / embed、
    CSS の url()・@import の http(s) と //）、計測タグ
  - lang / viewport / title / meta description の欠落、noindex・拡大禁止の有無
  - img の alt、role="img" の aria-label の欠落
  - h1 が1つか、見出し階層の飛び
  - form 要素（サーバー処理を前提にしていないか）
  - 非公式の改善案である旨の表示
  - 営業用HTMLへの内部確認注記の露出（1件でもエラー）
  - design-brief.json / quality-review.json / rebuild.json

使い方:
  python3 check.py reports/sites/<domain>/<date>/site

出力: 標準出力に JSON。errors があれば終了コード1、引数の誤りは2。
Python3 標準ライブラリのみを使う。
"""
import json
import os
import re
import sys
import urllib.parse
from html.parser import HTMLParser

TBC_RE = re.compile(r"【要確認[：:][^】]*】|【要確認】|要確認[：:]|\b(?:TBD|TODO)\b", re.I)
DEMO_WORDS = ("非公式",)
TRACKING_RE = re.compile(
    r"googletagmanager|google-analytics|gtag\(|\bga\(|fbq\(|clarity\.ms|_satellite|hotjar|ptengine", re.I)
CSS_URL_RE = re.compile(r"url\(\s*(['\"]?)([^'\")]+)\1\s*\)", re.I)
CSS_IMPORT_RE = re.compile(r"@import\s+(?:url\()?\s*['\"]?([^'\")\s;]+)", re.I)
# 読み込みを伴わない link の rel
NON_LOADING_RELS = {"canonical", "alternate", "author", "license", "help", "search", "next", "prev", "me"}
RESOURCE_ATTRS = {
    "script": ["src"], "img": ["src", "srcset"], "source": ["src", "srcset"], "iframe": ["src"],
    "video": ["src", "poster"], "audio": ["src"], "track": ["src"], "embed": ["src"],
    "object": ["data"], "input": ["src"],
}


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.lang = None
        self.title = None
        self._in_title = False
        self.meta = {}
        self.refs = []        # (kind, tag, attr, value, line) kind: nav / resource
        self.ids = set()
        self.headings = []    # (level, line)
        self.imgs = []        # (line, has_alt, src)
        self.role_imgs = []   # (line, has_label)
        self.forms = []       # (line, attrs)
        self.inline = []      # (line, text) script/style の中身・style 属性
        self.text = []
        self._script = None
        self._style = None

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v if v is not None else "") for k, v in attrs}
        line = self.getpos()[0]
        if "id" in a:
            self.ids.add(a["id"])
        if tag == "a" and "name" in a:
            self.ids.add(a["name"])
        if tag == "html":
            self.lang = a.get("lang")
        elif tag == "title":
            self._in_title = True
            self.title = self.title or ""
        elif tag == "meta":
            key = (a.get("name") or a.get("property") or "").lower()
            if key:
                self.meta[key] = a.get("content", "")
        elif tag == "a" or tag == "area":
            if "href" in a:
                self.refs.append(("nav", tag, "href", a["href"], line))
        elif tag == "link":
            rels = set(a.get("rel", "").lower().split())
            kind = "nav" if rels and rels <= NON_LOADING_RELS else "resource"
            if "href" in a:
                self.refs.append((kind, tag, "href", a["href"], line))
        elif tag == "form":
            self.forms.append((line, a))
        if tag in RESOURCE_ATTRS:
            for at in RESOURCE_ATTRS[tag]:
                if at in a and a[at]:
                    if at == "srcset":
                        for part in a[at].split(","):
                            u = part.strip().split(" ")[0]
                            if u:
                                self.refs.append(("resource", tag, at, u, line))
                    else:
                        self.refs.append(("resource", tag, at, a[at], line))
        if tag == "img":
            self.imgs.append((line, "alt" in a, a.get("src", "")))
        if a.get("role", "").lower() == "img":
            self.role_imgs.append((line, bool(a.get("aria-label", "").strip() or a.get("aria-labelledby", "").strip())))
        if re.fullmatch(r"h[1-6]", tag):
            self.headings.append((int(tag[1]), line))
        if "style" in a:
            self.inline.append((line, a["style"]))
        if tag == "script":
            self._script = [line, ""]
        elif tag == "style":
            self._style = [line, ""]

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag == "script" and self._script:
            self.inline.append(tuple(self._script))
            self._script = None
        elif tag == "style" and self._style:
            self.inline.append(tuple(self._style))
            self._style = None

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if self._script is not None:
            self._script[1] += data
            return
        if self._style is not None:
            self._style[1] += data
            return
        self.text.append(data)


def classify(url):
    """URL を external / data / special / root_absolute / relative に分ける。"""
    u = url.strip()
    low = u.lower()
    if low.startswith(("http://", "https://")) or u.startswith("//"):
        return "external"
    if low.startswith("data:"):
        return "data"
    if low.startswith(("mailto:", "tel:", "sms:", "javascript:")):
        return "special"
    if u.startswith("#"):
        return "fragment"
    if re.match(r"^[a-z][a-z0-9+.-]*:", low):
        return "other_scheme"
    if u.startswith("/"):
        return "root_absolute"
    return "relative"


class Checker:
    def __init__(self, root):
        self.root = os.path.realpath(root)
        self.errors, self.warnings, self.tbc = [], [], []
        self.pages = {}
        self.anchor_checks = []   # (src_rel, line, target_rel, frag)

    def err(self, f, line, check, msg):
        self.errors.append({"file": f, "line": line, "check": check, "message": msg})

    def warn(self, f, line, check, msg):
        self.warnings.append({"file": f, "line": line, "check": check, "message": msg})

    def rel(self, path):
        return os.path.relpath(path, self.root).replace(os.sep, "/")

    def resolve(self, src_file, url):
        """相対URLをファイルパスに解決する。(path or None, fragment, problem)"""
        parts = urllib.parse.urlsplit(url)
        path = urllib.parse.unquote(parts.path)
        base = os.path.dirname(src_file)
        if not path:
            return src_file, parts.fragment, None
        target = os.path.realpath(os.path.join(base, path))
        if not (target == self.root or target.startswith(self.root + os.sep)):
            return None, parts.fragment, "サイトのディレクトリの外を指している"
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        return target, parts.fragment, None

    def check_ref(self, f, kind, tag, attr, url, line, src_file, is_css=False):
        c = classify(url)
        where = f"<{tag} {attr}=\"{url[:120]}\">" if not is_css else f"url({url[:120]})"
        if c == "external":
            if kind == "resource":
                self.err(f, line, "external_resource", f"外部リソースを読み込んでいる：{where}。自己完結にする")
            elif url.startswith("//"):
                self.warn(f, line, "protocol_relative", f"プロトコル相対URL：{where}。https:// を明記する")
            elif url.lower().startswith("http://"):
                self.warn(f, line, "insecure_link", f"http の外部リンク：{where}")
            return
        if c == "root_absolute":
            self.err(f, line, "root_absolute_path", f"先頭スラッシュの絶対パス：{where}。サブパス配信で壊れるため相対パスにする")
            return
        if c == "special":
            if url.lower().startswith("javascript:"):
                self.warn(f, line, "javascript_url", f"javascript: のリンク：{where}")
            elif url.lower().startswith("tel:") and not re.fullmatch(r"tel:\+?[0-9-]+", url.strip(), re.I):
                self.warn(f, line, "tel_format", f"tel: の形式を確認：{where}")
            return
        if c in ("data", "other_scheme"):
            if c == "other_scheme":
                self.warn(f, line, "other_scheme", f"想定外のスキーム：{where}")
            return
        if c == "fragment":
            frag = url[1:]
            if frag:
                self.anchor_checks.append((f, line, f, frag))
            return
        target, frag, problem = self.resolve(src_file, url)
        if problem:
            self.err(f, line, "broken_link", f"{problem}：{where}")
            return
        if not os.path.isfile(target):
            self.err(f, line, "broken_link", f"リンク先・参照ファイルがない：{where}")
            return
        path_part = urllib.parse.urlsplit(url).path
        if kind == "nav" and (path_part.endswith("/") or path_part in (".", "..")):
            self.warn(f, line, "directory_link", f"ディレクトリ形式のリンク：{where}。file:// でも開けるよう index.html 等のファイル名にする")
        if frag and target.endswith((".html", ".htm")):
            self.anchor_checks.append((f, line, self.rel(target), frag))

    def check_css_text(self, f, line0, text, src_file):
        for m in CSS_URL_RE.finditer(text):
            line = line0 + text.count("\n", 0, m.start())
            self.check_ref(f, "resource", "css", "url", m.group(2), line, src_file, is_css=True)
        for m in CSS_IMPORT_RE.finditer(text):
            u = m.group(1)
            if text[m.start():m.end()].lower().find("url(") >= 0:
                continue  # url() は上で検査済み
            line = line0 + text.count("\n", 0, m.start())
            self.check_ref(f, "resource", "css", "@import", u, line, src_file, is_css=True)

    def scan_tbc(self, f, raw):
        for i, ln in enumerate(raw.splitlines(), 1):
            for m in TBC_RE.finditer(ln):
                self.tbc.append({"file": f, "line": i, "text": m.group(0)})

    def check_html(self, path):
        f = self.rel(path)
        with open(path, encoding="utf-8", errors="replace") as fh:
            raw = fh.read()
        p = Page()
        try:
            p.feed(raw)
            p.close()
        except Exception as e:  # 壊れたHTMLでも検査を続ける
            self.err(f, None, "parse_error", f"HTMLを解析できない：{str(e)[:200]}")
        self.pages[f] = p
        self.scan_tbc(f, raw)

        if not p.lang:
            self.err(f, 1, "lang", "<html lang> がない。lang=\"ja\" を付ける")
        elif not p.lang.lower().startswith("ja"):
            self.warn(f, 1, "lang", f"lang が ja でない：{p.lang}")
        vp = p.meta.get("viewport")
        if vp is None:
            self.err(f, None, "viewport", "meta viewport がない")
        elif re.search(r"user-scalable\s*=\s*(no|0)\b|maximum-scale\s*=\s*(1(\.0+)?|0(\.\d+)?)(?![\d.])", vp, re.I):
            self.err(f, None, "viewport", f"拡大を禁止している：{vp}")
        if not (p.title or "").strip():
            self.err(f, None, "title", "<title> がない、または空")
        if not (p.meta.get("description") or "").strip():
            self.err(f, None, "description", "meta description がない、または空")
        if "noindex" not in (p.meta.get("robots") or "").lower():
            self.warn(f, None, "noindex", "meta robots noindex がない（非公式デモは検索に出さない）")

        for line, has_alt, src in p.imgs:
            if not has_alt:
                self.err(f, line, "img_alt", f"img に alt がない：{src[:120]}")
        for line, has_label in p.role_imgs:
            if not has_label:
                self.err(f, line, "role_img_label", "role=\"img\" の要素に aria-label がない")

        h1 = [ln for lv, ln in p.headings if lv == 1]
        if len(h1) != 1:
            self.err(f, h1[1] if len(h1) > 1 else None, "h1_count", f"h1 が {len(h1)} 個（1つにする）")
        prev = 0
        for lv, ln in p.headings:
            if prev and lv > prev + 1:
                self.warn(f, ln, "heading_skip", f"見出し階層が h{prev} から h{lv} に飛んでいる")
            prev = lv

        for line, a in p.forms:
            action = a.get("action", "").strip()
            method = a.get("method", "get").strip().lower() or "get"
            if action.lower().startswith("mailto:"):
                self.warn(f, line, "form", f"form action が mailto:（{action[:80]}）。リンクに置き換えることを推奨")
            else:
                self.err(f, line, "form",
                         f"form 要素がある（action=\"{action[:120]}\", method={method}）。"
                         "送信にはサーバー処理が必要なため、tel:・mailto:・外部フォームURLへのリンクに置き換える")

        for kind, tag, attr, url, line in p.refs:
            self.check_ref(f, kind, tag, attr, url, line, path)

        for line, text in p.inline:
            if TRACKING_RE.search(text):
                self.err(f, line, "tracking", "計測タグらしき記述がある（デモに計測タグを置かない）")
            self.check_css_text(f, line, text, path)

        body_text = " ".join(p.text)
        if not any(w in body_text for w in DEMO_WORDS):
            self.err(f, None, "demo_notice", "「非公式の改善案（デモ）」である旨の表示がない")

    def check_css(self, path):
        f = self.rel(path)
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        self.check_css_text(f, 1, text, path)

    def check_js(self, path):
        f = self.rel(path)
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        if TRACKING_RE.search(text):
            self.err(f, None, "tracking", "計測タグらしき記述がある")
        for m in re.finditer(r"""(?:fetch|XMLHttpRequest|import)\s*\(\s*['"](https?:)?//""", text):
            self.err(f, text.count("\n", 0, m.start()) + 1, "external_resource", "JS から外部へ通信・読み込みしている")

    def check_rebuild_json(self):
        path = os.path.join(self.root, "rebuild.json")
        f = "rebuild.json"
        if not os.path.isfile(path):
            self.warn(f, None, "rebuild_json", "rebuild.json がない")
            return None
        try:
            with open(path, encoding="utf-8") as fh:
                rb = json.load(fh)
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            self.err(f, None, "rebuild_json", f"JSON として読めない：{e}")
            return None
        for key in ("pages", "actions_applied", "inherited", "needs_confirmation"):
            if key not in rb:
                self.warn(f, None, "rebuild_json", f"{key} がない")
        for pg in rb.get("pages", []) or []:
            name = pg.get("file") if isinstance(pg, dict) else None
            if name and not os.path.isfile(os.path.join(self.root, name)):
                self.err(f, None, "rebuild_json", f"pages に書かれたファイルがない：{name}")
        listed_pages = {pg.get("file") for pg in rb.get("pages", []) or [] if isinstance(pg, dict)}
        for name in self.pages:
            if name not in listed_pages:
                self.warn(f, None, "rebuild_json", f"pages に載っていないページ：{name}")
        check = rb.get("check") if isinstance(rb.get("check"), dict) else {}
        if "quality_status" not in check or "quality_score" not in check:
            self.warn(f, None, "rebuild_json", "check に quality_status / quality_score がない")
        return rb

    def read_json(self, name):
        path = os.path.join(self.root, name)
        if not os.path.isfile(path):
            self.err(name, None, "quality_artifact", f"{name} がない")
            return None
        try:
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            self.err(name, None, "quality_artifact", f"JSON として読めない：{e}")
            return None

    def check_quality_artifacts(self):
        brief = self.read_json("design-brief.json")
        if isinstance(brief, dict):
            for key in ("audience", "primary_action", "brand_traits", "preserve", "change",
                        "visual_direction", "content_strategy", "avoid"):
                if key not in brief or brief[key] in (None, "", []):
                    self.err("design-brief.json", None, "design_brief", f"{key} がない、または空")
            vd = brief.get("visual_direction")
            if isinstance(vd, dict):
                for key in ("style", "hero_layout", "section_rhythm", "signature_motif", "image_strategy"):
                    if not vd.get(key):
                        self.err("design-brief.json", None, "design_brief", f"visual_direction.{key} がない")
            else:
                self.err("design-brief.json", None, "design_brief", "visual_direction がオブジェクトでない")

        review = self.read_json("quality-review.json")
        if not isinstance(review, dict):
            return
        status = review.get("status")
        if status not in ("pass", "needs_revision", "not_run"):
            self.err("quality-review.json", None, "quality_review", "status は pass / needs_revision / not_run")
            return
        if status == "not_run":
            self.warn("quality-review.json", None, "quality_review", "実画面の品質レビューが未実施")
            return
        if status == "needs_revision":
            self.err("quality-review.json", None, "quality_review", "品質レビューに未解決の修正事項がある")
        scores = review.get("scores")
        expected = {
            "brand_specificity": 20, "visual_hierarchy": 20, "information_design": 20,
            "content_trust": 15, "mobile": 15, "polish": 10,
        }
        if not isinstance(scores, dict):
            self.err("quality-review.json", None, "quality_review", "scores がない")
            return
        values = []
        for key, maximum in expected.items():
            value = scores.get(key)
            if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0 or value > maximum:
                self.err("quality-review.json", None, "quality_review", f"scores.{key} は0〜{maximum}")
            else:
                values.append(value)
        total = review.get("total")
        if len(values) == len(expected) and total != sum(values):
            self.err("quality-review.json", None, "quality_review", "total が scores の合計と一致しない")
        fatal = review.get("fatal_issues")
        if not isinstance(fatal, list):
            self.err("quality-review.json", None, "quality_review", "fatal_issues が配列でない")
        if status == "pass" and (not isinstance(total, (int, float)) or isinstance(total, bool) or total < 80):
            self.err("quality-review.json", None, "quality_review", "pass には80点以上が必要")
        if status == "pass" and fatal:
            self.err("quality-review.json", None, "quality_review", "致命項目が残っているため pass にできない")
        viewports = review.get("viewports")
        if not isinstance(viewports, list) or len(viewports) < 2:
            self.err("quality-review.json", None, "quality_review", "PC・スマホのviewportsが必要")
        else:
            widths = {v.get("width") for v in viewports if isinstance(v, dict)}
            if not any(isinstance(w, (int, float)) and w >= 1000 for w in widths):
                self.err("quality-review.json", None, "quality_review", "PC幅のレビューがない")
            if not any(isinstance(w, (int, float)) and w <= 430 for w in widths):
                self.err("quality-review.json", None, "quality_review", "スマホ幅のレビューがない")

    def run(self):
        html, css, js = [], [], []
        for d, dirs, files in os.walk(self.root):
            dirs.sort()
            for name in sorted(files):
                p = os.path.join(d, name)
                low = name.lower()
                if low.endswith((".html", ".htm")):
                    html.append(p)
                elif low.endswith(".css"):
                    css.append(p)
                elif low.endswith((".js", ".mjs")):
                    js.append(p)
        if not os.path.isfile(os.path.join(self.root, "index.html")):
            self.err("index.html", None, "index", "index.html がない")
        for p in html:
            self.check_html(p)
        for p in css:
            self.check_css(p)
        for p in js:
            self.check_js(p)
        for f, line, target, frag in self.anchor_checks:
            page = self.pages.get(target)
            if page is not None and urllib.parse.unquote(frag) not in page.ids:
                self.warn(f, line, "anchor", f"ページ内リンク先 #{frag} が {target} にない")
        for item in self.tbc:
            self.err(item["file"], item["line"], "internal_annotation",
                     f"営業用HTMLに内部確認注記を表示しない：{item['text']}")
        self.check_quality_artifacts()
        self.check_rebuild_json()

        by_text = {}
        for t in self.tbc:
            by_text.setdefault(t["text"], 0)
            by_text[t["text"]] += 1
        return {
            "site": self.root,
            "ok": not self.errors,
            "summary": {"pages": len(html), "css": len(css), "js": len(js),
                        "errors": len(self.errors), "warnings": len(self.warnings),
                        "needs_confirmation": len(self.tbc)},
            "pages": sorted(self.pages),
            "errors": self.errors,
            "warnings": self.warnings,
            "needs_confirmation": {"count": len(self.tbc), "by_text": by_text, "items": self.tbc},
        }


def main():
    if len(sys.argv) != 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__, file=sys.stderr)
        return 2
    root = sys.argv[1]
    if not os.path.isdir(root):
        print(json.dumps({"fatal": f"ディレクトリがない：{root}"}, ensure_ascii=False))
        return 2
    result = Checker(root).run()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
