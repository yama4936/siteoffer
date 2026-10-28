import { isValidCorporateNumber } from "@siteoffer/schemas";
import { coreName } from "./judge.ts";

/**
 * 取得したページ本文から、実在確認に使う事実（社名・法人番号・所在地）を取り出す。
 * AIが書いた evidence ではなく、実際に取得した本文だけを根拠にする。
 */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** HTMLを本文テキストにする（script・style・コメントを除き、タグを空白に置き換える） */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(Number.parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

function safeCodePoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return " ";
  }
}

function norm(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

/**
 * 本文に社名が書かれているか。judge.ts と同じ正規化（NFKC・空白除去・小文字化・法人格の除去）で比べる。
 * 法人格を除いた社名が2文字未満なら、偶然の一致を避けるため確認できないものとする。
 */
export function textMentionsCompanyName(text: string, name: string): boolean {
  const core = coreName(name);
  if (core.length < 2) return false;
  return coreName(text).includes(core);
}

/** 本文に書かれた法人番号（検査用数字が正しいものだけ。適格請求書発行事業者の登録番号 T+13桁も含む） */
export function findCorporateNumbers(text: string): string[] {
  const t = text.normalize("NFKC");
  const found = new Set<string>();
  for (const m of t.matchAll(/(?<!\d)(\d)[-‐−\s]?(\d{4})[-‐−\s]?(\d{4})[-‐−\s]?(\d{4})(?!\d)/g)) {
    const n = `${m[1]}${m[2]}${m[3]}${m[4]}`;
    if (isValidCorporateNumber(n)) found.add(n);
  }
  return [...found];
}

/**
 * 本文に所在地（都道府県＋市区町村、または市区町村）が書かれていれば、その表記を返す。
 * 一致を確認できたときだけ返し、書かれていない・食い違う場合は null（judge 側で「所在地は未確認」になる）。
 */
export function findAddressOnPage(text: string, prefecture: string | null, city: string | null): string | null {
  if (!city) return null;
  const page = norm(text);
  if (prefecture && page.includes(norm(prefecture + city))) return `${prefecture}${city}`;
  if (norm(city).length >= 3 && page.includes(norm(city))) return city;
  return null;
}

/** 本文に番地まで含む所在地がそのまま書かれているか */
export function textMentionsAddress(text: string, address: string | null): boolean {
  if (!address) return false;
  const a = norm(address);
  return a.length >= 4 && norm(text).includes(a);
}
