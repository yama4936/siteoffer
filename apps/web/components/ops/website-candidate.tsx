"use client";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { websiteCandidateAction, websiteReviewAction } from "@/app/(ops)/ops/companies/[companyId]/website-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { OFFICIAL_SITE_LABEL } from "@/lib/ops/format";
import type { listSiteSearchCandidates } from "@/lib/ops/website-candidate";

type Candidates = Extract<Awaited<ReturnType<typeof listSiteSearchCandidates>>, { ok: true }>["value"];

type Props = {
  companyId: string;
  fingerprint: string;
  requestId: string;
  status: string;
  sites: { id: string; url: string; primary: boolean; fingerprint: string }[];
  searchCandidates?: Candidates;
};
const initial = { nonce: "", ok: false, message: "" };
export function WebsiteCandidate(props: Props) {
  const [state, action, pending] = useActionState(websiteCandidateAction, initial),
    [checked, setChecked] = useState(false),
    [requestId, setRequestId] = useState(props.requestId),
    [values, setValues] = useState({ url: "", sourceUrl: "", note: "" }),
    [ready, setReady] = useState(false),
    router = useRouter();
  useEffect(() => {
    void props.fingerprint;
    setReady(true);
    setChecked(false);
  }, [props.fingerprint]);
  useEffect(() => {
    if (state.nonce) {
      setChecked(false);
      if (state.ok) {
        setValues({ url: "", sourceUrl: "", note: "" });
        setRequestId(crypto.randomUUID());
        router.refresh();
      }
    }
  }, [state.nonce, state.ok, router]);
  return (
    <details className="my-4 rounded-xl border bg-white p-4">
      <summary className="cursor-pointer font-medium">
        公式サイトの候補URLと確認根拠を追加
        {props.searchCandidates?.length ? `（検索候補${props.searchCandidates.length}件）` : ""}
      </summary>
      <p className="mt-3 text-sm text-muted-foreground">
        自動収集でURLが見つからない場合や候補を補足する運営用の機能です。候補の保存では公式サイトの確定や診断は行いません。確認済みの主サイトは置き換えません。
      </p>
      {!!props.searchCandidates?.length && (
        <section className="mt-4" aria-label="自動収集したサイト候補">
          <h3 className="font-medium">検索で見つかった候補（最近20件から表示）</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            検索結果だけでは公式サイトと判断できません。候補を開いて会社名・所在地などを確認し、その根拠を下の欄に記録してください。
          </p>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {props.searchCandidates.map((candidate) => (
              <li key={candidate.id} className="min-w-0 rounded-lg border p-3 text-sm">
                <p className="font-medium break-words">{candidate.title || "サイト候補"}</p>
                <a
                  href={candidate.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-1 block break-all text-primary underline"
                >
                  {candidate.url}（別タブ）
                </a>
                <p className="mt-2 break-words text-muted-foreground">
                  {candidate.reason || "企業との一致は未確認です"}
                </p>
                <p className="mt-2 break-all text-xs text-muted-foreground">
                  {candidate.provider} · {candidate.fetchedAt}
                </p>
                {candidate.sourceUrl && (
                  <p className="mt-1 break-all text-xs text-muted-foreground">検索の出典：{candidate.sourceUrl}</p>
                )}
                {candidate.selectable ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    disabled={!ready || pending}
                    onClick={() => {
                      setValues({ url: candidate.url, sourceUrl: candidate.sourceUrl!, note: "" });
                      setChecked(false);
                    }}
                  >
                    この候補を確認欄に入力
                  </Button>
                ) : (
                  <p className="mt-3 text-amber-800">
                    第三者サイト・別企業・出典不明の可能性があるため、確認欄への自動入力はできません。
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <form action={action} className="mt-4 space-y-3">
        <noscript>
          <p>保存操作にはJavaScriptが必要です。登録済みのサイトと出典はこのまま確認できます。</p>
        </noscript>
        <input type="hidden" name="companyId" value={props.companyId} />
        <input type="hidden" name="requestId" value={requestId} />
        <input type="hidden" name="expected" value={props.fingerprint} />
        <fieldset disabled={!ready || pending} className="grid gap-3">
          <Label className="grid gap-1">
            候補のサイトURL
            <Input
              name="url"
              type="url"
              value={values.url}
              onChange={(event) => {
                setValues({ ...values, url: event.target.value });
                setChecked(false);
              }}
              placeholder="https://example.co.jp/"
              maxLength={2048}
              required
            />
          </Label>
          <Label className="grid gap-1">
            確認に使った出典URL
            <Input
              name="sourceUrl"
              type="url"
              value={values.sourceUrl}
              onChange={(event) => {
                setValues({ ...values, sourceUrl: event.target.value });
                setChecked(false);
              }}
              maxLength={2048}
              required
            />
          </Label>
          <Label className="grid gap-1">
            この企業の候補と判断した根拠
            <Input
              name="note"
              value={values.note}
              onChange={(event) => {
                setValues({ ...values, note: event.target.value });
                setChecked(false);
              }}
              minLength={5}
              maxLength={2000}
              placeholder="会社名・所在地・法人番号の一致など"
              required
            />
          </Label>
          <Label className="flex items-start gap-2">
            <input
              name="confirmed"
              type="checkbox"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
              required
            />
            <span>候補と出典がこの企業に関する情報であり、認証情報を含まないことを確認しました。</span>
          </Label>
          <Button className="w-fit" type="submit" disabled={!checked || pending}>
            {pending ? "保存を確認中…" : "候補と根拠を保存"}
          </Button>
        </fieldset>
        {state.message && (
          <p role="status" className={`rounded-lg border p-3 text-sm ${state.ok ? "bg-emerald-50" : "bg-amber-50"}`}>
            {state.message}
          </p>
        )}
        {!state.ok && state.nonce && (
          <Button type="button" variant="outline" size="sm" onClick={() => router.refresh()}>
            入力を残して最新状態を確認
          </Button>
        )}
      </form>
    </details>
  );
}
export function WebsiteReview(props: Props) {
  const [state, action, pending] = useActionState(websiteReviewAction, initial),
    [status, setStatus] = useState(props.status),
    [websiteId, setWebsiteId] = useState(props.sites.find((site) => site.primary)?.id ?? ""),
    [checked, setChecked] = useState(false),
    [note, setNote] = useState(""),
    [ready, setReady] = useState(false),
    router = useRouter();
  const selected = props.sites.find((site) => site.id === websiteId),
    fingerprint = selected?.fingerprint ?? props.fingerprint;
  useEffect(() => {
    void fingerprint;
    setReady(true);
    setChecked(false);
  }, [fingerprint]);
  useEffect(() => {
    if (state.nonce) {
      setChecked(false);
      if (state.ok) router.refresh();
    }
  }, [state.nonce, state.ok, router]);
  return (
    <form
      action={action}
      className="my-4 rounded-xl border bg-slate-50/50 p-4 space-y-3"
      aria-label="公式サイトの確度を確認"
    >
      <noscript>
        <p>確度の変更にはJavaScriptが必要です。登録済みのサイトと出典はこのまま確認できます。</p>
      </noscript>
      <input type="hidden" name="companyId" value={props.companyId} />
      <input type="hidden" name="expected" value={fingerprint} />
      <fieldset disabled={!ready || pending} className="grid gap-3 sm:grid-cols-2">
        <Label className="grid gap-1">
          公式サイトの確度
          <NativeSelect
            name="status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setChecked(false);
            }}
          >
            {Object.entries(OFFICIAL_SITE_LABEL).map(([key, value]) => (
              <option value={key} key={key}>
                {value}
              </option>
            ))}
          </NativeSelect>
        </Label>
        <Label className="grid gap-1 min-w-0">
          確認する現サイト
          <NativeSelect
            name="websiteId"
            value={websiteId}
            onChange={(event) => {
              setWebsiteId(event.target.value);
              setChecked(false);
            }}
            required={status === "confirmed"}
          >
            <option value="">URLを選択（確定するときは必須）</option>
            {props.sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.url}
              </option>
            ))}
          </NativeSelect>
        </Label>
        <Label className="grid gap-1 sm:col-span-2">
          確認メモ（任意）
          <Input
            name="note"
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
              setChecked(false);
            }}
            maxLength={2000}
          />
        </Label>
        {status === "confirmed" && (
          <Label className="flex items-start gap-2 sm:col-span-2">
            <input
              type="checkbox"
              name="confirmed"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
              required
            />
            <span>選択したURLがこの企業の公式サイトであり、診断対象にしてよいことを確認しました。</span>
          </Label>
        )}
        <Button
          type="submit"
          className="w-fit"
          disabled={pending || (status === "confirmed" && (!selected || !checked))}
        >
          {pending ? "保存を確認中…" : "公式サイトの確度を保存"}
        </Button>
      </fieldset>
      {state.message && (
        <p role="status" className={`rounded-lg border p-3 text-sm ${state.ok ? "bg-emerald-50" : "bg-amber-50"}`}>
          {state.message}
        </p>
      )}
      {!state.ok && state.nonce && (
        <Button type="button" variant="outline" size="sm" onClick={() => router.refresh()}>
          選択を残して最新状態を確認
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        現サイトだけを選べます。確認済みとして保存した後、診断欄から対象を確認して依頼します。
      </p>
    </form>
  );
}
