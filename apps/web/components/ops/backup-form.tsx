"use client";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useRef } from "react";
import { backupAction } from "@/app/(ops)/ops/backups/actions";
import { useBackupRuntime } from "@/components/ops/backup-runtime";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function BackupForm({ backupId, disabled = false }: { backupId?: string; disabled?: boolean }) {
  const runtime = useBackupRuntime();
  const blocked = disabled || (runtime !== null && (!runtime.available || runtime.busy));
  const [state, action, pending] = useActionState(backupAction, { nonce: "", ok: false, message: "" });
  const router = useRouter(),
    prefix = useId(),
    form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.nonce) {
      form.current?.reset();
      router.refresh();
    }
  }, [state.nonce, router]);
  return (
    <form ref={form} action={action} className="space-y-4" aria-busy={pending}>
      <input type="hidden" name="command" value={backupId ? "verify" : "backup"} />
      {backupId && <input type="hidden" name="backupId" value={backupId} />}
      <div className={backupId ? "space-y-3" : "grid gap-4 sm:grid-cols-2"}>
        <div className="space-y-1.5">
          <label htmlFor={`${prefix}-password`} className="text-sm font-medium">
            {backupId ? "保存時のパスフレーズ" : "保存用パスフレーズ"}
          </label>
          <Input
            id={`${prefix}-password`}
            type="password"
            name="password"
            autoComplete="off"
            required
            minLength={12}
            maxLength={1024}
            disabled={pending || blocked}
            aria-describedby={`${prefix}-help`}
          />
        </div>
        {!backupId && (
          <div className="space-y-1.5">
            <label htmlFor={`${prefix}-confirmation`} className="text-sm font-medium">
              パスフレーズを再入力
            </label>
            <Input
              id={`${prefix}-confirmation`}
              type="password"
              name="confirmation"
              autoComplete="off"
              required
              minLength={12}
              maxLength={1024}
              disabled={pending || blocked}
            />
          </div>
        )}
      </div>
      <p id={`${prefix}-help`} className="text-xs text-muted-foreground">
        12〜1024文字。パスフレーズは保存しません。忘れると復元できないため、安全な場所に保管してください。
      </p>
      <Button type="submit" disabled={pending || blocked}>
        {pending ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}
        {pending ? "保存・復元を確認しています…" : backupId ? "このバックアップを再検証" : "バックアップを作成して確認"}
      </Button>
      {pending && (
        <p role="status" className="text-sm text-muted-foreground">
          データ量によって数分かかります。画面へ戻った場合は、上部の状況と保存済み一覧を再確認してください。
        </p>
      )}
      {state.message && (
        <p
          role="status"
          className={`rounded-lg border p-3 text-sm ${state.ok ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-950"}`}
        >
          {state.message}
        </p>
      )}
    </form>
  );
}
