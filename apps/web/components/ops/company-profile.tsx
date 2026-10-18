"use client";
import { COMPANY_PROFILE_FIELDS, type CompanyProfileField, type CompanyProfileValues } from "@siteoffer/schemas";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { companyProfileAction } from "@/app/(ops)/ops/companies/[companyId]/profile-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  companyId: string;
  revision: number;
  initialValues: CompanyProfileValues;
  source: string;
  confirmedAt: string | null;
  confirmedBy: string | null;
  contactReady: boolean;
};
const strings = (values: CompanyProfileValues) =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ?? ""])) as Record<
    CompanyProfileField,
    string
  >;
export function CompanyProfile(props: Props) {
  const [state, action, pending] = useActionState(companyProfileAction, {
    nonce: "",
    ok: false,
    message: "",
    revision: null,
    refreshRequired: false,
  });
  const [values, setValues] = useState(() => strings(props.initialValues)),
    [source, setSource] = useState(props.source),
    [revision, setRevision] = useState(props.revision),
    [checked, setChecked] = useState(false),
    [ready, setReady] = useState(false);
  const router = useRouter();
  const stale = props.revision !== revision && !(state.ok && state.revision === revision && props.revision < revision);
  useEffect(() => {
    setReady(true);
  }, []);
  useEffect(() => {
    if (stale) setChecked(false);
  }, [stale]);
  useEffect(() => {
    if (!state.nonce) return;
    setChecked(false);
    if (state.ok && state.revision !== null) setRevision(state.revision);
    if (state.ok || state.refreshRequired) router.refresh();
  }, [state.nonce, state.ok, state.revision, state.refreshRequired, router]);
  const field = (key: CompanyProfileField, multiline = false) => (
    <Label className="grid gap-1.5" key={key}>
      {COMPANY_PROFILE_FIELDS[key]}
      {multiline ? (
        <Textarea
          name={key}
          value={values[key]}
          maxLength={1000}
          rows={3}
          onChange={(event) => {
            setValues({ ...values, [key]: event.target.value });
            setChecked(false);
          }}
        />
      ) : (
        <Input
          name={key}
          type={key === "email" ? "email" : key === "phone" ? "tel" : "text"}
          value={values[key]}
          maxLength={key === "phone" ? 40 : key === "email" ? 254 : 1000}
          onChange={(event) => {
            setValues({ ...values, [key]: event.target.value });
            setChecked(false);
          }}
        />
      )}
    </Label>
  );
  return (
    <section
      id="company-profile"
      aria-labelledby="company-profile-title"
      className="mb-8 scroll-mt-24 rounded-2xl border bg-card p-5 shadow-sm sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="company-profile-title" className="font-semibold text-lg">
            制作に使う会社情報
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            出典を一度確認して保存すると、営業画面の連絡先と、次の提案・納品制作で共通利用します。電話・業種などの入力候補は、ここで確認してから使います。
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-medium ${props.contactReady ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"}`}
        >
          {props.contactReady ? "連絡先 確認済み" : "実情報からの制作前に連絡先を確認"}
        </span>
      </div>
      {props.confirmedAt && (
        <p className="mt-2 text-xs text-muted-foreground">
          確認情報 第{props.revision}版 · {props.confirmedBy} ·{" "}
          {new Date(props.confirmedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
        </p>
      )}
      <form action={action} className="mt-5 space-y-4">
        <noscript>
          <p>確認情報の保存にはJavaScriptが必要です。入力候補はこのまま確認できます。</p>
        </noscript>
        <input type="hidden" name="companyId" value={props.companyId} />
        <input type="hidden" name="revision" value={revision} />
        {stale && (
          <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
            <p>
              会社情報の版が変わりました。未保存の入力は残しています。内容を控えて、最新の情報を読み直してください。
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                setValues(strings(props.initialValues));
                setSource(props.source);
                setRevision(props.revision);
                setChecked(false);
              }}
            >
              最新情報を読み直す
            </Button>
          </div>
        )}
        <fieldset disabled={!ready || pending || stale} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {field("phone")}
            {field("email")}
          </div>
          <p className="text-xs text-muted-foreground">
            制作には確認済みの電話またはメールが必要です。連絡先が不明な場合、AIが補完することはありません。
          </p>
          <details className="rounded-xl border p-4">
            <summary className="cursor-pointer text-sm font-medium">サービス・受付時間・所在地も確認する</summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {field("services", true)}
              {field("address", true)}
              {field("hours")}
              {field("industry")}
            </div>
          </details>
          <Label className="grid gap-1.5">
            確認に使った出典・根拠
            <Textarea
              name="source"
              value={source}
              rows={2}
              minLength={3}
              maxLength={1000}
              required
              placeholder="公式サイトのURL、顧客に確認した資料名・日付など"
              onChange={(event) => {
                setSource(event.target.value);
                setChecked(false);
              }}
            />
          </Label>
          <Label className="flex items-start gap-2 text-sm font-normal">
            <input
              type="checkbox"
              name="confirmed"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
              className="mt-1 size-4 shrink-0"
            />
            根拠を確認しました。入力した内容を制作に使い、空欄の項目は使用しません。
          </Label>
          <p className="text-xs text-muted-foreground">
            変更した場合、この確認情報を使った旧版の共有リンクは停止します。新しい提案・納品版を制作してください。同じ内容の再保存では版と共有を維持します。
          </p>
          <Button type="submit" disabled={!checked || !ready || pending || stale}>
            {pending ? "保存中…" : "確認情報を保存"}
          </Button>
        </fieldset>
        {state.message && (
          <p
            role={state.ok ? "status" : "alert"}
            className={`break-words text-sm ${state.ok ? "text-emerald-800" : "text-red-700"}`}
          >
            {state.message}
          </p>
        )}
      </form>
    </section>
  );
}
