"use client";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { changePasswordAction } from "./actions";
export function PasswordForm({ revision, email }: { revision: number; email: string }) {
  const [pending, setPending] = useState(false),
    [message, setMessage] = useState("");
  const [unknown, setUnknown] = useState(false);
  return (
    <form
      className="space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending || unknown) return;
        const form = event.currentTarget,
          data = new FormData(form);
        const currentPassword = String(data.get("current") ?? ""),
          newPassword = String(data.get("new") ?? ""),
          confirmation = String(data.get("confirmation") ?? "");
        if (newPassword !== confirmation) {
          setMessage("新しいパスワードが一致しません");
          return;
        }
        setPending(true);
        setMessage("");
        try {
          const result = await changePasswordAction({
            currentPassword,
            newPassword,
            confirmation,
            expectedRevision: revision,
          });
          if (result?.message) setMessage(result.message);
        } catch {
          form.reset();
          setUnknown(true);
          setMessage(
            "変更結果を確認できませんでした。新しいパスワードでログインをお試しください。変更が反映されていなければ、以前のパスワードでログインして設定し直してください。",
          );
        } finally {
          setPending(false);
        }
      }}
    >
      <input type="hidden" name="username" autoComplete="username" value={email} />
      <fieldset disabled={pending || unknown} className="space-y-5">
        <div className="space-y-2">
          <label htmlFor="current" className="font-medium text-sm">
            現在のパスワード
          </label>
          <Input id="current" name="current" type="password" autoComplete="current-password" required maxLength={200} />
        </div>
        <div className="space-y-2">
          <label htmlFor="new" className="font-medium text-sm">
            新しいパスワード
          </label>
          <Input
            id="new"
            name="new"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            maxLength={200}
            aria-describedby="password-hint"
          />
          <p id="password-hint" className="text-muted-foreground text-xs">
            10〜200文字。現在とは異なるものを設定してください。
          </p>
        </div>
        <div className="space-y-2">
          <label htmlFor="confirmation" className="font-medium text-sm">
            新しいパスワード（確認）
          </label>
          <Input
            id="confirmation"
            name="confirmation"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            maxLength={200}
          />
        </div>
      </fieldset>
      {message && (
        <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          {message}
        </p>
      )}
      {unknown ? (
        <Link href="/login" className="underline">
          ログイン画面へ
        </Link>
      ) : (
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "変更しています…" : "変更して、すべてのログインを解除"}
        </Button>
      )}
    </form>
  );
}
