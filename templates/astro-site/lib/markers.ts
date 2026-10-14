/**
 * 要確認マーカー `{{要確認:説明}}`（全角コロン `：` も可）の検出と分割。
 * 未確認の事実（実績・料金・住所など）を仮置きする印。公開（delivery）前に必ず解消する。
 *
 * SiteOffer全体での要確認の表記はこの形に統一する（正はこのファイル）。
 * 生成（packages/generation の事実検査）もこの正規表現でマーカーを検出する。
 * 生成物そのものにはマーカーを入れさせず（不明な値は null）、マーカーを付けるのは運営が入力を手で直すときだけ。
 */

/** マーカーの見出し語。 */
export const MARKER_LABEL = "要確認";

/** マーカーの文字列を作る（例：`{{要確認:施工件数}}`）。説明の `}` は取り除く。 */
export function formatMarker(note = ""): string {
  const n = note.replace(/[{}]/g, "").trim();
  return n ? `{{${MARKER_LABEL}:${n}}}` : `{{${MARKER_LABEL}}}`;
}

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
