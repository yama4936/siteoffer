/** 顧客確認に回したときの結果。クライアントのフォームとサーバー処理の両方で使う（型だけ） */
export type CustomerReviewLinkState =
  | {
      status: "ok" | "error" | "unknown";
      message: string;
      /** 顧客に渡すURL（トークンを含む）。発行・本人の再表示操作の戻り値でだけ渡す */
      reviewUrl?: string;
      linkId?: string;
      versionId?: string;
      /** 有効期限（ISO文字列） */
      expiresAt?: string;
    }
  | undefined;

export type CustomerReviewLinkAction = (
  prev: CustomerReviewLinkState,
  formData: FormData,
) => Promise<CustomerReviewLinkState>;
