"use client";

// 「提案を共有」のフォーム。発行したURLはこの画面の状態にだけ持ち、再表示はしない（再発行で対応）。
// 権限・承認状態・営業抑止の判定はサーバー側（core の share-link）で行う。
import { ExternalLink, Link2 } from "lucide-react";
import { useActionState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import type { SalesAction } from "@/lib/sales/action-state";
import { ActionMessage } from "./forms";

const TTL_OPTIONS = [
  { value: "", label: "既定（運営設定の期間）" },
  { value: "24", label: "24時間" },
  { value: "72", label: "3日" },
  { value: "168", label: "7日" },
] as const;

export function IssueShareForm({ action, proposalVersionId }: { action: SalesAction; proposalVersionId: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="grid max-w-xl gap-4">
      <input type="hidden" name="proposalVersionId" value={proposalVersionId} />
      <div className="flex flex-wrap items-end gap-3">
        <Field label="有効期間" htmlFor={`share-ttl-${proposalVersionId}`} className="min-w-48 flex-1">
          <NativeSelect id={`share-ttl-${proposalVersionId}`} name="ttlHours" defaultValue="">
            {TTL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Button type="submit" disabled={pending}>
          <Link2 />
          {pending ? "発行しています…" : "共有リンクを発行する"}
        </Button>
      </div>
      <ActionMessage state={state} />
      {state?.status === "ok" && state.shareUrl && (
        <Alert variant="info">
          <Link2 />
          <AlertTitle>
            共有URL（有効期限：
            {state.shareExpiresAt
              ? new Date(state.shareExpiresAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
              : "—"}
            ）
          </AlertTitle>
          <AlertDescription className="gap-2">
            <Input
              type="text"
              readOnly
              value={state.shareUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="font-mono text-xs"
            />
            <p>
              <a
                href={state.shareUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
              >
                改善デモを開いて確認する（別ウィンドウ）
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>
            </p>
            <p className="text-muted-foreground text-xs">
              このURLは今だけ表示しています。再表示はできないため、控え忘れた場合は取り消して新しく発行してください。
            </p>
          </AlertDescription>
        </Alert>
      )}
    </form>
  );
}

export function RevokeShareButton({ action, linkId }: { action: SalesAction; linkId: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="grid gap-2">
      <input type="hidden" name="linkId" value={linkId} />
      <Button type="submit" variant="outline" size="xs" className="w-fit" disabled={pending}>
        取り消す
      </Button>
      <ActionMessage state={state} />
    </form>
  );
}
