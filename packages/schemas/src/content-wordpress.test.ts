import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseArticleImport } from "./content-import.ts";

const fixture = readFileSync(new URL("../../../fixtures/content-import/wordpress.xml", import.meta.url), "utf8");
const wrap = (items: string, version = "1.2") =>
  `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:w="http://wordpress.org/export/${version}/" xmlns:c="http://purl.org/rss/1.0/modules/content/"><channel><w:wxr_version>${version}</w:wxr_version>${items}</channel></rss>`;
const item = (fields = "", body = "<p>本文</p>") =>
  `<item><title>見出し</title><link>https://fixture.example.test/news/</link><w:post_type>post</w:post_type><w:status>publish</w:status><w:post_name>hello</w:post_name><w:post_id>12</w:post_id><c:encoded><![CDATA[${body}]]></c:encoded>${fields}</item>`;

it.each(["1.0", "1.1", "1.2"])("reads WXR %s using namespaces independently of prefixes", (version) => {
  const parsed = parseArticleImport(wrap(item(), version), "wordpress", "news");
  expect(parsed.errors).toEqual([]);
  expect(parsed.articles[0]).toMatchObject({ slug: "hello", category: "news", body: "本文" });
});
it("preserves public titles, source URLs and UTC dates, and maps unsupported URL names deterministically", () => {
  const parsed = parseArticleImport(fixture, "wordpress");
  expect(parsed.errors).toEqual([]);
  expect(parsed.articles).toHaveLength(2);
  expect(parsed.articles[0]).toMatchObject({
    slug: "open-house",
    title: "見学会のお知らせ",
    category: "blog",
    originalPublishedAt: "2026-01-14T15:00:00.000Z",
    sourceUrl: "https://wordpress-fixture.example.test/news/open-house/",
  });
  expect(parsed.articles[0]!.body).toContain("[画像の移行確認：見学会の写真]");
  expect(parsed.articles[0]!.body).toContain("https://wordpress-fixture.example.test/details/");
  expect(parsed.articles[1]!.slug).toBe("wp-202");
  expect(parsed.warnings.join(" ")).toContain("1件をwp-投稿ID");
  expect(JSON.stringify(parsed)).not.toContain("private-body");
  expect(JSON.stringify(parsed)).not.toContain("private-title");
  expect(JSON.stringify(parsed)).not.toContain("fixture-author");
});
it.each(["private", "draft", "pending", "future", "trash"])(
  "excludes %s even with valid public-looking metadata",
  (status) => {
    const xml = wrap(item().replace("<w:status>publish</w:status>", `<w:status>${status}</w:status>`));
    const parsed = parseArticleImport(xml, "wordpress");
    expect(parsed.articles).toEqual([]);
    expect(parsed.warnings.join(" ")).toContain("投稿1件は取り込みません");
  },
);
it("excludes password-protected posts without echoing their content or password", () => {
  const parsed = parseArticleImport(
    wrap(item("<w:post_password><![CDATA[fixture-hidden-password]]></w:post_password>", "private-protected-content")),
    "wordpress",
  );
  expect(parsed.articles).toEqual([]);
  expect(JSON.stringify(parsed)).not.toContain("fixture-hidden-password");
  expect(JSON.stringify(parsed)).not.toContain("private-protected-content");
});
it("extracts inert readable text, keeps migration markers, and does not execute embedded HTML", () => {
  const html =
    '<p>A &amp; B<br>次の行</p><script>private-script-body</script><style>private-style</style><form><input value="private-form-value"></form><iframe src="https://invalid.example.test">private-iframe</iframe><a href="javascript:privateScript()">表示文言</a>[contact-form-7 id="12"]';
  const parsed = parseArticleImport(wrap(item("", html)), "wordpress");
  expect(parsed.errors).toEqual([]);
  expect(parsed.articles[0]!.body).toContain("A & B\n次の行");
  expect(parsed.articles[0]!.body).toContain("[フォームの移行確認]");
  expect(parsed.articles[0]!.body).toContain("[埋め込みの移行確認]");
  expect(parsed.articles[0]!.body).toContain('[contact-form-7 id="12"]');
  expect(parsed.articles[0]!.body).not.toMatch(/private-|javascript:/);
});
it.each([
  '<!DOCTYPE rss SYSTEM "https://invalid.example.test/external.dtd">',
  '<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///fixture-not-a-real-file">]>',
  '<!DOCTYPE rss [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;">]>',
])("rejects DTDs without resolving external definitions or echoing input", (dtd) => {
  const parsed = parseArticleImport(wrap(item()).replace("<rss", `${dtd}<rss`), "wordpress");
  expect(parsed.errors[0]!.message).toContain("実体宣言");
  expect(JSON.stringify(parsed)).not.toContain("fixture-not-a-real-file");
});
it.each([
  "<rss><channel></rss>",
  wrap(item()).replace("1.2</w:wxr_version>", "9.9</w:wxr_version>"),
  wrap(item("<w:status>private</w:status>")),
  wrap(item()).replace("<w:post_name>hello</w:post_name>", "<w:post_name>&unknown;</w:post_name>"),
  wrap(item()).replace(
    "<w:status>publish</w:status>",
    '<x:status xmlns:x="http://wordpress.org/export/1.1/">publish</x:status>',
  ),
])("rejects malformed, ambiguous or unsupported WXR", (xml) =>
  expect(parseArticleImport(xml, "wordpress").errors.length).toBeGreaterThan(0),
);
it("requires UTC date validity and keeps unknown dates explicit", () => {
  expect(
    parseArticleImport(wrap(item("<w:post_date_gmt>2026-02-30 10:00:00</w:post_date_gmt>")), "wordpress").errors.length,
  ).toBeGreaterThan(0);
  const p = parseArticleImport(wrap(item("<w:post_date_gmt>0000-00-00 00:00:00</w:post_date_gmt>")), "wordpress");
  expect(p.articles[0]!.originalPublishedAt).toBeNull();
  expect(p.warnings.join(" ")).toContain("掲載日未記録");
});
it("retains relative article links as inert absolute URLs while omitting credentials and unsafe schemes", () => {
  const parsed = parseArticleImport(
    wrap(
      item(
        "",
        '<p><a href="../guide/">案内</a><a href="https://user:fixture@invalid.example.test">資格情報付き</a><a href="data:text/html,fixture">データ</a></p>',
      ),
    ),
    "wordpress",
  );
  expect(parsed.errors).toEqual([]);
  expect(parsed.articles[0]!.body).toContain("https://fixture.example.test/guide/");
  expect(parsed.articles[0]!.body).not.toMatch(/user:fixture|data:text/);
});
it("limits ignored XML items and nodes as well as imported articles", () => {
  const ignored = "<item><w:post_type>attachment</w:post_type></item>";
  expect(parseArticleImport(wrap(ignored.repeat(1001)), "wordpress").errors[0]!.message).toContain("1000件");
  expect(parseArticleImport(wrap("<x/>".repeat(20001)), "wordpress").errors[0]!.message).toContain("構造");
});
it("enforces byte, post-count and XML structural limits before saving partial results", () => {
  expect(
    parseArticleImport(
      wrap(Array.from({ length: 101 }, (_, n) => item().replace("hello", `hello-${n}`)).join("")),
      "wordpress",
    ).errors[0]!.message,
  ).toContain("100件");
  expect(
    parseArticleImport(wrap(`<deep>${"<x>".repeat(70)}${"</x>".repeat(70)}</deep>`), "wordpress").errors[0]!.message,
  ).toContain("構造");
  expect(parseArticleImport(wrap(item("", "あ".repeat(800000))), "wordpress").errors[0]!.message).toContain("2MB");
  expect(parseArticleImport(wrap(item()).replace("UTF-8", "UTF-16"), "wordpress").errors[0]!.message).toContain(
    "UTF-8",
  );
});
