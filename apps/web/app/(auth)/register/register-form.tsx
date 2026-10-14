"use client";

import { useActionState } from "react";
import { registerAction } from "../actions";

/** 文字数の下限はサーバー側（core の PASSWORD_MIN_LENGTH）でも検査する */
const PASSWORD_MIN_LENGTH = 10;

export function RegisterForm({ termsVersionId }: { termsVersionId: string }) {
  const [state, action, pending] = useActionState(registerAction, undefined);
  return (
    <form action={action}>
      <input type="hidden" name="termsVersionId" value={termsVersionId} />
      <div>
        <label htmlFor="displayName">表示名</label>
        <input id="displayName" name="displayName" required maxLength={100} defaultValue={state?.displayName} />
      </div>
      <div>
        <label htmlFor="email">メールアドレス</label>
        <input id="email" name="email" type="email" autoComplete="email" required defaultValue={state?.email} />
      </div>
      <div>
        <label htmlFor="password">パスワード（{PASSWORD_MIN_LENGTH}文字以上）</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
        />
      </div>
      <div>
        <label>
          <input type="checkbox" name="agree" /> 上記の利用条件に同意する
        </label>
      </div>
      {state?.error && <p role="alert">{state.error}</p>}
      <button type="submit" disabled={pending}>
        登録する
      </button>
    </form>
  );
}
