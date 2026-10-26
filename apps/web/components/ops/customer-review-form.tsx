"use client";
import { startTransition, useId, useRef, useState } from "react";
import { CustomerReviewLinkResult } from "@/components/ops/customer-review-link-result";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import type { CustomerReviewLinkAction, CustomerReviewLinkState } from "@/lib/ops/delivery-state";
export function CustomerReviewForm({
  action,
  deliveryId,
  versions,
  reissue,
}: {
  action: CustomerReviewLinkAction;
  deliveryId: string;
  versions: { id: string; label: string }[];
  reissue: boolean;
}) {
  const id = useId(),
    sending = useRef(false);
  const [version, setVersion] = useState(versions[0]?.id ?? ""),
    [ttl, setTtl] = useState(""),
    [pending, setPending] = useState(false),
    [state, setState] = useState<CustomerReviewLinkState>();
  const attempt = useRef<{ key: string; version: string; ttl: string } | undefined>(undefined);
  async function submit() {
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    attempt.current ??= { key: crypto.randomUUID(), version, ttl };
    const fd = new FormData();
    fd.set("deliveryId", deliveryId);
    fd.set("versionId", attempt.current.version);
    fd.set("ttlHours", attempt.current.ttl);
    fd.set("requestKey", attempt.current.key);
    try {
      const r = await action(undefined, fd);
      setState(r);
      if (r?.status === "error") attempt.current = undefined;
    } catch {
      setState({
        status: "unknown",
        message: "発行結果を確認できませんでした。同じ発行を再確認してもリンクは増えません。",
      });
    } finally {
      sending.current = false;
      setPending(false);
    }
  }
  const locked = pending || state?.status === "unknown" || state?.status === "ok";
  return (
    <div className="space-y-3">
      {state?.status !== "ok" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            startTransition(submit);
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <Field label="版" htmlFor={`${id}-version`}>
            <NativeSelect
              id={`${id}-version`}
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              disabled={locked}
              className="w-56"
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="有効期間（時間・空欄は既定）" htmlFor={`${id}-ttl`}>
            <Input
              id={`${id}-ttl`}
              name="ttlHours"
              type="number"
              min="1"
              step="1"
              value={ttl}
              onChange={(e) => setTtl(e.target.value)}
              disabled={locked}
              className="w-28 tabular-nums"
            />
          </Field>
          <Button type="submit" size="sm" disabled={pending || !version}>
            {pending
              ? "発行を確認しています…"
              : state?.status === "unknown"
                ? "同じ発行を再確認"
                : reissue
                  ? "顧客確認のリンクを新しく発行する"
                  : "この版を顧客確認に回す"}
          </Button>
        </form>
      )}
      {reissue && (
        <p className="text-xs text-muted-foreground">
          控え忘れた場合は発行履歴から同じリンクを表示できます。新しく発行しても、既存のリンクは自動では取り消されません。
        </p>
      )}
      {state && state.status !== "ok" && (
        <p role="alert" className="text-sm text-amber-800">
          {state.message}
        </p>
      )}
      {state?.status === "ok" && (
        <>
          <p className="text-sm font-medium">
            共有する版：{versions.find((v) => v.id === state.versionId)?.label ?? "発行した制作版"}
          </p>
          <CustomerReviewLinkResult deliveryId={deliveryId} state={state} />
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => {
              attempt.current = undefined;
              setState(undefined);
            }}
          >
            別のリンクを発行する
          </Button>
        </>
      )}
    </div>
  );
}
