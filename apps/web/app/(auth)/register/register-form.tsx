"use client";

import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Label } from "@/components/ui/label";
import { registerAction } from "../actions";

/** 文字数の下限はサーバー側（core の PASSWORD_MIN_LENGTH）でも検査する */
const PASSWORD_MIN_LENGTH = 10;

export function RegisterForm({ termsVersionId }: { termsVersionId: string }) {
  const [state, action, pending] = useActionState(registerAction, undefined);
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="termsVersionId" value={termsVersionId} />
      <Field label="表示名" htmlFor="displayName">
        <Input id="displayName" name="displayName" required maxLength={100} defaultValue={state?.displayName} />
      </Field>
      <Field label="メールアドレス" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" required defaultValue={state?.email} />
      </Field>
      <Field label="パスワード" htmlFor="password" hint={`${PASSWORD_MIN_LENGTH}文字以上`}>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
        />
      </Field>
      <Label className="font-normal">
        <Input type="checkbox" name="agree" /> 上記の利用条件に同意する
      </Label>
      {state?.error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "登録中…" : "登録する"}
      </Button>
    </form>
  );
}
