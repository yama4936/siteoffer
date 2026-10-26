"use client";
import type { ContentAccessInput, loadContentAccess } from "@siteoffer/core";
import { useRef, useState } from "react";
import {
  inviteContentEditorAction,
  refreshContentAccessAction,
  revokeContentEditorAction,
} from "@/app/content-access-actions";
import { fmtDate, fmtDateOnly } from "@/lib/ops/format";

type Model = Awaited<ReturnType<typeof loadContentAccess>>;
export function ContentAccessManager({ initial }: { initial: Model }) {
  const [model, setModel] = useState(initial),
    [email, setEmail] = useState(""),
    [contract, setContract] = useState(initial.contracts[0]?.id ?? ""),
    [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [link, setLink] = useState("");
  const pending = useRef<ContentAccessInput | null>(null),
    running = useRef(false);
  async function refresh() {
    const r = await refreshContentAccessAction(initial.company.id);
    if (r.status === "ok") setModel(r.value);
    else setError(r.message);
  }
  async function invite() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      pending.current ??= {
        companyId: initial.company.id,
        contractId: contract,
        email: email.trim().toLowerCase(),
        expectedRevision: model.access.find((a) => a.email === email.trim().toLowerCase())?.revision ?? 0,
        requestId: crypto.randomUUID(),
        confirmed,
      };
      const r = await inviteContentEditorAction(pending.current);
      pending.current = null;
      setUnknown(false);
      if (r.status === "error") {
        setError(r.message);
        await refresh();
        return;
      }
      setModel((m) => ({ ...m, access: [r.access, ...m.access.filter((a) => a.id !== r.access.id)] }));
      setConfirmed(false);
      if (r.token) {
        setLink(`${window.location.origin}/customer/activate/${r.token}`);
        setMessage("案内URLを発行しました。表示されている招待先へお渡しください。");
      } else {
        setLink("");
        setMessage("この受付は処理済みです。案内URLを控えていない場合は、一覧から再発行してください。");
      }
    } catch {
      setUnknown(true);
      setError("発行結果を確認できません。同じ受付番号で結果を確認してください。");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function revoke(row: Model["access"][number]) {
    if (running.current || !window.confirm(`${row.email} の記事更新を停止しますか？ 掲載中の記事はそのまま残ります。`))
      return;
    running.current = true;
    setBusy(true);
    setError("");
    setLink("");
    try {
      const r = await revokeContentEditorAction({
        companyId: initial.company.id,
        accessId: row.id,
        revision: row.revision,
      });
      if (r.status === "error") {
        setError(r.message);
        await refresh();
      } else {
        setModel((m) => ({ ...m, access: m.access.map((a) => (a.id === row.id ? r.access : a)) }));
        setMessage("この会社の記事更新を停止しました。ほかの会社の権限は変わりません。");
      }
    } catch {
      setError("停止結果を確認できません。一覧を更新して状態を確認してください。");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="rounded-xl border bg-white p-5 space-y-4" aria-label="顧客の記事更新権限">
      <h2 className="font-bold">顧客が自分で記事を更新できるようにする</h2>
      <p className="text-sm text-muted-foreground">
        記事更新の提供範囲を確認した完了契約と、ご本人のメールアドレスを指定してください。案内は72時間有効です。メールは自動送信しません。
      </p>
      {error && (
        <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="rounded bg-blue-50 p-3 text-sm">
          {message}
        </p>
      )}
      {unknown && (
        <button type="button" disabled={busy} className="design-button" onClick={() => void invite()}>
          同じ受付の結果を確認
        </button>
      )}
      {link && (
        <div className="rounded border bg-blue-50 p-4 space-y-2">
          <p className="text-sm font-semibold">招待先：{email.trim().toLowerCase()}</p>
          <label htmlFor="customer-invite-link">案内URL</label>
          <input
            id="customer-invite-link"
            readOnly
            value={link}
            className="w-full rounded border bg-white p-2 text-sm"
          />
          <button
            type="button"
            className="design-button secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                setMessage("案内URLをコピーしました。");
              } catch {
                setError("コピーできませんでした。案内URL欄からコピーしてください。");
              }
            }}
          >
            案内URLをコピー
          </button>
          <p className="text-xs">
            このURLはこの表示でのみ確認できます。受取人がパスワードを設定すると利用開始できます。
          </p>
        </div>
      )}
      {model.contracts.length === 0 ? (
        <p className="rounded border p-3 text-sm">完了した契約がありません。契約の確認後に案内を発行できます。</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void invite();
          }}
        >
          <fieldset disabled={busy || unknown} className="space-y-3">
            <label className="block text-sm">
              顧客のメールアドレス
              <input
                name="customerEmail"
                type="email"
                required
                maxLength={254}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setConfirmed(false);
                  setLink("");
                }}
                className="mt-2 block w-full rounded border p-2"
              />
            </label>
            <label className="block text-sm">
              対象の完了契約
              <select
                aria-label="対象の完了契約"
                value={contract}
                onChange={(e) => {
                  setContract(e.target.value);
                  setConfirmed(false);
                }}
                className="mt-2 block w-full rounded border p-2"
              >
                {model.contracts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.completedAt ? fmtDateOnly(c.completedAt) : "完了契約"} · {c.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" required checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              記事更新の契約範囲と招待先本人を確認しました
            </label>
            <button className="design-button" type="submit" disabled={!confirmed}>
              利用開始の案内を発行
            </button>
          </fieldset>
        </form>
      )}
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">招待・利用状況</h3>
        <button type="button" disabled={busy || unknown} className="text-sm underline" onClick={() => void refresh()}>
          一覧を更新
        </button>
      </div>
      {model.access.length === 0 && <p className="text-sm text-muted-foreground">まだ案内していません。</p>}
      <ul className="space-y-3">
        {model.access.map((row) => (
          <li key={row.id} className="rounded border p-3 space-y-2">
            <p className="break-all text-sm font-semibold">{row.email}</p>
            <p className="text-xs text-muted-foreground">
              {row.status === "active"
                ? row.accountStatus === "suspended"
                  ? "アカウント停止中"
                  : !model.contracts.some((c) => c.id === row.contractId)
                    ? "契約状態により更新停止"
                    : "利用開始済み"
                : row.status === "revoked"
                  ? "停止済み"
                  : `${Date.parse(row.expiresAt) <= Date.now() ? "案内の期限切れ" : "利用開始待ち"} · 有効期限 ${fmtDate(row.expiresAt)}`}
            </p>
            <div className="flex flex-wrap gap-3">
              {row.status !== "active" && (
                <button
                  type="button"
                  disabled={busy || unknown}
                  className="text-sm underline"
                  onClick={() => {
                    setEmail(row.email);
                    setContract(row.contractId);
                    setConfirmed(false);
                    setLink("");
                    setMessage(
                      "対象を入力欄にセットしました。確認して新しい案内を発行してください。以前の案内は使えなくなります。",
                    );
                  }}
                >
                  この方に再発行
                </button>
              )}
              {row.status !== "revoked" && (
                <button
                  type="button"
                  disabled={busy || unknown}
                  className="text-sm text-red-700 underline"
                  onClick={() => void revoke(row)}
                >
                  {row.status === "active" ? "記事更新を停止" : "招待を取り消す"}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
