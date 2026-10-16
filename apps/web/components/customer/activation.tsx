"use client";
import { useRef, useState } from "react";
import { acceptContentInvitationAction } from "@/app/content-access-actions";
export function CustomerActivation({
  token,
  invitation,
}: {
  token: string;
  invitation: { companyName: string; email: string; existingAccount: boolean; accepted: boolean; expiresAt: string };
}) {
  const [name, setName] = useState(""),
    [password, setPassword] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const running = useRef(false);
  async function submit() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const r = await acceptContentInvitationAction({ token, displayName: name, password, confirmed });
      if (r.status === "error") {
        setError(r.message);
        return;
      }
      window.location.assign(`/customer/content?company=${r.companyId}`);
    } catch {
      setError("接続できませんでした。同じ内容でもう一度お試しください。");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="mx-auto max-w-xl rounded-xl border bg-white p-6 shadow-sm sm:p-8">
      <p className="text-sm font-semibold text-blue-700">{invitation.companyName}</p>
      <h1 className="mt-3 text-2xl font-bold">お知らせ・ブログを自分で更新</h1>
      <p className="mt-4 text-sm leading-7 text-slate-600">
        {invitation.existingAccount
          ? "登録済み顧客アカウントのパスワードで確認すると、この会社の記事を更新できます。"
          : "パスワードを設定すると、この会社の記事を書いて掲載できるようになります。"}
      </p>
      <p className="my-4 break-all rounded bg-slate-50 p-3 text-sm">顧客アカウント：{invitation.email}</p>
      {error && (
        <p role="alert" className="my-4 rounded bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={busy} className="space-y-5">
          {!invitation.existingAccount && (
            <label className="block text-sm font-medium">
              お名前
              <input
                name="displayName"
                required
                maxLength={100}
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-2 block w-full rounded border p-3"
              />
            </label>
          )}
          <label className="block text-sm font-medium">
            {invitation.existingAccount ? "登録済みのパスワード" : "設定するパスワード（10文字以上）"}
            <input
              name="password"
              type="password"
              required
              minLength={invitation.existingAccount ? undefined : 10}
              maxLength={200}
              autoComplete={invitation.existingAccount ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-2 block w-full rounded border p-3"
            />
          </label>
          <label className="flex items-start gap-3 text-sm leading-6">
            <input
              type="checkbox"
              required
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-1"
            />
            表示されている会社の記事を管理することを確認しました
          </label>
          <button
            type="submit"
            disabled={!confirmed}
            className="w-full rounded-lg bg-blue-600 px-5 py-3 font-semibold text-white disabled:opacity-50"
          >
            {busy ? "確認しています…" : "記事の更新を始める"}
          </button>
        </fieldset>
      </form>
      <p className="mt-5 text-xs leading-6 text-slate-500">
        次回からはログイン画面をご利用ください。掲載前に内容を確認でき、途中の入力も自動保存されます。
      </p>
    </section>
  );
}
