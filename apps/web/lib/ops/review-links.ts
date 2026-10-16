import { createShareTokenRecovery } from "@siteoffer/core";
/** サーバーでだけ使用する。復旧鍵はクライアントから受け取らない。 */
export function reviewLinkRecovery() {
  try {
    return createShareTokenRecovery(process.env.SITEOFFER_SHARE_TOKEN_KEY ?? "");
  } catch {
    return undefined;
  }
}
export function reviewLinkError(error: string) {
  const messages: Record<string, string> = {
    forbidden: "運営のログイン状態を確認してください。リンクの再表示は発行した本人だけが行えます。",
    not_found: "確認する納品・共有リンクが見つかりません。",
    version_not_found: "確認する制作版が見つかりません。",
    invalid_transition: "制作の状態が変わっています。最新の状態を確認してください。",
    not_under_review: "この版の顧客確認は終了しています。現在の制作状態を確認してください。",
    version_requires_revision: "この版は再提出できません。今回の修正版を確認してください。",
    no_artifact: "この版には確認できる成果物がありません。",
    target_no_artifact: "この版には確認できる成果物がありません。",
    invalid_ttl: "有効期間は正の整数の時間で指定してください。",
    invalid_request: "発行情報を確認してください。必要なら画面を読み直してください。",
    request_conflict: "前の発行と内容が異なります。履歴を確認してから新しく発行してください。",
    recovery_unavailable: "このリンクの再表示に必要な設定を利用できません。管理者に確認してください。",
    link_unavailable: "このリンクは期限切れ、または取り消し済みです。必要なら新しく発行してください。",
  };
  return messages[error] ?? "処理を完了できませんでした。最新の状態を確認してください。";
}
