import { z } from "zod";
export const ARTICLE_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const ARTICLE_IMPORT_MAX_ROWS = 100;
export const ARTICLE_IMPORT_TEMPLATE =
  'slug,title,body,category,sourceUrl,originalPublishedAt\r\nopening,営業日のお知らせ,"平素よりありがとうございます。\r\n営業時間をご案内します。",news,https://example.test/news/opening,2026-01-15\r\n';
const date = z
  .string()
  .trim()
  .refine((value) => {
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return false;
    const day = value.slice(0, 10),
      d = new Date(`${day}T00:00:00Z`);
    return Number.isFinite(Date.parse(value)) && Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === day;
  }, "元の掲載日はYYYY-MM-DDまたは時差付きISO日時で入力してください")
  .transform((value) => new Date(value).toISOString());
const url = z
  .string()
  .trim()
  .max(2048)
  .pipe(z.url({ protocol: /^https?$/ }))
  .refine((v) => !/^https?:\/\/[^/]*@/i.test(v), "元記事URLに認証情報を含めないでください");
function utf8Length(text: string) {
  let n = 0;
  for (const c of text) {
    const code = c.codePointAt(0)!;
    n += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  return n;
}
export const importedArticleSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,79}$/, "URL名は半角英数字・ハイフンで80文字以内です"),
  title: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .refine((v) => !v.includes(String.fromCharCode(0))),
  body: z
    .string()
    .trim()
    .min(1)
    .max(30000)
    .refine((v) => !v.includes(String.fromCharCode(0))),
  category: z.enum(["news", "blog"]),
  sourceUrl: url.nullable(),
  originalPublishedAt: date.nullable(),
});
export type ImportedArticle = z.infer<typeof importedArticleSchema>;
export type ArticleImportSource = { companyId: string; format: "csv" | "json"; fileName: string; text: string };
export const articleImportSourceSchema = z.strictObject({
  companyId: z.string().uuid().toLowerCase(),
  format: z.enum(["csv", "json"]),
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((v) => [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)),
  text: z.string().max(ARTICLE_IMPORT_MAX_BYTES),
});
export type ParsedArticleImport = {
  articles: ImportedArticle[];
  errors: { row: number; message: string }[];
  warnings: string[];
  exportedCompanyId: string | null;
};
/** UTF-8 CSV。引用符内のカンマ・改行・二重引用符を保持し、不正な閉じ方は拒否する。 */
function csv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  const cell = () => {
    row.push(field);
    field = "";
    closed = false;
  };
  const line = () => {
    cell();
    rows.push(row);
    row = [];
    if (rows.length > ARTICLE_IMPORT_MAX_ROWS + 1) throw Error("一度に取り込める記事は100件までです");
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
      continue;
    }
    if (c === ",") {
      cell();
      continue;
    }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      line();
      continue;
    }
    if (closed) throw Error("CSVの閉じ引用符の後にはカンマか改行が必要です");
    if (c === '"') {
      if (field.length) throw Error("CSVの引用符は項目の先頭に置いてください");
      quoted = true;
    } else field += c;
  }
  if (quoted) throw Error("CSVの引用符が閉じていません");
  if (field.length || row.length || closed) line();
  return rows;
}
export function parseArticleImport(text: string, format: "csv" | "json"): ParsedArticleImport {
  const result: ParsedArticleImport = { articles: [], errors: [], warnings: [], exportedCompanyId: null };
  if (utf8Length(text) > ARTICLE_IMPORT_MAX_BYTES) {
    result.errors.push({ row: 0, message: "ファイルは2MB以内にしてください" });
    return result;
  }
  text = text.replace(/^\uFEFF/, "");
  try {
    let raw: unknown[] = [];
    if (format === "csv") {
      const rows = csv(text),
        headers = rows.shift()?.map((h) => h.trim()) ?? [];
      const allowed = ["slug", "title", "body", "category", "sourceUrl", "originalPublishedAt"];
      if (
        ["slug", "title", "body", "category"].some((h) => !headers.includes(h)) ||
        new Set(headers).size !== headers.length ||
        headers.some((h) => !allowed.includes(h))
      )
        throw Error("CSVの列名をテンプレートに合わせてください。必須：slug,title,body,category");
      raw = rows
        .filter((r) => r.some((v) => v.trim()))
        .map((r, i) => {
          if (r.length !== headers.length) throw Error(`CSVの${i + 2}行目で列数が一致しません`);
          return Object.fromEntries(headers.map((h, n) => [h, r[n]]));
        });
    } else {
      const data: unknown = JSON.parse(text);
      if (Array.isArray(data)) raw = data;
      else if (
        data &&
        typeof data === "object" &&
        "schemaVersion" in data &&
        data.schemaVersion === 1 &&
        "articles" in data &&
        Array.isArray(data.articles)
      ) {
        if (
          !("companyId" in data) ||
          typeof data.companyId !== "string" ||
          !z.string().uuid().safeParse(data.companyId).success
        )
          throw Error("書き出しデータの企業IDが不正です");
        result.exportedCompanyId = data.companyId.toLowerCase();
        raw = data.articles.map((a) => {
          if (!a || typeof a !== "object" || !Array.isArray(a.revisions) || !Number.isInteger(a.currentRevision))
            throw Error("書き出しデータの版情報が不正です");
          if (
            a.revisions.some(
              (r: unknown) => !r || typeof r !== "object" || !("revision" in r) || !Number.isInteger(r.revision),
            )
          )
            throw Error("書き出しデータの版情報が不正です");
          const matching = a.revisions.filter((r: Record<string, unknown>) => r.revision === a.currentRevision);
          if (matching.length !== 1) throw Error("現在の下書き版が見つからない記事があります");
          return {
            ...matching[0],
            slug: a.slug,
            sourceUrl: a.sourceUrl,
            originalPublishedAt: a.originalPublishedAt ?? a.publishedAt,
          };
        });
        result.warnings.push("書き出しの現在の下書き版を取り込みます。過去の版・掲載設定は取り込みません。");
      } else throw Error("JSONは記事の配列、またはSiteOfferの記事書き出し形式にしてください");
    }
    if (!raw.length || raw.length > ARTICLE_IMPORT_MAX_ROWS) throw Error("記事は1〜100件にしてください");
    const seen = new Set<string>();
    for (const [i, value] of raw.entries()) {
      const row = i + 1;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        result.errors.push({ row, message: "記事の形式が不正です" });
        continue;
      }
      const v = value as Record<string, unknown>;
      const parsed = importedArticleSchema.safeParse({
        ...v,
        sourceUrl: v.sourceUrl === undefined || v.sourceUrl === "" ? null : v.sourceUrl,
        originalPublishedAt:
          v.originalPublishedAt === undefined || v.originalPublishedAt === "" ? null : v.originalPublishedAt,
      });
      if (!parsed.success) {
        result.errors.push({
          row,
          message: parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(" / "),
        });
        continue;
      }
      if (seen.has(parsed.data.slug)) {
        result.errors.push({ row, message: `URL名「${parsed.data.slug}」がファイル内で重複しています` });
        continue;
      }
      seen.add(parsed.data.slug);
      result.articles.push(parsed.data);
    }
    if (result.articles.some((a) => /<[a-z!/][^>]*>/i.test(a.body)))
      result.warnings.push(
        "HTMLを含む本文があります。タグは実行せず文字として保存・表示します。画像や装飾は別途確認してください。",
      );
  } catch (error) {
    result.errors.push({
      row: 0,
      message:
        error instanceof SyntaxError
          ? "JSONを読み込めません。構文を確認してください"
          : error instanceof Error
            ? error.message
            : "ファイルを読み込めません",
    });
  }
  return result;
}

export const articleImportCommitSchema = articleImportSourceSchema.extend({
  requestId: z.string().uuid().toLowerCase(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
});
