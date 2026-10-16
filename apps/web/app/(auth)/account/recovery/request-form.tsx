"use client";
import { useState } from "react";
import { requestRecoveryAction } from "@/app/account-recovery-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
export function RecoveryRequestForm() {
  const [pending, setPending] = useState(false),
    [done, setDone] = useState(false),
    [error, setError] = useState("");
  if (done)
    return (
      <div role="status" className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm leading-7">
        <p className="font-semibold">依頼内容を受け付けました</p>
        <p className="mt-2">
          復旧の対象となるアカウントがある場合、運営が確認します。登録済みの連絡先などで本人確認にご協力ください。お急ぎの場合は、普段の連絡先から運営へお問い合わせください。
        </p>
      </div>
    );
  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending) return;
        const email = String(new FormData(event.currentTarget).get("email") ?? "");
        setPending(true);
        setError("");
        try {
          const result = await requestRecoveryAction(email);
          if (result.ok) setDone(true);
          else setError(result.message);
        } catch {
          setError("受付結果を確認できませんでした。同じメールアドレスで再度依頼できます。");
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="space-y-2">
        <label htmlFor="email" className="text-sm font-medium">
          登録したメールアドレス
        </label>
        <Input id="email" name="email" type="email" autoComplete="email" maxLength={254} required disabled={pending} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "受け付けています…" : "運営に復旧を依頼"}
      </Button>
    </form>
  );
}
