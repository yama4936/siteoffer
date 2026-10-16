export const auditRequestLabels = {
  queued: "受付済み・開始待ち",
  processing: "診断開始済み",
  failed: "診断停止",
  blocked: "対象の再確認が必要",
  completed: "診断完了",
  cancelled: "取消済み",
};
export const auditRequestMessages = {
  queued: "依頼は保存済みです。ワーカーが順次処理します。",
  processing: "診断は開始済みです。追加の依頼は不要です。結果の反映をお待ちください。",
  failed: "診断が停止しています。診断結果と処理状況を確認してください。",
  blocked: "診断対象の再確認が必要です。企業情報と公式サイトを確認してください。",
  completed: "診断の処理は完了しています。企業画面で結果を確認できます。",
  cancelled: "開始前の診断依頼を取り消しました。",
};
