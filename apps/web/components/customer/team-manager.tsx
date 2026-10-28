"use client";
import type { CompanyEditorInviteInput } from "@siteoffer/core";
import { useRef, useState } from "react";
import { fmtDate } from "@/lib/ops/format";
import { type CompanyTeam, type CompanyTeamRow, companyTeamRowView } from "./team-rows";

type Failure = { status: "error"; message: string };
type ReturnedRow = CompanyTeamRow & { contractId?: string };
export type CompanyTeamActions = {
  invite: (
    input: CompanyEditorInviteInput,
  ) => Promise<{ status: "ok"; access: ReturnedRow; token: string | null } | Failure>;
  revoke: (input: {
    companyId: string;
    accessId: string;
    revision: number;
  }) => Promise<{ status: "ok"; access: ReturnedRow } | Failure>;
  refresh: (companyId: string) => Promise<{ status: "ok"; value: CompanyTeam } | Failure>;
};
/** 契約IDは画面に持たない（core の一覧も返さない） */
function strip(row: ReturnedRow): CompanyTeamRow {
  const { contractId: _contractId, ...view } = row;
  return view;
}

/** 顧客の管理者が自社の担当者（編集者）を招待・解除する画面（T23の(c)） */
export function CompanyTeamManager({ initial, actions }: { initial: CompanyTeam; actions: CompanyTeamActions }) {
  const companyId = initial.company.id;
  const [model, setModel] = useState(initial),
    [email, setEmail] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [link, setLink] = useState({ email: "", url: "" });
  const pending = useRef<CompanyEditorInviteInput | null>(null),
    running = useRef(false);
  async function refresh() {
    const r = await actions.refresh(companyId);
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
      const target = email.trim().toLowerCase();
      pending.current ??= {
        companyId,
        email: target,
        expectedRevision: model.access.find((a) => a.email === target)?.revision ?? 0,
        requestId: crypto.randomUUID(),
        confirmed,
      };
      const sent = pending.current;
      const r = await actions.invite(sent);
      pending.current = null;
      setUnknown(false);
      if (r.status === "error") {
        setError(r.message);
        await refresh();
        return;
      }
      const row = strip(r.access);
      setModel((m) => ({ ...m, access: [row, ...m.access.filter((a) => a.id !== row.id)] }));
      setConfirmed(false);
      setEmail("");
      if (r.token) {
        setLink({ email: sent.email, url: `${window.location.origin}/customer/activate/${r.token}` });
        setMessage("招待のURLを作りました。下のURLを、招待した方へお知らせください。");
      } else {
        setLink({ email: "", url: "" });
        setMessage("この招待はすでに受け付けています。URLを控えていない場合は、一覧から招待し直してください。");
      }
    } catch {
      setUnknown(true);
      setError("招待できたかどうか確認できませんでした。「結果を確認する」を押してください。");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function revoke(row: CompanyTeamRow) {
    const invited = row.status !== "active";
    if (
      running.current ||
      !window.confirm(
        invited
          ? `${row.email} への招待を取り消しますか？ 招待のURLは使えなくなります。`
          : `${row.email} の担当を解除しますか？ この方は記事の更新ができなくなります。掲載中の記事はそのまま残ります。`,
      )
    )
      return;
    running.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    setLink({ email: "", url: "" });
    try {
      const r = await actions.revoke({ companyId, accessId: row.id, revision: row.revision });
      if (r.status === "error") {
        setError(r.message);
        await refresh();
        return;
      }
      const next = strip(r.access);
      setModel((m) => ({ ...m, access: m.access.map((a) => (a.id === row.id ? next : a)) }));
      setMessage(invited ? "招待を取り消しました。" : "担当を解除しました。");
    } catch {
      setError("解除できたかどうか確認できませんでした。「一覧を更新」を押して状態を確認してください。");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      {error && (
        <p role="alert" className="rounded-xl bg-red-50 p-4 text-sm leading-7 text-red-800">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="rounded-xl bg-blue-50 p-4 text-sm leading-7">
          {message}
        </p>
      )}
      {unknown && (
        <button
          type="button"
          disabled={busy}
          className="rounded border bg-white px-4 py-2 text-sm"
          onClick={() => void invite()}
        >
          結果を確認する
        </button>
      )}
      {link.url && (
        <div className="space-y-3 rounded-xl border bg-blue-50 p-5">
          <p className="break-all text-sm font-semibold">招待した方：{link.email}</p>
          <label htmlFor="team-invite-link" className="block text-sm">
            招待のURL
          </label>
          <input
            id="team-invite-link"
            readOnly
            value={link.url}
            className="w-full rounded border bg-white p-2 text-sm"
          />
          <button
            type="button"
            className="rounded border bg-white px-4 py-2 text-sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link.url);
                setMessage("招待のURLをコピーしました。");
              } catch {
                setError("コピーできませんでした。URLの欄から手でコピーしてください。");
              }
            }}
          >
            URLをコピー
          </button>
          <p className="text-xs leading-6 text-slate-600">
            メールは自動では送られません。このURLはこの画面でだけ表示されます。URLは72時間使えます。招待された方がパスワードを決めると、記事の更新を始められます。
          </p>
        </div>
      )}
      <section className="rounded-xl border bg-white p-6" aria-labelledby="team-invite-title">
        <h2 id="team-invite-title" className="font-bold text-lg">
          担当者を招待する
        </h2>
        <p className="mt-2 text-sm leading-7 text-slate-600">
          招待した方は「編集者」になり、お知らせ・ブログの記事を更新できます。編集者は、担当者の招待や解除はできません。
        </p>
        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void invite();
          }}
        >
          <fieldset disabled={busy || unknown} className="space-y-4">
            <label className="block text-sm">
              招待する方のメールアドレス
              <input
                name="editorEmail"
                type="email"
                required
                maxLength={254}
                autoComplete="off"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setConfirmed(false);
                }}
                className="mt-2 block w-full rounded border p-2"
              />
            </label>
            <label className="flex items-start gap-2 text-sm leading-6">
              <input
                type="checkbox"
                required
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-1"
              />
              メールアドレスが正しいこと、この方に自社の記事の更新を任せることを確認しました
            </label>
            <button
              type="submit"
              disabled={!confirmed}
              className="rounded bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              招待のURLを作る
            </button>
          </fieldset>
        </form>
      </section>
      <section className="rounded-xl border bg-white p-6" aria-labelledby="team-list-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="team-list-title" className="font-bold text-lg">
            担当者の一覧
          </h2>
          <button type="button" disabled={busy || unknown} className="text-sm underline" onClick={() => void refresh()}>
            一覧を更新
          </button>
        </div>
        {model.access.length === 0 ? (
          <p className="mt-4 text-sm text-slate-600">まだ担当者がいません。</p>
        ) : (
          <ul className="mt-4 divide-y">
            {model.access.map((row) => {
              const view = companyTeamRowView(row, model.selfAccessId);
              return (
                <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 py-4">
                  <div className="min-w-0 space-y-1">
                    <p className="break-all text-sm font-semibold">
                      {row.email}
                      {view.self && (
                        <span className="ml-2 rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-800">あなた</span>
                      )}
                    </p>
                    <p className="text-sm text-slate-600">
                      {view.roleLabel} ・ {view.statusLabel}
                      {row.status === "invited" && ` ・ URLの期限 ${fmtDate(row.expiresAt)}`}
                    </p>
                    {view.note && <p className="text-xs text-slate-500">{view.note}</p>}
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {view.canReinvite && (
                      <button
                        type="button"
                        disabled={busy || unknown}
                        className="text-sm underline"
                        onClick={() => {
                          setEmail(row.email);
                          setConfirmed(false);
                          setLink({ email: "", url: "" });
                          setMessage("招待の入力欄にメールアドレスを入れました。確認して、もう一度招待してください。");
                        }}
                      >
                        もう一度招待する
                      </button>
                    )}
                    {view.revokeLabel && (
                      <button
                        type="button"
                        disabled={busy || unknown}
                        className="text-sm text-red-700 underline"
                        onClick={() => void revoke(row)}
                      >
                        {view.revokeLabel}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
