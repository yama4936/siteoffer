/** Fold only the numeric notation used by the fact check, without rewriting Japanese prose. */
export function foldNumericWidth(text: string): string {
  return text
    .replace(/[０-９Ａ-Ｚａ-ｚ％，．＋－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/￥/g, "¥")
    .replace(/−/g, "-");
}

const number = String.raw`[+-]?\d[\d,]*(?:\.\d+)?`;
// A match must not start in the middle of another number, decimal or signed quantity.
const start = String.raw`(?<![\d.,+-])`;
const patterns = [
  new RegExp(String.raw`[¥￥]\s*${number}`, "g"),
  new RegExp(String.raw`${start}${number}\s*(?:万|千|百)?円`, "g"),
  new RegExp(String.raw`${start}${number}\s*(?:万|千|百)?(?:件|社|名|人|棟|台|店舗|拠点)`, "g"),
  new RegExp(String.raw`(?:創業|設立|創立)\s*${number}\s*年`, "g"),
  new RegExp(String.raw`${start}${number}\s*年(?:の実績|以上)`, "g"),
  new RegExp(String.raw`${start}${number}\s*[%％]`, "g"),
  /(?:No\.?\s*1(?![\d.])|ナンバーワン|第\s*1\s*位|(?<![\d.,+-])1位)/gi,
];

/** Return complete quantities including their units; do not concatenate independent sources. */
export function numericClaims(text: string): string[] {
  const folded = foldNumericWidth(text);
  return patterns.flatMap((pattern) => Array.from(folded.matchAll(pattern), (match) => match[0]));
}
