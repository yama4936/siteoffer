/** 顧客確認に回したときの結果。クライアントのフォームとサーバー処理の両方で使う（型だけ） */
export type CustomerReviewLinkState =
  | {
      status: "ok" | "error";
      message: string;
      /** 顧客に渡すURL（トークンを含む）。この戻り値でだけ渡し、再表示はできない */
      reviewUrl?: string;
      /** 有効期限（ISO文字列） */
      expiresAt?: string;
    }
  | undefined;

export type CustomerReviewLinkAction = (
  prev: CustomerReviewLinkState,
  formData: FormData,
) => Promise<CustomerReviewLinkState>;
