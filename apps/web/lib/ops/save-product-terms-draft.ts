import type { Actor } from "@siteoffer/core";
import { createProductTermsVersion, type OpsDeps } from "./commands";
import { inspectProductTermsDraft, type ProductTermsDraftState, readProductTermsDraft } from "./product-terms-draft";

/** A failed save returns errors in place instead of redirecting and discarding the draft. */
export async function saveProductTermsDraft(
  deps: OpsDeps,
  actor: Actor | null,
  form: FormData,
  nonce: string,
): Promise<ProductTermsDraftState> {
  const error = (message: string, errors: ProductTermsDraftState["errors"] = {}): ProductTermsDraftState => ({
    nonce,
    status: "error",
    message,
    errors,
    saved: null,
  });
  if (actor?.kind !== "ops") return error("保存するには運営でログインしてください。");
  const draft = readProductTermsDraft(form);
  if (!draft) return error("入力形式を確認してください。入力欄の重複や文字数超過があるため保存していません。");
  const inspection = inspectProductTermsDraft(draft);
  if (!inspection.input) return error("入力内容を確認してください。まだ保存していません。", inspection.errors);
  try {
    const result = await createProductTermsVersion(deps, actor, inspection.input);
    if (!result.ok) {
      if (result.error === "version_taken")
        return error("同じ版名が既にあります。保存済みの一覧を確認してください。", {
          version: "別の版名を入力してください。",
        });
      return error(
        result.error === "forbidden"
          ? "運営のログイン状態を確認してください。保存していません。"
          : "入力内容を確認してください。保存できませんでした。",
      );
    }
    return {
      nonce,
      status: "saved",
      errors: {},
      saved: { id: result.value.id, version: result.value.version },
      message: `「${result.value.version}」を保存しました。既存の契約条件は変わりません。`,
    };
  } catch {
    // A lost response may follow a commit. The unique version also makes an identical retry safe.
    return error(
      "保存結果を確認できません。入力は残しています。一覧で同じ版名の有無を確認してから再試行してください。",
    );
  }
}
