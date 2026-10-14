"use client";

// 顧客確認に回すフォーム。顧客に渡すURLはこの画面の状態にだけ持ち、再表示はしない。
// 送信後に画面を最新化しても表示中のURLが消えないよう、運営確認中・顧客確認中の両方で同じ位置に置く。
import { ExternalLink } from "lucide-react";
import { useActionState, useId } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import type { CustomerReviewLinkAction } from "@/lib/ops/delivery-state";

export function CustomerReviewForm({
  action,
  deliveryId,
  versions,
  reissue,
}: {
  action: CustomerReviewLinkAction;
  deliveryId: string;
  /** 回せる版（新しい順）。顧客確認中は確認中の版だけ */
  versions: { id: string; label: string }[];
  /** 顧客確認中の同じ版のリンクを再発行する */
  reissue: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const id = useId();
  return (
    <div className="space-y-3">
      <form action={formAction} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="deliveryId" value={deliveryId} />
        <Field label="版" htmlFor={`${id}-version`}>
          <NativeSelect id={`${id}-version`} name="versionId" defaultValue={versions[0]?.id} className="w-56">
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="有効期間（時間・空欄は既定）" htmlFor={`${id}-ttl`}>
          <Input id={`${id}-ttl`} name="ttlHours" inputMode="numeric" size={5} className="w-28 tabular-nums" />
        </Field>
        <Button type="submit" size="sm" disabled={pending}>
          {reissue ? "顧客確認のリンクを再発行する" : "この版を顧客確認に回す"}
        </Button>
      </form>
      {state?.status === "error" ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            <p>{state.message}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {state?.status === "ok" && state.reviewUrl ? (
        <Alert variant="success">
          <AlertDescription className="gap-2">
            <p className="font-medium text-foreground">{state.message}</p>
            <p className="text-muted-foreground">
              顧客確認のURL（有効期限：
              {state.expiresAt ? new Date(state.expiresAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "—"}）
            </p>
            <Input
              type="text"
              readOnly
              value={state.reviewUrl}
              className="w-full font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <p>
              <a
                href={state.reviewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1"
              >
                顧客確認の画面を開く（別ウィンドウ・デモ用）
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
