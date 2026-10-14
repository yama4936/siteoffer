/**
 * 要確認マーカー `{{要確認:説明}}`（全角コロン `：` も可）の検出と分割。
 * 未確認の事実（実績・料金・住所など）を仮置きする印。公開（delivery）前に必ず解消する。
 */

/** マーカー1つに一致する正規表現（g付きなので使うたびに新しく作る）。 */
export function markerRegex(): RegExp {
  return /\{\{\s*要確認\s*[:：]?([^}]*)\}\}/g;
}

/** 出力HTMLに残ったマーカーの痕跡（生のマーカーまたはテンプレートの表示要素）。 */
export const MARKER_ATTRIBUTE = "data-needs-confirm";

export interface MarkerHit {
  /** JSONでの位置（例：company.name、works.items[0].title）。 */
  path: string;
  /** マーカーの説明部分。 */
  note: string;
}

export function hasMarker(text: string | undefined | null): boolean {
  return typeof text === "string" && markerRegex().test(text);
}

/** 入力の全文字列を走査して、マーカーの位置と説明を返す。 */
export function findMarkers(value: unknown, path = ""): MarkerHit[] {
  const hits: MarkerHit[] = [];
  if (typeof value === "string") {
    for (const m of value.matchAll(markerRegex())) {
      hits.push({ path: path || "(root)", note: (m[1] ?? "").trim() });
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => {
      hits.push(...findMarkers(v, `${path}[${i}]`));
    });
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      hits.push(...findMarkers(v, path ? `${path}.${k}` : k));
    }
  }
  return hits;
}

export type TextPart = { kind: "text"; text: string } | { kind: "marker"; note: string };

/** 文字列を通常の文とマーカーに分ける（表示用）。 */
export function splitMarkers(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(markerRegex())) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push({ kind: "text", text: text.slice(last, idx) });
    parts.push({ kind: "marker", note: (m[1] ?? "").trim() });
    last = idx + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}
