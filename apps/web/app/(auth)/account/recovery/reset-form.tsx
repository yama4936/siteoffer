"use client";
import Link from "next/link";
import { useState } from "react";
import { resetRecoveryAction } from "@/app/account-recovery-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
export function RecoveryResetForm({ token }: { token: string }) {
  const [pending, setPending] = useState(false),
    [done, setDone] = useState(false),
    [error, setError] = useState("");
  if (done)
    return (
      <div role="status" className="space-y-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
        <p className="font-semibold">パスワードを再設定しました</p>
        <p className="text-sm leading-7">
          新しいパスワードでログインできます。この案内を使った再設定は完了しています。
        </p>
        <Link href="/logout" className="block font-medium underline">
          ログイン画面へ進む
        </Link>
      </div>
    );
  return (
    <form
      className="space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending) return;
        const form = event.currentTarget,
          data = new FormData(form),
          password = String(data.get("password") ?? ""),
          confirmation = String(data.get("confirmation") ?? "");
        if (password !== confirmation) {
          setError("新しいパスワードが一致しません");
          return;
        }
        setPending(true);
        setError("");
        try {
          const result = await resetRecoveryAction({ token, password, confirmation });
          if (result.ok) {
            form.reset();
            setDone(true);
          } else setError(result.message);
        } catch {
          setError(
            "結果を確認できませんでした。入力を変えずに再試行するか、新しいパスワードでログインをお試しください。",
          );
        } finally {
          setPending(false);
        }
      }}
    >
      <fieldset disabled={pending} className="space-y-5">
        <div className="space-y-2">
          <label htmlFor="password" className="text-sm font-medium">
            新しいパスワード
          </label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            maxLength={200}
            required
            aria-describedby="password-help"
          />
          <p id="password-help" className="text-xs text-slate-500">
            10〜200文字で設定してください。
          </p>
        </div>
        <div className="space-y-2">
          <label htmlFor="confirmation" className="text-sm font-medium">
            新しいパスワード（確認）
          </label>
          <Input
            id="confirmation"
            name="confirmation"
            type="password"
            autoComplete="new-password"
            minLength={10}
            maxLength={200}
            required
          />
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-7">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "再設定しています…" : "パスワードを再設定"}
      </Button>
      <Link href="/logout" className="block text-center text-sm underline">
        ログイン画面へ進む
      </Link>
    </form>
  );
}
