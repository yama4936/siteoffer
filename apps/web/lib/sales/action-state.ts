/** 営業画面のフォーム処理の結果。クライアントのフォームとサーバー処理の両方で使う（型だけ） */
export type SalesActionState =
  | {
      status: "ok" | "error";
      message: string;
      /** 画面に表示する注意文（ドメイン希望の注意など） */
      notices?: string[];
      /** 担当確保に成功したときの担当ID */
      assignmentId?: string;
    }
  | undefined;

export type SalesAction = (prev: SalesActionState, formData: FormData) => Promise<SalesActionState>;
