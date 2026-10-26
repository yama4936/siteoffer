import { type DefaultTreeAdapterMap, parseFragment } from "parse5";
import { SaxesParser, type SaxesTagNS } from "saxes";

const WP = /^http:\/\/wordpress\.org\/export\/1\.[012]\/$/;
const CONTENT = "http://purl.org/rss/1.0/modules/content/";
const FIELDS = new Set(["post_id", "post_name", "post_type", "status", "post_password", "post_date_gmt"]);
class WordPressImportError extends Error {}
const fail = (message: string): never => {
  throw new WordPressImportError(message);
};

/** No requests, DTDs or entity declarations. Namespace URIs, not user-chosen prefixes, identify WXR fields. */
export function readWordPressImport(text: string, category: "news" | "blog") {
  const items: Map<string, string>[] = [],
    stack: SaxesTagNS[] = [],
    namespaces = new Set<string>();
  const parser = new SaxesParser({ xmlns: true });
  let current: Map<string, string> | null = null,
    field: { key: string; depth: number; value: string } | null = null,
    version = "",
    versionUri = "",
    versionCount = 0,
    nodes = 0;
  parser.on("error", () => fail("WordPress XMLを読み込めません。書き出し直したUTF-8のWXRファイルを選んでください"));
  parser.on("doctype", () => fail("外部定義・実体宣言を含むXMLは取り込めません"));
  parser.on("xmldecl", (decl) => {
    if (decl.encoding && !/^utf-?8$/i.test(decl.encoding)) fail("XMLはUTF-8で書き出してください");
  });
  parser.on("opentag", (tag) => {
    if (++nodes > 20_000 || stack.length >= 64) fail("XMLの構造が大きすぎます。投稿を分割して書き出してください");
    if (field) fail("WordPress XMLの記事項目に不正な入れ子があります");
    stack.push(tag);
    const depth = stack.length;
    if (depth === 1 && (tag.local !== "rss" || tag.uri !== "")) fail("WordPressのWXRファイルを選んでください");
    if (depth === 2 && (tag.local !== "channel" || tag.uri !== "")) fail("WordPressのWXRファイルを選んでください");
    if (depth === 3 && tag.local === "wxr_version" && WP.test(tag.uri)) {
      versionCount++;
      versionUri = tag.uri;
      field = { key: "version", depth, value: "" };
    }
    if (depth === 3 && tag.local === "item" && tag.uri === "") {
      if (items.length >= 1000) fail("XMLの項目が1000件を超えています。投稿だけを分割して書き出してください");
      current = new Map();
    }
    if (!current || depth !== 4) return;
    let key = "";
    if (WP.test(tag.uri) && FIELDS.has(tag.local)) {
      key = tag.local;
      namespaces.add(tag.uri);
    } else if (tag.uri === CONTENT && tag.local === "encoded") key = "body";
    else if (tag.uri === "" && ["title", "link"].includes(tag.local)) key = tag.local;
    if (!key) return;
    if (current.has(key)) fail("同じ記事項目が重複しています。WordPressから書き出し直してください");
    field = { key, depth, value: "" };
  });
  const content = (value: string) => {
    if (!field) return;
    // A password's presence is enough; never retain its value in the parsed result.
    if (field.key === "post_password") {
      if (value.length) field.value = "present";
    } else field.value += value;
  };
  parser.on("text", content);
  parser.on("cdata", content);
  parser.on("closetag", () => {
    if (field?.depth === stack.length) {
      if (field.key === "version") version = field.value.trim();
      else current!.set(field.key, field.value);
      field = null;
    }
    if (stack.length === 3 && current) {
      items.push(current);
      current = null;
    }
    stack.pop();
  });
  parser.write(text).close();
  if (
    versionCount !== 1 ||
    !["1.0", "1.1", "1.2"].includes(version) ||
    !versionUri.endsWith(`/${version}/`) ||
    [...namespaces].some((uri) => uri !== versionUri)
  )
    fail("対応するWordPress WXR 1.0〜1.2の書き出しを選んでください");

  let skippedType = 0,
    skippedPrivate = 0,
    renamed = 0,
    missingDates = 0;
  const articles: Record<string, unknown>[] = [];
  for (const item of items) {
    if (item.get("post_type")?.trim() !== "post") {
      skippedType++;
      continue;
    }
    if (item.get("status")?.trim() !== "publish" || item.get("post_password")) {
      skippedPrivate++;
      continue;
    }
    let slug = item.get("post_name")?.trim() ?? "";
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) {
      const id = item.get("post_id")?.trim() ?? "";
      if (!/^[1-9]\d{0,19}$/.test(id))
        fail("URL名を変換できない投稿があります。WordPressの投稿IDか半角のURL名を確認してください");
      slug = `wp-${id}`;
      renamed++;
    }
    const gmt = item.get("post_date_gmt")?.trim() ?? "";
    let originalPublishedAt: string | null = null;
    if (gmt && gmt !== "0000-00-00 00:00:00") {
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(gmt)) fail("元の掲載日時を読み取れない投稿があります");
      originalPublishedAt = `${gmt.replace(" ", "T")}Z`;
    } else missingDates++;
    articles.push({
      slug,
      title: item.get("title") ?? "",
      body: wordPressBodyText(item.get("body") ?? "", item.get("link")?.trim()),
      category,
      sourceUrl: item.get("link")?.trim() || null,
      originalPublishedAt,
    });
    if (articles.length > 100)
      fail("一度に取り込める公開投稿は100件までです。WordPressで期間を分けて書き出してください");
  }
  const warnings = [
    `WordPressの公開投稿${articles.length}件を${category === "news" ? "お知らせ" : "ブログ"}の下書きとして取り込みます。元の公開状態は引き継ぎません。`,
    "本文はテキストへ変換します。装飾・カテゴリ分け・コメント・作者・カスタム項目は引き継ぎません。画像・添付・埋め込み・フォーム・ショートコードは別途確認してください。外部ファイルは取得しません。本文内のHTTP(S)リンクは文字として保存します。",
  ];
  if (skippedType)
    warnings.push(`固定ページ・添付・カスタム投稿など${skippedType}件は対象外です。必要な情報は別途移行してください。`);
  if (skippedPrivate)
    warnings.push(`非公開・下書き・予約・パスワード付きなどの投稿${skippedPrivate}件は取り込みません。`);
  if (renamed)
    warnings.push(
      `日本語などのURL名${renamed}件をwp-投稿IDへ変換しました。元記事URLを保持し、旧URLの対応表で確認できます。`,
    );
  if (missingDates) warnings.push(`元のUTC掲載日時がない投稿${missingDates}件は掲載日未記録になります。`);
  return { articles, warnings };
}

/** parse5 parses inert HTML; it never executes scripts or fetches media. Only readable text is returned. */
function wordPressBodyText(html: string, sourceUrl?: string) {
  type Node = DefaultTreeAdapterMap["node"];
  const root = parseFragment(html),
    output: string[] = [],
    pending: { node: Node; exit?: boolean }[] = [{ node: root }];
  const blocks = new Set([
    "p",
    "div",
    "section",
    "article",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "table",
    "tr",
  ]);
  let visited = 0;
  while (pending.length) {
    const { node, exit } = pending.pop()!;
    if (++visited > 50_000) fail("本文の構造が大きすぎる投稿があります。本文を分割して確認してください");
    if (node.nodeName === "#text") {
      output.push((node as DefaultTreeAdapterMap["textNode"]).value);
      continue;
    }
    if (!("childNodes" in node)) continue;
    const tag = "tagName" in node ? node.tagName : "";
    if (exit) {
      if (tag === "a" && "attrs" in node) {
        const href = node.attrs.find((a) => a.name === "href")?.value;
        if (href) {
          try {
            const url = new URL(href, sourceUrl || undefined);
            if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password)
              output.push(` (${url.href})`);
          } catch {
            /* Invalid links are never made executable. */
          }
        }
      }
      if (blocks.has(tag)) output.push("\n");
      continue;
    }
    if (["script", "style", "template", "noscript", "head"].includes(tag)) continue;
    if (tag === "img") {
      const alt = "attrs" in node ? node.attrs.find((a) => a.name === "alt")?.value : undefined;
      output.push(`\n[画像の移行確認${alt ? `：${alt}` : ""}]\n`);
      continue;
    }
    if (["iframe", "embed", "object", "video", "audio", "form"].includes(tag)) {
      output.push(`\n[${tag === "form" ? "フォーム" : "埋め込み"}の移行確認]\n`);
      continue;
    }
    if (tag === "br" || tag === "hr") output.push("\n");
    if (blocks.has(tag)) {
      output.push("\n");
      if (tag === "li") output.push("・");
    }
    pending.push({ node, exit: true });
    for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push({ node: node.childNodes[i]! });
  }
  return output
    .join("")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
