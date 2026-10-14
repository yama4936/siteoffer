/**
 * 改善デモ（生成プレビュー）へのリンク。プレビューは営業アプリと別のオリジンで配信する（11章）。
 * 期限付き・取り消し可能な共有トークンの発行と検証は T10（apps/preview・share-link）が担当する。
 * ここではリンクの形だけを作る。T10 の取り込み時に、共有トークン付きのURLへ置き換える。
 */
export const DEFAULT_PREVIEW_ORIGIN = "http://localhost:3200";

export function previewOrigin(): string {
  return process.env.PREVIEW_ORIGIN || DEFAULT_PREVIEW_ORIGIN;
}

export function demoPreviewUrl(proposalVersionId: string, origin: string = previewOrigin()): string {
  return new URL(`/demo/${encodeURIComponent(proposalVersionId)}/`, origin).toString();
}
