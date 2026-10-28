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
  - 複数ページの固有title・description、トップからの到達性、トップへの戻り道
  - form 要素（サーバー処理を前提にしていないか）
  - 非公式の改善案である旨の表示
  - 営業用HTMLへの内部確認注記の露出（1件でもエラー）
  - content-plan.json / admin-schema.json / design-brief.json / quality-review.json / rebuild.json

使い方:
  python3 check.py reports/sites/<domain>/<date>/site
  python3 check.py --blocked reports/sites/<domain>/<date>/rebuild-blocked.json   # 停止記録の検査

出力: 標準出力に JSON。errors があれば終了コード1、引数の誤りは2。
Python3 標準ライブラリのみを使う。
"""
import json
import os
import re
import sys
import unicodedata
import urllib.parse
from html.parser import HTMLParser

TBC_RE = re.compile(
    r"【要確認[：:][^】]*】|【要確認】|要確認[：:]|\b(?:TBD|TODO)\b|"
    r"(?:サンプル|ダミー|仮)(?:テキスト|文言|文章|コピー|画像)|"
    r"(?:準備中|差し替え予定|Coming\s+Soon|Lorem\s+ipsum)|"
    r"ここに.{0,20}(?:入れ|記載|掲載)",
    re.I,
)
DEMO_WORDS = ("非公式",)
IRRELEVANT_META_COPY_RE = re.compile(
    r"INFORMATION\s+ARCHITECTURE|情報設計|画像だけのメニュー|"
    r"現在のサイト.{0,40}(?:整理|構成|見やす|読みやす)|"
    r"訪問者の目的に沿って整理|"
    r"(?:スマホ|読み上げ).{0,40}(?:見やす|読みやす|伝わる|伝わり|整理|対応)|"
    r"(?:固定幅|フレーム|レスポンシブ|アクセシビリティ).{0,40}(?:構成|対応|改善|変更|使わ)|"
    r"(?:余白|見出し).{0,30}(?:整え|読みやす|見やす)|"
    r"(?:非事実の)?抽象表現です|このデモでは|改善施策を反映",
    re.I,
)
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


def normalize_fact_value(value):
    """表記上の空白・記号・全半角差を除き、重要値の取り違えを検出する。"""
    if not isinstance(value, str):
        return None
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return "".join(char for char in normalized if char.isalnum())


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
        self.field_bindings = set()
        self.image_bindings = set()
        self._script = None
        self._style = None

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v if v is not None else "") for k, v in attrs}
        line = self.getpos()[0]
        if "id" in a:
            self.ids.add(a["id"])
        if a.get("data-siteoffer-field", "").strip():
            self.field_bindings.add(a["data-siteoffer-field"].strip())
        if a.get("data-siteoffer-image", "").strip():
            self.image_bindings.add(a["data-siteoffer-image"].strip())
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
        self.page_edges = {}
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
        meta_copy = IRRELEVANT_META_COPY_RE.search(body_text)
        if meta_copy:
            self.err(
                f, None, "irrelevant_meta_copy",
                f"企業の業務ではなくサイト制作・改善を説明する本文がある：{meta_copy.group(0)[:120]}"
            )

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

    def check_site_navigation(self):
        """ページ固有メタデータと、通常リンクによるサイト内到達性を検査する。"""
        titles = {}
        descriptions = {}
        edges = {name: set() for name in self.pages}
        for name, page in self.pages.items():
            title = " ".join((page.title or "").split()).casefold()
            description = " ".join((page.meta.get("description") or "").split()).casefold()
            if title:
                titles.setdefault(title, []).append(name)
            if description:
                descriptions.setdefault(description, []).append(name)
            src_file = os.path.join(self.root, name)
            for kind, _tag, _attr, url, _line in page.refs:
                if kind != "nav" or classify(url) not in ("relative", "fragment"):
                    continue
                target, _frag, problem = self.resolve(src_file, url)
                if problem or target is None:
                    continue
                target_name = self.rel(target)
                if target_name in self.pages:
                    edges[name].add(target_name)
        self.page_edges = edges

        if len(self.pages) <= 1:
            return
        for label, values in (("title", titles), ("description", descriptions)):
            for files in values.values():
                if len(files) > 1:
                    self.err(
                        files[1], None, "unique_metadata",
                        f"複数ページで同じ{label}を使っている：{sorted(files)}。ページ固有の内容にする",
                    )

        reachable = set()
        pending = ["index.html"] if "index.html" in self.pages else []
        while pending:
            current = pending.pop()
            if current in reachable:
                continue
            reachable.add(current)
            pending.extend(edges.get(current, set()) - reachable)
        missing = sorted(set(self.pages) - reachable)
        if missing:
            self.err(
                "index.html", None, "navigation",
                f"トップから通常のリンクで到達できないHTMLがある：{missing}",
            )
        for name in sorted(set(self.pages) - {"index.html"}):
            if "index.html" not in edges.get(name, set()):
                self.err(name, None, "navigation", "詳細ページから index.html へ戻る通常リンクがない")

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
        for key in ("pages", "actions_applied", "inherited", "needs_confirmation",
                    "content_plan_ref", "content_selection", "admin_schema_ref", "admin_integration"):
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

    def check_content_plan(self):
        plan = self.read_json("content-plan.json", check="content_plan")
        if not isinstance(plan, dict):
            return None
        if plan.get("schema_version") != "0.3":
            self.err("content-plan.json", None, "content_plan", "schema_version は 0.3")
        company = plan.get("company")
        if not isinstance(company, dict) or not company.get("name") or not company.get("source_ref"):
            self.err("content-plan.json", None, "content_plan", "company.name / company.source_ref が必要")
        source_profile = plan.get("source_profile")
        if not isinstance(source_profile, dict):
            self.err("content-plan.json", None, "content_plan", "source_profile がない")
        else:
            for key in ("distinctive_terms", "tone", "content_priorities", "source_refs"):
                if source_profile.get(key) in (None, "", []):
                    self.err("content-plan.json", None, "content_plan", f"source_profile.{key} がない、または空")

        selected = plan.get("selected_content")
        if not isinstance(selected, list) or not selected:
            self.err("content-plan.json", None, "content_plan", "selected_content は1件以上必要")
            selected = []
        seen = set()
        selected_claim_ids = {}
        for index, item in enumerate(selected):
            label = f"selected_content[{index}]"
            if not isinstance(item, dict):
                self.err("content-plan.json", None, "content_plan", f"{label} はオブジェクトでない")
                continue
            item_id = item.get("id")
            if not isinstance(item_id, str) or not item_id.strip():
                self.err("content-plan.json", None, "content_plan", f"{label}.id がない")
            elif item_id in seen:
                self.err("content-plan.json", None, "content_plan", f"id が重複している：{item_id}")
            else:
                seen.add(item_id)
            claim_ids = item.get("claim_ids")
            if not isinstance(claim_ids, list) or not claim_ids or not all(
                    isinstance(claim_id, str) and claim_id.strip() for claim_id in claim_ids):
                self.err("content-plan.json", None, "fact_verification",
                         f"{label}.claim_ids は1件以上のclaim IDにする")
                claim_ids = []
            elif len(claim_ids) != len(set(claim_ids)):
                self.err("content-plan.json", None, "fact_verification",
                         f"{label}.claim_ids が重複している")
            if isinstance(item_id, str) and item_id.strip():
                selected_claim_ids[item_id] = set(claim_ids)
            if item.get("status") != "ready":
                self.err("content-plan.json", None, "content_plan", f"{label}.status は ready にする")
            for key in ("purpose", "selection_reason"):
                if not isinstance(item.get(key), str) or not item[key].strip():
                    self.err("content-plan.json", None, "content_plan", f"{label}.{key} がない、または空")
            copy = item.get("copy")
            if not isinstance(copy, dict) or not copy or not any(
                    isinstance(value, str) and value.strip() for value in copy.values()):
                self.err("content-plan.json", None, "content_plan", f"{label}.copy に完成文がない")
            refs = item.get("source_refs")
            if not isinstance(refs, list) or not refs:
                self.err("content-plan.json", None, "content_plan", f"{label}.source_refs がない")
            else:
                for ref_index, ref in enumerate(refs):
                    if not isinstance(ref, dict) or not ref.get("artifact") or not ref.get("path"):
                        self.err("content-plan.json", None, "content_plan",
                                 f"{label}.source_refs[{ref_index}] に artifact / path が必要")
            placements = item.get("placement")
            if not isinstance(placements, list) or not placements:
                self.err("content-plan.json", None, "content_plan", f"{label}.placement がない")
            else:
                for place_index, place in enumerate(placements):
                    page = place.get("page") if isinstance(place, dict) else None
                    if not page or page not in self.pages:
                        self.err("content-plan.json", None, "content_plan",
                                 f"{label}.placement[{place_index}].page が実在HTMLと一致しない：{page}")
            freshness = item.get("freshness")
            freshness_status = freshness.get("status") if isinstance(freshness, dict) else None
            if freshness_status not in ("current", "timeless"):
                self.err("content-plan.json", None, "content_plan",
                         f"{label}.freshness.status は current / timeless にする")
            if not isinstance(freshness, dict) or not isinstance(freshness.get("basis"), str) or not freshness["basis"].strip():
                self.err("content-plan.json", None, "content_plan", f"{label}.freshness.basis がない")
            fidelity = item.get("source_fidelity")
            if not isinstance(fidelity, dict):
                self.err("content-plan.json", None, "content_plan", f"{label}.source_fidelity がない")
            else:
                if fidelity.get("mode") not in ("verbatim_fact", "faithful_rewrite", "structural_label"):
                    self.err("content-plan.json", None, "content_plan", f"{label}.source_fidelity.mode が不正")
                if not isinstance(fidelity.get("preserved_terms"), list) or not fidelity["preserved_terms"]:
                    self.err("content-plan.json", None, "content_plan", f"{label}.source_fidelity.preserved_terms がない")
                if fidelity.get("meaning_preserved") is not True:
                    self.err("content-plan.json", None, "content_plan", f"{label}.source_fidelity.meaning_preserved は照合後に true にする")
                if not isinstance(fidelity.get("editorial_changes"), str) or not fidelity["editorial_changes"].strip():
                    self.err("content-plan.json", None, "content_plan", f"{label}.source_fidelity.editorial_changes がない")

        source_coverage = plan.get("source_coverage")
        if not isinstance(source_coverage, dict):
            self.err("content-plan.json", None, "content_plan", "source_coverage がない")
        else:
            coverage_status = source_coverage.get("status")
            if coverage_status not in ("complete", "incomplete"):
                self.err("content-plan.json", None, "content_plan", "source_coverage.status が不正")
            for key in ("observed_navigation", "collected_sources", "missing_sources"):
                if not isinstance(source_coverage.get(key), list):
                    self.err("content-plan.json", None, "content_plan", f"source_coverage.{key} は配列にする")
            for key in ("observed_navigation", "collected_sources"):
                if not source_coverage.get(key):
                    self.err("content-plan.json", None, "content_plan", f"source_coverage.{key} は1件以上必要")
            if not isinstance(source_coverage.get("basis"), str) or not source_coverage["basis"].strip():
                self.err("content-plan.json", None, "content_plan", "source_coverage.basis がない")
            if coverage_status == "incomplete":
                self.err("content-plan.json", None, "content_plan", "元サイトの主要情報が未取得のため完成扱いにできない")
            if coverage_status == "complete" and source_coverage.get("missing_sources"):
                self.err("content-plan.json", None, "content_plan", "source_coverage.complete の missing_sources は空にする")

        decision_coverage = plan.get("decision_coverage")
        expected_decisions = {"identity", "offer", "fit", "specifics", "proof", "trust", "action"}
        decision_ids = set()
        decision_statuses = {}
        if not isinstance(decision_coverage, list):
            self.err("content-plan.json", None, "content_plan", "decision_coverage は配列にする")
        else:
            for index, item in enumerate(decision_coverage):
                label = f"decision_coverage[{index}]"
                if not isinstance(item, dict):
                    self.err("content-plan.json", None, "content_plan", f"{label} はオブジェクトでない")
                    continue
                decision_id = item.get("id")
                if decision_id not in expected_decisions or decision_id in decision_ids:
                    self.err("content-plan.json", None, "content_plan", f"{label}.id が不正または重複：{decision_id}")
                else:
                    decision_ids.add(decision_id)
                status = item.get("status")
                if decision_id in expected_decisions:
                    decision_statuses[decision_id] = status
                answered_by = item.get("answered_by")
                if status not in ("answered", "not_applicable", "missing"):
                    self.err("content-plan.json", None, "content_plan", f"{label}.status が不正")
                if not isinstance(answered_by, list):
                    self.err("content-plan.json", None, "content_plan", f"{label}.answered_by は配列にする")
                    answered_by = []
                unknown = [content_id for content_id in answered_by if content_id not in seen]
                if unknown:
                    self.err("content-plan.json", None, "content_plan", f"{label}.answered_by に未定義IDがある：{unknown}")
                if status == "answered" and not answered_by:
                    self.err("content-plan.json", None, "content_plan", f"{label}.answered には answered_by が必要")
                if status == "not_applicable" and (not isinstance(item.get("reason"), str) or not item["reason"].strip()):
                    self.err("content-plan.json", None, "content_plan", f"{label}.not_applicable には理由が必要")
                if status == "missing":
                    self.err("content-plan.json", None, "content_plan", f"{label} が未回答のため完成扱いにできない")
            missing_decisions = expected_decisions - decision_ids
            if missing_decisions:
                self.err("content-plan.json", None, "content_plan", f"decision_coverage に不足がある：{sorted(missing_decisions)}")
            for decision_id in ("identity", "offer", "trust", "action"):
                if decision_statuses.get(decision_id) != "answered":
                    self.err("content-plan.json", None, "content_plan", f"decision_coverage.{decision_id} は answered が必要")

        page_plan = plan.get("page_plan")
        planned_pages = set()
        architecture = plan.get("site_architecture")
        if not isinstance(architecture, dict):
            self.err("content-plan.json", None, "content_plan", "site_architecture がない")
        else:
            mode = architecture.get("mode")
            expected_mode = "single_page" if len(self.pages) == 1 else "multi_page"
            if mode not in ("single_page", "multi_page"):
                self.err("content-plan.json", None, "content_plan", "site_architecture.mode が不正")
            elif mode != expected_mode:
                self.err(
                    "content-plan.json", None, "content_plan",
                    f"site_architecture.mode={mode} とHTML数が一致しない（期待：{expected_mode}）",
                )
            if not isinstance(architecture.get("reason"), str) or not architecture["reason"].strip():
                self.err("content-plan.json", None, "content_plan", "site_architecture.reason がない")
            primary = architecture.get("primary_navigation")
            if not isinstance(primary, list) or not primary:
                self.err("content-plan.json", None, "content_plan", "site_architecture.primary_navigation がない")
                primary = []
            elif len(primary) != len(set(primary)) or "index.html" not in primary or any(
                    not isinstance(name, str) or name not in self.pages for name in primary):
                self.err(
                    "content-plan.json", None, "content_plan",
                    "site_architecture.primary_navigation は重複なく、index.html と実在HTMLだけを持つ",
                )
            for source in self.pages:
                missing_links = [target for target in primary if target != source and target not in self.page_edges.get(source, set())]
                if missing_links:
                    self.err(
                        source, None, "navigation",
                        f"主要ナビゲーションのリンクがページ間で不足している：{missing_links}",
                    )
            if architecture.get("mobile_content_equivalence_reviewed") is not True:
                self.err(
                    "content-plan.json", None, "content_plan",
                    "site_architecture.mobile_content_equivalence_reviewed は実画面確認後に true にする",
                )
        if not isinstance(page_plan, list) or not page_plan:
            self.err("content-plan.json", None, "content_plan", "page_plan は1件以上必要")
        else:
            for index, item in enumerate(page_plan):
                label = f"page_plan[{index}]"
                if not isinstance(item, dict):
                    self.err("content-plan.json", None, "content_plan", f"{label} はオブジェクトでない")
                    continue
                page = item.get("file")
                if not page or page not in self.pages or page in planned_pages:
                    self.err("content-plan.json", None, "content_plan", f"{label}.file が不正・重複・実在HTMLと不一致：{page}")
                else:
                    planned_pages.add(page)
                for key in ("purpose", "reason_separate"):
                    if not isinstance(item.get(key), str) or not item[key].strip():
                        self.err("content-plan.json", None, "content_plan", f"{label}.{key} がない")
                questions = item.get("audience_questions")
                if not isinstance(questions, list) or not questions or any(q not in expected_decisions for q in questions):
                    self.err("content-plan.json", None, "content_plan", f"{label}.audience_questions が不正")
                content_ids = item.get("content_ids")
                if not isinstance(content_ids, list) or not content_ids:
                    self.err("content-plan.json", None, "content_plan", f"{label}.content_ids がない")
                elif any(content_id not in seen for content_id in content_ids):
                    self.err("content-plan.json", None, "content_plan", f"{label}.content_ids に未定義IDがある")
            unplanned_pages = set(self.pages) - planned_pages
            if unplanned_pages:
                self.err("content-plan.json", None, "content_plan", f"page_plan にないHTMLがある：{sorted(unplanned_pages)}")

        media_plan = plan.get("media_plan")
        if not isinstance(media_plan, dict):
            self.err("content-plan.json", None, "content_plan", "media_plan がない")
        else:
            for key in ("usable_assets", "excluded_assets", "missing_essential_assets"):
                if not isinstance(media_plan.get(key), list):
                    self.err("content-plan.json", None, "content_plan", f"media_plan.{key} は配列にする")
            if not isinstance(media_plan.get("notes"), str) or not media_plan["notes"].strip():
                self.err("content-plan.json", None, "content_plan", "media_plan.notes がない")

        update_plan = plan.get("update_plan")
        if not isinstance(update_plan, dict):
            self.err("content-plan.json", None, "content_plan", "update_plan がない")
        else:
            mode = update_plan.get("mode")
            connection_status = update_plan.get("connection_status")
            if mode not in ("article", "fixed_fields_only"):
                self.err("content-plan.json", None, "content_plan", "update_plan.mode が不正")
            if connection_status not in ("planned", "connected_verified"):
                self.err("content-plan.json", None, "content_plan", "update_plan.connection_status が不正")
            for key in ("content_types", "placements"):
                if not isinstance(update_plan.get(key), list):
                    self.err("content-plan.json", None, "content_plan", f"update_plan.{key} は配列にする")
            if not isinstance(update_plan.get("migration_required"), bool):
                self.err("content-plan.json", None, "content_plan", "update_plan.migration_required は真偽値にする")
            if not isinstance(update_plan.get("reason"), str) or not update_plan["reason"].strip():
                self.err("content-plan.json", None, "content_plan", "update_plan.reason がない")
            if mode == "article" and (not update_plan.get("content_types") or not update_plan.get("placements")):
                self.err("content-plan.json", None, "content_plan", "article には記事種別と表示先が必要")

        excluded = plan.get("excluded_content")
        if not isinstance(excluded, list):
            self.err("content-plan.json", None, "content_plan", "excluded_content は配列にする")
        else:
            allowed_reasons = {"unverified", "stale_or_unclear", "rights", "irrelevant", "duplicate", "conflicting"}
            for index, item in enumerate(excluded):
                if not isinstance(item, dict) or not item.get("subject") or item.get("reason") not in allowed_reasons:
                    self.err("content-plan.json", None, "content_plan",
                             f"excluded_content[{index}] に subject と既知の reason が必要")

        source_inventory = plan.get("source_content_inventory")
        source_counts = {key: 0 for key in ("retained", "consolidated", "excluded", "blocked")}
        source_ids = set()
        if not isinstance(source_inventory, list) or not source_inventory:
            self.err("content-plan.json", None, "content_parity", "source_content_inventory は1件以上必要")
            source_inventory = []
        for index, item in enumerate(source_inventory):
            label = f"source_content_inventory[{index}]"
            if not isinstance(item, dict):
                self.err("content-plan.json", None, "content_parity", f"{label} はオブジェクトでない")
                continue
            item_id = item.get("id")
            if not isinstance(item_id, str) or not item_id.strip() or item_id in source_ids:
                self.err("content-plan.json", None, "content_parity", f"{label}.id がない、または重複")
            else:
                source_ids.add(item_id)
            if not item.get("kind") or not item.get("label"):
                self.err("content-plan.json", None, "content_parity", f"{label} に kind / label が必要")
            importance = item.get("importance")
            if importance not in ("essential", "supporting", "optional"):
                self.err("content-plan.json", None, "content_parity", f"{label}.importance が不正")
            refs = item.get("source_refs")
            if not isinstance(refs, list) or not refs or any(
                    not isinstance(ref, dict) or not ref.get("artifact") or not ref.get("path") for ref in refs):
                self.err("content-plan.json", None, "content_parity", f"{label}.source_refs が不正")
            source_length = item.get("source_text_length")
            if source_length is not None and (not isinstance(source_length, int) or isinstance(source_length, bool) or source_length < 0):
                self.err("content-plan.json", None, "content_parity", f"{label}.source_text_length は0以上の整数")
            disposition = item.get("disposition")
            if disposition not in source_counts:
                self.err("content-plan.json", None, "content_parity", f"{label}.disposition が不正")
            else:
                source_counts[disposition] += 1
            target_ids = item.get("target_content_ids")
            target_pages = item.get("target_pages")
            if not isinstance(target_ids, list) or not isinstance(target_pages, list):
                self.err("content-plan.json", None, "content_parity", f"{label} の対応先は配列にする")
                target_ids, target_pages = [], []
            unknown_ids = [target for target in target_ids if target not in seen]
            unknown_pages = [target for target in target_pages if target not in self.pages]
            if unknown_ids or unknown_pages:
                self.err("content-plan.json", None, "content_parity",
                         f"{label} の対応先が存在しない：content={unknown_ids} pages={unknown_pages}")
            if disposition in ("retained", "consolidated") and (not target_ids or not target_pages):
                self.err("content-plan.json", None, "content_parity", f"{label} の保持・統合先がない")
            if not isinstance(item.get("reason"), str) or not item["reason"].strip():
                self.err("content-plan.json", None, "content_parity", f"{label}.reason がない")
            if disposition == "blocked" or (importance == "essential" and disposition == "excluded"):
                self.err("content-plan.json", None, "content_parity", f"{label} の重要情報が改善後サイトで欠落する")

        feature_inventory = plan.get("feature_inventory")
        feature_counts = {key: 0 for key in ("preserved", "replaced", "planned", "out_of_scope", "blocked")}
        feature_ids = set()
        primary_planned = False
        if not isinstance(feature_inventory, list):
            self.err("content-plan.json", None, "feature_parity", "feature_inventory は配列にする")
            feature_inventory = []
        for index, item in enumerate(feature_inventory):
            label = f"feature_inventory[{index}]"
            if not isinstance(item, dict):
                self.err("content-plan.json", None, "feature_parity", f"{label} はオブジェクトでない")
                continue
            item_id = item.get("id")
            if not isinstance(item_id, str) or not item_id.strip() or item_id in feature_ids:
                self.err("content-plan.json", None, "feature_parity", f"{label}.id がない、または重複")
            else:
                feature_ids.add(item_id)
            for key in ("kind", "original_behavior", "target", "user_visible_difference"):
                if not isinstance(item.get(key), str) or not item[key].strip():
                    self.err("content-plan.json", None, "feature_parity", f"{label}.{key} がない")
            importance = item.get("importance")
            if importance not in ("primary", "supporting", "optional"):
                self.err("content-plan.json", None, "feature_parity", f"{label}.importance が不正")
            evidence = item.get("evidence")
            if not isinstance(evidence, list) or not evidence or any(
                    not isinstance(ref, dict) or not ref.get("artifact") or not ref.get("path") for ref in evidence):
                self.err("content-plan.json", None, "feature_parity", f"{label}.evidence が不正")
            target_refs = item.get("target_refs")
            if not isinstance(target_refs, list) or not target_refs:
                self.err("content-plan.json", None, "feature_parity", f"{label}.target_refs がない")
                target_refs = []
            for ref in target_refs:
                artifact = ref.get("artifact") if isinstance(ref, dict) else None
                path = ref.get("path") if isinstance(ref, dict) else None
                if artifact not in ("html", "content-plan.json", "admin-schema.json", "rebuild-scope.json") or not path:
                    self.err("content-plan.json", None, "feature_parity", f"{label}.target_refs が不正")
                elif artifact == "html" and path not in self.pages:
                    self.err("content-plan.json", None, "feature_parity", f"{label} のHTML対応先が存在しない：{path}")
                elif artifact == "content-plan.json" and path not in seen:
                    self.err("content-plan.json", None, "feature_parity", f"{label} のcontent対応先が存在しない：{path}")
            handling = item.get("handling")
            if handling not in feature_counts:
                self.err("content-plan.json", None, "feature_parity", f"{label}.handling が不正")
            else:
                feature_counts[handling] += 1
            verification = item.get("verification_status")
            if verification not in ("verified", "planned", "not_applicable", "unverified", "blocked"):
                self.err("content-plan.json", None, "feature_parity", f"{label}.verification_status が不正")
            if handling in ("preserved", "replaced") and verification != "verified":
                self.err("content-plan.json", None, "feature_parity", f"{label} の保持・置換は verified が必要")
            if handling == "planned" and verification != "planned":
                self.err("content-plan.json", None, "feature_parity", f"{label} の planned と検証状態が一致しない")
            if importance == "primary" and handling in ("out_of_scope", "blocked"):
                self.err("content-plan.json", None, "feature_parity", f"{label} の主要機能が欠落する")
            if importance == "primary" and handling == "planned":
                primary_planned = True

        parity = plan.get("parity_review")
        if not isinstance(parity, dict):
            self.err("content-plan.json", None, "parity_review", "parity_review がない")
        else:
            if parity.get("unaccounted_content_ids") != [] or parity.get("unaccounted_feature_ids") != []:
                self.err("content-plan.json", None, "parity_review", "未対応の情報・機能は0件にする")
            if parity.get("demo_status") != "complete":
                self.err("content-plan.json", None, "parity_review", "demo_status は complete が必要")
            production_status = parity.get("production_status")
            if production_status not in ("equivalent_or_improved", "gaps_remaining"):
                self.err("content-plan.json", None, "parity_review", "production_status が不正")
            info_summary = parity.get("information_summary")
            expected_info = {"source_items": len(source_inventory), **source_counts}
            if info_summary != expected_info:
                self.err("content-plan.json", None, "parity_review",
                         f"information_summary が台帳と一致しない：期待={expected_info}")
            feature_summary = parity.get("feature_summary")
            expected_features = {"source_features": len(feature_inventory), **feature_counts}
            if feature_summary != expected_features:
                self.err("content-plan.json", None, "parity_review",
                         f"feature_summary が台帳と一致しない：期待={expected_features}")
            if not isinstance(parity.get("comparison_notes"), str) or not parity["comparison_notes"].strip():
                self.err("content-plan.json", None, "parity_review", "comparison_notes がない")
            if primary_planned and production_status != "gaps_remaining":
                self.err("content-plan.json", None, "parity_review",
                         "planned の主要機能は production_status=gaps_remaining にする")

        fact_verification = plan.get("fact_verification")
        claim_ids = set()
        claims_by_content = {content_id: set() for content_id in seen}
        identity_claim_found = False
        if not isinstance(fact_verification, dict):
            self.err("content-plan.json", None, "fact_verification", "fact_verification がない")
        else:
            if fact_verification.get("company_identity_checked") is not True:
                self.err("content-plan.json", None, "fact_verification",
                         "company_identity_checked は同名他社・支店を照合後に true にする")
            claims = fact_verification.get("claims")
            if not isinstance(claims, list) or not claims:
                self.err("content-plan.json", None, "fact_verification", "claims は1件以上必要")
                claims = []
            valid_kinds = {"identity", "contact", "service", "price", "credential",
                           "achievement", "date", "condition", "other"}
            valid_surfaces = {"body", "title", "description", "cta", "structured_data"}
            value_kinds = {"identity", "contact", "price", "credential", "achievement",
                           "date", "condition"}
            for index, claim in enumerate(claims):
                label = f"fact_verification.claims[{index}]"
                if not isinstance(claim, dict):
                    self.err("content-plan.json", None, "fact_verification", f"{label} はオブジェクトでない")
                    continue
                claim_id = claim.get("id")
                if not isinstance(claim_id, str) or not claim_id.strip() or claim_id in claim_ids:
                    self.err("content-plan.json", None, "fact_verification",
                             f"{label}.id がない、または重複している")
                else:
                    claim_ids.add(claim_id)
                kind = claim.get("kind")
                if kind not in valid_kinds:
                    self.err("content-plan.json", None, "fact_verification", f"{label}.kind が不正")
                if kind == "identity":
                    identity_claim_found = True
                if not isinstance(claim.get("statement"), str) or not claim["statement"].strip():
                    self.err("content-plan.json", None, "fact_verification", f"{label}.statement がない")
                content_ids = claim.get("content_ids")
                if not isinstance(content_ids, list) or not content_ids:
                    self.err("content-plan.json", None, "fact_verification", f"{label}.content_ids がない")
                    content_ids = []
                elif any(content_id not in seen for content_id in content_ids):
                    self.err("content-plan.json", None, "fact_verification",
                             f"{label}.content_ids に未定義IDがある")
                for content_id in content_ids:
                    if content_id in claims_by_content and isinstance(claim_id, str):
                        claims_by_content[content_id].add(claim_id)
                refs = claim.get("source_refs")
                if not isinstance(refs, list) or not refs:
                    self.err("content-plan.json", None, "fact_verification", f"{label}.source_refs がない")
                else:
                    for ref_index, ref in enumerate(refs):
                        required = ("artifact", "path", "evidence", "observed_at")
                        if not isinstance(ref, dict) or any(not ref.get(key) for key in required):
                            self.err("content-plan.json", None, "fact_verification",
                                     f"{label}.source_refs[{ref_index}] に artifact / path / evidence / observed_at が必要")
                freshness = claim.get("freshness")
                if not isinstance(freshness, dict) or freshness.get("status") not in ("current", "timeless"):
                    self.err("content-plan.json", None, "fact_verification",
                             f"{label}.freshness.status は current / timeless にする")
                if not isinstance(freshness, dict) or not isinstance(freshness.get("basis"), str) or not freshness["basis"].strip():
                    self.err("content-plan.json", None, "fact_verification", f"{label}.freshness.basis がない")
                if claim.get("status") != "verified":
                    self.err("content-plan.json", None, "fact_verification",
                             f"{label}.status は表示前に verified にする")
                if claim.get("conflicts") != []:
                    self.err("content-plan.json", None, "fact_verification",
                             f"{label}.conflicts は完成時に空にする")
                surfaces = claim.get("surfaces")
                if not isinstance(surfaces, list) or not surfaces or any(
                        surface not in valid_surfaces for surface in surfaces):
                    self.err("content-plan.json", None, "fact_verification", f"{label}.surfaces が不正")
                source_value = claim.get("source_value")
                display_value = claim.get("display_value")
                if kind in value_kinds and (not isinstance(source_value, str) or not source_value.strip()
                                            or not isinstance(display_value, str) or not display_value.strip()):
                    self.err("content-plan.json", None, "fact_verification",
                             f"{label} の重要値には source_value / display_value が必要")
                elif source_value is not None or display_value is not None:
                    if normalize_fact_value(source_value) != normalize_fact_value(display_value):
                        self.err("content-plan.json", None, "fact_verification",
                                 f"{label} の重要値が出典と表示で一致しない")
            if not identity_claim_found:
                self.err("content-plan.json", None, "fact_verification", "企業同一性のclaimがない")
            unresolved = fact_verification.get("unresolved_claim_ids")
            if unresolved != []:
                self.err("content-plan.json", None, "fact_verification", "unresolved_claim_ids は完成時に空にする")
            reviewed_surfaces = fact_verification.get("reviewed_surfaces")
            if not isinstance(reviewed_surfaces, list) or set(reviewed_surfaces) != valid_surfaces:
                self.err("content-plan.json", None, "fact_verification",
                         "reviewed_surfaces で body / title / description / cta / structured_data を全て確認する")
            if not fact_verification.get("reviewed_at"):
                self.err("content-plan.json", None, "fact_verification", "reviewed_at がない")

        for content_id in seen:
            declared = selected_claim_ids.get(content_id, set())
            actual = claims_by_content.get(content_id, set())
            unknown = declared - claim_ids
            if unknown:
                self.err("content-plan.json", None, "fact_verification",
                         f"selected_content[{content_id}].claim_ids に未定義IDがある：{sorted(unknown)}")
            if declared != actual:
                self.err("content-plan.json", None, "fact_verification",
                         f"selected_content[{content_id}] とclaimの対応が一致しない")

        review = plan.get("review")
        if not isinstance(review, dict):
            self.err("content-plan.json", None, "content_plan", "review がない")
        else:
            for key in ("visible_claims_traced", "copy_ready", "cta_targets_verified",
                        "source_fidelity_reviewed", "facts_verified", "presentation_ready"):
                if review.get(key) is not True:
                    self.err("content-plan.json", None, "content_plan", f"review.{key} は照合後に true にする")
            if not review.get("reviewed_at"):
                self.err("content-plan.json", None, "content_plan", "review.reviewed_at がない")
        readiness = plan.get("readiness")
        if not isinstance(readiness, dict):
            self.err("content-plan.json", None, "content_plan", "readiness がない")
        else:
            status = readiness.get("status")
            if status not in ("ready_for_customer_review", "incomplete"):
                self.err("content-plan.json", None, "content_plan", "readiness.status が不正")
            blockers = readiness.get("blocking_gaps")
            if not isinstance(blockers, list):
                self.err("content-plan.json", None, "content_plan", "readiness.blocking_gaps は配列にする")
            if status == "incomplete":
                self.err("content-plan.json", None, "content_plan", "元サイトの材料不足により顧客提示可能な完成原稿になっていない")
            if status == "ready_for_customer_review" and blockers:
                self.err("content-plan.json", None, "content_plan", "ready_for_customer_review の blocking_gaps は空にする")
            if not isinstance(readiness.get("production_blockers"), list):
                self.err("content-plan.json", None, "content_plan", "readiness.production_blockers は配列にする")
            elif primary_planned and not readiness.get("production_blockers"):
                self.err("content-plan.json", None, "feature_parity", "planned の主要機能を production_blockers に明記する")
        return plan

    def read_json(self, name, check="quality_artifact"):
        path = os.path.join(self.root, name)
        if not os.path.isfile(path):
            self.err(name, None, check, f"{name} がない")
            return None
        try:
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            self.err(name, None, check, f"JSON として読めない：{e}")
            return None

    def check_admin_schema(self, content_plan):
        schema = self.read_json("admin-schema.json", check="admin_schema")
        if not isinstance(schema, dict):
            return None
        if schema.get("schema_version") != "0.1":
            self.err("admin-schema.json", None, "admin_schema", "schema_version は 0.1")
        if schema.get("integration_status") not in ("planned", "connected_verified"):
            self.err("admin-schema.json", None, "admin_schema", "integration_status が不正")
        if not isinstance(schema.get("company_ref"), str) or not schema["company_ref"].strip():
            self.err("admin-schema.json", None, "admin_schema", "company_ref がない")

        selected_ids = set()
        if isinstance(content_plan, dict):
            selected_ids = {
                item.get("id") for item in content_plan.get("selected_content", [])
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            }
        allowed_types = {"short_text", "long_text", "rich_text", "phone", "email", "url",
                         "hours", "money", "list", "table"}
        declared_fields, declared_images = set(), set()
        all_ids = set()
        fields = schema.get("editable_fields")
        if not isinstance(fields, list) or not fields:
            self.err("admin-schema.json", None, "admin_schema", "editable_fields は1件以上必要")
            fields = []
        for index, item in enumerate(fields):
            label = f"editable_fields[{index}]"
            if not isinstance(item, dict):
                self.err("admin-schema.json", None, "admin_schema", f"{label} はオブジェクトでない")
                continue
            item_id = item.get("id")
            if not isinstance(item_id, str) or not item_id.strip() or item_id in all_ids:
                self.err("admin-schema.json", None, "admin_schema", f"{label}.id がない、または重複")
            else:
                all_ids.add(item_id)
                declared_fields.add(item_id)
            if not item.get("label") or item.get("type") not in allowed_types:
                self.err("admin-schema.json", None, "admin_schema", f"{label} に label と既知の type が必要")
            refs = item.get("source_content_ids")
            if not isinstance(refs, list) or not refs or any(ref not in selected_ids for ref in refs):
                self.err("admin-schema.json", None, "admin_schema", f"{label}.source_content_ids が不正")
            bindings = item.get("bindings")
            if not isinstance(bindings, list) or not bindings or any(
                    not isinstance(binding, dict) or binding.get("page") not in self.pages
                    for binding in bindings):
                self.err("admin-schema.json", None, "admin_schema", f"{label}.bindings が実在HTMLと一致しない")
            if not isinstance(item.get("required"), bool) or not isinstance(item.get("constraints"), dict):
                self.err("admin-schema.json", None, "admin_schema", f"{label} に required / constraints が必要")

        images = schema.get("editable_images")
        if not isinstance(images, list):
            self.err("admin-schema.json", None, "admin_schema", "editable_images は配列にする")
            images = []
        for index, item in enumerate(images):
            label = f"editable_images[{index}]"
            if not isinstance(item, dict):
                self.err("admin-schema.json", None, "admin_schema", f"{label} はオブジェクトでない")
                continue
            item_id = item.get("id")
            if not isinstance(item_id, str) or not item_id.strip() or item_id in all_ids:
                self.err("admin-schema.json", None, "admin_schema", f"{label}.id がない、または重複")
            else:
                all_ids.add(item_id)
                declared_images.add(item_id)
            refs = item.get("source_content_ids")
            if not isinstance(refs, list) or not refs or any(ref not in selected_ids for ref in refs):
                self.err("admin-schema.json", None, "admin_schema", f"{label}.source_content_ids が不正")
            bindings = item.get("bindings")
            if not isinstance(bindings, list) or not bindings or any(
                    not isinstance(binding, dict) or binding.get("page") not in self.pages
                    for binding in bindings):
                self.err("admin-schema.json", None, "admin_schema", f"{label}.bindings が実在HTMLと一致しない")
            if not isinstance(item.get("alt_required"), bool) or not isinstance(item.get("allowed_uses"), list):
                self.err("admin-schema.json", None, "admin_schema", f"{label} に alt_required / allowed_uses が必要")

        actual_fields = set().union(*(page.field_bindings for page in self.pages.values()))
        actual_images = set().union(*(page.image_bindings for page in self.pages.values()))
        if actual_fields != declared_fields:
            self.err("admin-schema.json", None, "admin_schema",
                     f"固定項目のHTML bindingと定義が一致しない：HTML={sorted(actual_fields)} schema={sorted(declared_fields)}")
        if actual_images != declared_images:
            self.err("admin-schema.json", None, "admin_schema",
                     f"画像のHTML bindingと定義が一致しない：HTML={sorted(actual_images)} schema={sorted(declared_images)}")

        articles = schema.get("articles")
        if not isinstance(articles, dict) or not isinstance(articles.get("enabled"), bool):
            self.err("admin-schema.json", None, "admin_schema", "articles.enabled が必要")
        elif articles["enabled"]:
            if not isinstance(articles.get("types"), list) or not articles["types"]:
                self.err("admin-schema.json", None, "admin_schema", "有効なarticlesにはtypesが必要")
            placements = articles.get("list_placements")
            if not isinstance(placements, list) or not placements or any(
                    not isinstance(place, dict) or place.get("page") not in self.pages for place in placements):
                self.err("admin-schema.json", None, "admin_schema", "有効なarticlesには実在ページのlist_placementsが必要")

        form = schema.get("inquiry_form")
        if not isinstance(form, dict) or form.get("enabled") is not True:
            self.err("admin-schema.json", None, "admin_schema", "全プラン標準のinquiry_form.enabled は true")
        else:
            if not form.get("form_id") or form.get("display_page") not in self.pages:
                self.err("admin-schema.json", None, "admin_schema", "inquiry_form のIDまたは表示ページが不正")
            form_fields = form.get("fields")
            if not isinstance(form_fields, list) or not form_fields:
                self.err("admin-schema.json", None, "admin_schema", "inquiry_form.fields がない")
                form_fields = []
            allowed_form_types = {"text", "email", "tel", "textarea", "select", "checkbox", "consent"}
            form_ids = set()
            for index, field in enumerate(form_fields):
                label = f"inquiry_form.fields[{index}]"
                if not isinstance(field, dict):
                    self.err("admin-schema.json", None, "admin_schema", f"{label} はオブジェクトでない")
                    continue
                field_id = field.get("id")
                if not isinstance(field_id, str) or not field_id or field_id in form_ids:
                    self.err("admin-schema.json", None, "admin_schema", f"{label}.id がない、または重複")
                else:
                    form_ids.add(field_id)
                if not field.get("label") or field.get("type") not in allowed_form_types:
                    self.err("admin-schema.json", None, "admin_schema", f"{label} に label と既知の type が必要")
                if not isinstance(field.get("required"), bool):
                    self.err("admin-schema.json", None, "admin_schema", f"{label}.required は真偽値にする")
            consent = [field for field in form_fields if isinstance(field, dict) and field.get("type") == "consent"]
            if not consent or not any(field.get("required") is True for field in consent):
                self.err("admin-schema.json", None, "admin_schema", "必須の個人情報同意欄がない")
            for key, expected in (("store_in_siteoffer", True), ("customer_inbox", True),
                                  ("email_notification", True), ("status_management", False),
                                  ("privacy_notice_required", True)):
                if form.get(key) is not expected:
                    self.err("admin-schema.json", None, "admin_schema", f"inquiry_form.{key} は {expected}")
            if not isinstance(form.get("spam_controls"), list) or not form["spam_controls"]:
                self.err("admin-schema.json", None, "admin_schema", "inquiry_form.spam_controls がない")
        return schema

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
        self.check_site_navigation()
        for f, line, target, frag in self.anchor_checks:
            page = self.pages.get(target)
            if page is not None and urllib.parse.unquote(frag) not in page.ids:
                self.warn(f, line, "anchor", f"ページ内リンク先 #{frag} が {target} にない")
        for item in self.tbc:
            self.err(item["file"], item["line"], "internal_annotation",
                     f"営業用HTMLに内部確認注記を表示しない：{item['text']}")
        content_plan = self.check_content_plan()
        admin_schema = self.check_admin_schema(content_plan)
        self.check_quality_artifacts()
        rebuild = self.check_rebuild_json()
        if isinstance(content_plan, dict) and isinstance(rebuild, dict):
            selection = rebuild.get("content_selection")
            if isinstance(selection, dict):
                selected_count = len(content_plan.get("selected_content") or [])
                excluded_count = len(content_plan.get("excluded_content") or [])
                if selection.get("selected_count") != selected_count:
                    self.err("rebuild.json", None, "content_plan", "content_selection.selected_count が content-plan.json と一致しない")
                if selection.get("excluded_count") != excluded_count:
                    self.err("rebuild.json", None, "content_plan", "content_selection.excluded_count が content-plan.json と一致しない")
                if selection.get("visible_claims_traced") is not True:
                    self.err("rebuild.json", None, "content_plan", "content_selection.visible_claims_traced は照合後に true にする")
        if isinstance(admin_schema, dict) and isinstance(rebuild, dict):
            integration = rebuild.get("admin_integration")
            if not isinstance(integration, dict):
                self.err("rebuild.json", None, "admin_schema", "admin_integration がない")
            else:
                expected_admin = {
                    "status": admin_schema.get("integration_status"),
                    "editable_fields": len(admin_schema.get("editable_fields") or []),
                    "editable_images": len(admin_schema.get("editable_images") or []),
                    "article_types": len((admin_schema.get("articles") or {}).get("types") or []),
                    "inquiry_form": (admin_schema.get("inquiry_form") or {}).get("enabled") is True,
                }
                for key, expected in expected_admin.items():
                    if integration.get(key) != expected:
                        self.err("rebuild.json", None, "admin_schema",
                                 f"admin_integration.{key} が admin-schema.json の要約と一致しない")
        if isinstance(admin_schema, dict) and isinstance(content_plan, dict):
            update_mode = (content_plan.get("update_plan") or {}).get("mode")
            articles_enabled = (admin_schema.get("articles") or {}).get("enabled") is True
            if (update_mode == "article") != articles_enabled:
                self.err("admin-schema.json", None, "admin_schema", "content-plan.json の update_plan と articles.enabled が一致しない")

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


DECISION_IDS = ("identity", "offer", "fit", "specifics", "proof", "trust", "action")


def check_blocked(path):
    """取得網羅性・完成原稿の材料不足で止めたときの rebuild-blocked.json を検査する。"""
    errors = []

    def err(msg):
        errors.append({"file": "rebuild-blocked.json", "line": None, "code": "blocked", "message": msg})

    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        return {"fatal": f"rebuild-blocked.json を読めない：{e}"}, 2
    if not isinstance(data, dict):
        data = {}
        err("JSONオブジェクトにする")
    if data.get("status") != "blocked":
        err("status は blocked")
    if data.get("stage") not in ("source_coverage", "content_readiness"):
        err("stage は source_coverage か content_readiness")
    if not isinstance(data.get("checked_at"), str) or not data["checked_at"].strip():
        err("checked_at がない")
    missing = data.get("missing_sources")
    if not isinstance(missing, list) or not missing:
        err("missing_sources は1件以上の配列にする")
        missing = []
    for i, m in enumerate(missing):
        if not isinstance(m, dict):
            err(f"missing_sources[{i}] はオブジェクトにする")
            continue
        for key in ("label", "found_in", "reason"):
            if not isinstance(m.get(key), str) or not m[key].strip():
                err(f"missing_sources[{i}].{key} がない")
        if m.get("url") is not None and not (isinstance(m["url"], str) and re.match(r"https?://", m["url"])):
            err(f"missing_sources[{i}].url は http(s) のURLか null")
        for q in m.get("needed_for") or []:
            if q not in DECISION_IDS:
                err(f"missing_sources[{i}].needed_for に不明な判断項目：{q}")
    gaps = data.get("blocking_gaps")
    if not isinstance(gaps, list):
        err("blocking_gaps は配列にする")
        gaps = []
    for i, g in enumerate(gaps):
        if not isinstance(g, dict) or g.get("question") not in DECISION_IDS or not str(g.get("reason") or "").strip():
            err(f"blocking_gaps[{i}] は判断項目IDの question と reason を持つ")
    actions = data.get("next_actions")
    if not isinstance(actions, list) or not actions:
        err("next_actions は1件以上の配列にする")
        actions = []
    for i, a in enumerate(actions):
        kind = a.get("action") if isinstance(a, dict) else None
        if kind not in ("collect_add_url", "customer_confirmation"):
            err(f"next_actions[{i}].action は collect_add_url か customer_confirmation")
        elif kind == "collect_add_url" and not (isinstance(a.get("urls"), list) and a["urls"]):
            err(f"next_actions[{i}] の collect_add_url には urls が必要")
    site = os.path.join(os.path.dirname(os.path.abspath(path)), "site")
    if os.path.isdir(site):
        err("停止時は site/ を残さない（作りかけの HTML・content-plan.json を削除する）")
    result = {"blocked": path, "ok": not errors,
              "summary": {"errors": len(errors), "missing_sources": len(missing), "blocking_gaps": len(gaps)},
              "errors": errors}
    return result, (0 if not errors else 1)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--blocked":
        result, code = check_blocked(sys.argv[2])
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return code
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
