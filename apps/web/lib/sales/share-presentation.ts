/** 共有画面の表示用。トークンを永続保存しない。 */
export type ShareCheckResult =
  | { status: "ok"; expiresAt: string }
  | { status: "error"; message: string; unavailable: boolean };
export type ShareCheckAction = (proposalVersionId: string, linkId: string) => Promise<ShareCheckResult>;
export interface ShareHistoryItem {
  id: string;
  recoverable?: boolean;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}
export function shareState(link: Pick<ShareHistoryItem, "expiresAt" | "revokedAt">, now: number) {
  if (link.revokedAt) return "revoked";
  const end = Date.parse(link.expiresAt);
  return Number.isFinite(end) && end > now ? "active" : "expired";
}
export function sharePeriod(hours: number): string {
  return hours % 24 === 0 ? `${hours / 24}日` : `${hours}時間`;
}
export function shareTtlOptions(maxHours: number) {
  if (!Number.isFinite(maxHours) || maxHours <= 0) return [];
  return [
    { value: "", label: `既定：${sharePeriod(maxHours)}` },
    ...[24, 72, 168].filter((n) => n < maxHours).map((n) => ({ value: String(n), label: sharePeriod(n) })),
  ];
}
export function shareDate(value: string) {
  return new Date(value).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
export function proposalShareMessage(url: string, expiresAt: string) {
  return `Webサイトの改善案をご確認いただけるデモをご案内します。

${url}

閲覧期限：${shareDate(expiresAt)}（日本時間）
こちらは非公式の改善提案であり、貴社の正式なWebサイトではありません。
ご希望や修正したい点がございましたら、お知らせください。`;
}
