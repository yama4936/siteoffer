"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { saveProductTermsDraftAction } from "@/app/(ops)/ops/contracts/terms-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { yen } from "@/lib/ops/format";
import {
  EMPTY_PRODUCT_TERMS_DRAFT,
  inspectProductTermsDraft,
  type ProductTermsDraftState,
  type ProductTermsErrors,
  type ProductTermsField,
} from "@/lib/ops/product-terms-draft";

export function ProductTermsForm() {
  const [generation, setGeneration] = useState(0);
  return <DraftForm key={generation} onNew={() => setGeneration(generation + 1)} />;
}

function DraftForm({ onNew }: { onNew: () => void }) {
  const [draft, setDraft] = useState({ ...EMPTY_PRODUCT_TERMS_DRAFT });
  const [state, action, pending] = useActionState<ProductTermsDraftState, FormData>(saveProductTermsDraftAction, {
    nonce: "",
    status: "idle",
    message: "",
    errors: {},
    saved: null,
  });
  const [serverErrors, setServerErrors] = useState<ProductTermsErrors>({});
  const form = useRef<HTMLFormElement>(null);
  const message = useRef<HTMLDivElement>(null);
  const inspection = inspectProductTermsDraft(draft);
  const saved = state.status === "saved";
  useEffect(() => {
    if (!state.nonce) return;
    setServerErrors(state.errors);
    const first = Object.keys(state.errors)[0] as ProductTermsField | undefined;
    if (first) form.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
    else message.current?.focus();
  }, [state.nonce, state.errors]);
  const update = (field: ProductTermsField, value: string) => {
    setDraft((previous) => ({ ...previous, [field]: value, ...(field === "rewardType" ? { rewardValue: "" } : {}) }));
    setServerErrors((previous) => ({
      ...previous,
      [field]: undefined,
      ...(field === "rewardType" ? { rewardValue: undefined } : {}),
    }));
  };
  const error = (field: ProductTermsField) =>
    (draft[field].trim() ? inspection.errors[field] : undefined) ?? serverErrors[field];
  const props = (field: ProductTermsField) => ({
    id: `terms-${field}`,
    name: field,
    value: draft[field],
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      update(field, event.target.value),
    "aria-invalid": Boolean(error(field)),
    "aria-describedby": error(field) ? `terms-${field}-error` : undefined,
  });
  const feedback = (field: ProductTermsField) =>
    error(field) ? (
      <p id={`terms-${field}-error`} className="text-destructive text-xs">
        {error(field)}
      </p>
    ) : null;
  const ready =
    inspection.price !== null &&
    inspection.price !== undefined &&
    inspection.rewardRule !== null &&
    !inspection.errors.rewardValue &&
    !inspection.errors.monthlyFee;

  return (
    <form
      ref={form}
      action={action}
      noValidate
      className="mt-4 space-y-5"
      aria-label="販売条件の新しい版"
      aria-busy={pending}
    >
      <p className="text-sm text-muted-foreground">
        入力した条件から金額をすぐ確認できます。価格・報酬を決める前でも、未設定のまま保存できます。
      </p>
      {state.message && (
        <div
          ref={message}
          tabIndex={-1}
          role={saved ? "status" : "alert"}
          className={`rounded-lg border p-3 text-sm ${saved ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-destructive/30 bg-destructive/5 text-destructive"}`}
        >
          {state.message}
        </div>
      )}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.7fr)]">
        <fieldset disabled={pending || saved} className="min-w-0 space-y-4">
          <legend className="mb-3 font-semibold">条件を入力</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="版名（必須）" htmlFor="terms-version" hint="他の版と重ならない名前">
              <Input {...props("version")} maxLength={100} placeholder="例：2026-10-a" autoComplete="off" required />
              {feedback("version")}
            </Field>
            <Field label="名称（必須）" htmlFor="terms-name">
              <Input {...props("name")} maxLength={200} placeholder="提供するプランの名前" required />
              {feedback("name")}
            </Field>
          </div>
          <Field label="提供範囲" htmlFor="terms-scope" hint="ページ数・修正回数・納期・含まない作業など">
            <Textarea {...props("scope")} rows={3} maxLength={10_000} />
            {feedback("scope")}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="販売価格（円）" htmlFor="terms-price" hint="空欄は未設定。0円と区別します。">
              <Input
                {...props("price")}
                inputMode="numeric"
                maxLength={30}
                placeholder="未設定"
                className="tabular-nums"
              />
              {feedback("price")}
            </Field>
            <Field label="月額（円）" htmlFor="terms-monthlyFee" hint="任意。報酬の計算には含みません。">
              <Input
                {...props("monthlyFee")}
                inputMode="numeric"
                maxLength={30}
                placeholder="未設定"
                className="tabular-nums"
              />
              {feedback("monthlyFee")}
            </Field>
          </div>
          <Field label="報酬の決め方" htmlFor="terms-rewardType">
            <NativeSelect {...props("rewardType")}>
              <option value="">未設定</option>
              <option value="fixed">契約1件につき定額</option>
              <option value="rate">販売価格に対する割合（%）</option>
            </NativeSelect>
            {feedback("rewardType")}
          </Field>
          {draft.rewardType !== "" && (
            <Field
              label={draft.rewardType === "rate" ? "報酬の割合（%）" : "契約1件の報酬（円）"}
              htmlFor="terms-rewardValue"
              hint={
                draft.rewardType === "rate"
                  ? "0〜100%。小数第2位まで入力できます。円未満は切り捨てます。"
                  : "0円以上の整数。3桁区切りのカンマを使えます。"
              }
            >
              <Input
                {...props("rewardValue")}
                inputMode={draft.rewardType === "rate" ? "decimal" : "numeric"}
                maxLength={30}
                className="tabular-nums"
                required
              />
              {feedback("rewardValue")}
            </Field>
          )}
        </fieldset>
        <section
          aria-labelledby="terms-preview-title"
          className="min-w-0 rounded-xl border bg-muted/30 p-4 lg:sticky lg:top-24"
        >
          <h3 id="terms-preview-title" className="font-semibold">
            保存する内容の確認
          </h3>
          <p className="mt-1 break-words text-sm text-muted-foreground">
            {draft.name.trim() || "名称は未入力"} · {draft.version.trim() || "版名は未入力"}
          </p>
          <dl className="mt-4 space-y-4 text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <dt>販売価格</dt>
              <dd className="font-semibold tabular-nums">
                {inspection.price === undefined
                  ? "入力を確認"
                  : inspection.price === null
                    ? "未設定"
                    : yen(inspection.price)}
              </dd>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <dt>月額</dt>
              <dd className="font-semibold tabular-nums">
                {inspection.monthlyFee === undefined
                  ? "入力を確認"
                  : inspection.monthlyFee === null
                    ? "未設定"
                    : `${yen(inspection.monthlyFee)} / 月`}
              </dd>
            </div>
            <div className="border-t pt-4">
              <dt>契約1件あたりの報酬</dt>
              <dd className="mt-1 font-bold text-2xl tabular-nums">
                {inspection.rewardAmount === null ? "—" : yen(inspection.rewardAmount)}
              </dd>
              <dd className="mt-1 text-muted-foreground text-xs">
                {inspection.errors.rewardValue
                  ? "報酬の入力を確認してください。"
                  : inspection.rewardRule?.type === "rate"
                    ? `販売価格の ${inspection.rewardRule.basisPoints / 100}%${inspection.price === null || inspection.price === undefined ? "。販売価格を入力すると計算します。" : "（円未満切り捨て）"}`
                    : inspection.rewardRule?.type === "fixed"
                      ? "契約完了で発生する定額の報酬です。"
                      : "報酬条件は未設定です。"}
              </dd>
            </div>
          </dl>
          <p
            className={`mt-4 rounded-lg p-3 text-xs ${ready ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"}`}
          >
            {ready
              ? "価格・報酬は設定済みです。保存後、案件への適用は別の操作で行います。"
              : inspection.errors.price || inspection.errors.monthlyFee || inspection.errors.rewardValue
                ? "金額・報酬の入力を確認してください。誤った値は保存しません。"
                : "未設定の価格・報酬がある版では、営業を開始できません。"}
          </p>
        </section>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t pt-4">
        {saved ? (
          <Button type="button" variant="outline" onClick={onNew}>
            別の版を作成する
          </Button>
        ) : (
          <Button type="submit" disabled={pending}>
            {pending ? "保存中…" : "この内容で新しい版を保存"}
          </Button>
        )}
        <p className="text-xs text-muted-foreground">既存の版は上書きしません。完了した契約の金額は変わりません。</p>
      </div>
    </form>
  );
}
