/**
 * 改善デモ・制作版のプレビュー（apps/preview）のオリジン。プレビューは営業アプリと別のオリジンで配信する（11章）。
 * 企業・顧客に見せるURLは、期限付き・取り消し可能な共有リンク（shareLinkUrl(origin, token)）だけにする。
 * 版IDから組み立てた固定のURLは作らない。
 */
export const DEFAULT_PREVIEW_ORIGIN = "http://localhost:3200";

/** PREVIEW_BASE_URL を優先し、無ければ PREVIEW_ORIGIN（compose.yaml の既存の名前）、どちらも無ければローカルの既定値 */
export function previewOrigin(): string {
  return process.env.PREVIEW_BASE_URL || process.env.PREVIEW_ORIGIN || DEFAULT_PREVIEW_ORIGIN;
}
