"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useActionState, useEffect, useId, useRef, useState, useTransition } from "react";
import { type RetentionActionState, retentionAction } from "@/app/(ops)/ops/backups/storage/actions";
import { useBackupRuntime } from "@/components/ops/backup-runtime";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  backupBytes,
  type RetentionRequest,
  type StoredBackup,
  type StoredBatch,
} from "../../../../demo/backup/retention-protocol.ts";

const initial: RetentionActionState = { nonce: "", ok: false, message: "" };
export function StorageRefresh({ href }: { href: string }) {
  const router = useRouter(),
    [pending, start] = useTransition();
  return (
    <a
      href={href}
      className={buttonVariants({ variant: "outline" })}
      aria-disabled={pending}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (!pending) start(() => router.refresh());
      }}
    >
      {pending ? "保管一覧を更新しています…" : "保管一覧を更新"}
    </a>
  );
}
export function RetentionForm({
  request,
  children,
  label,
  disabled = false,
  danger = false,
}: {
  request: Record<string, unknown>;
  children?: ReactNode;
  label: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  const [state, action, pending] = useActionState(retentionAction, initial),
    form = useRef<HTMLFormElement>(null),
    router = useRouter(),
    runtime = useBackupRuntime();
  useEffect(() => {
    if (state.nonce) {
      form.current?.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((input) => {
        input.value = "";
      });
      const confirmed = form.current?.querySelector<HTMLInputElement>('input[name="confirmed"]');
      if (confirmed) confirmed.checked = false;
      router.refresh();
    }
  }, [state.nonce, router]);
  const blocked = disabled || pending || (!!runtime && (!runtime.available || runtime.busy));
  return (
    <form action={action} ref={form} className="space-y-3" aria-busy={pending}>
      <input type="hidden" name="request" value={JSON.stringify(request)} />
      <fieldset disabled={blocked} className="space-y-3">
        {children}
        <Button type="submit" variant={danger ? "destructive" : "outline"} disabled={blocked}>
          {pending ? "保管状態を確認しています…" : label}
        </Button>
      </fieldset>
      {state.message && (
        <p
          role="status"
          className={`rounded-lg border p-3 text-sm ${state.ok ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-950"}`}
        >
          {state.message}
        </p>
      )}
      {state.batch && (
        <Link href={`/ops/backups/storage?batch=${state.batch.id}`} className="block text-sm text-primary underline">
          この整理操作の結果を見る
        </Link>
      )}
    </form>
  );
}
export function RetentionPlanner() {
  const [state, action, pending] = useActionState(retentionAction, initial),
    [keepCount, setCount] = useState("3"),
    [ageDays, setDays] = useState("30"),
    runtime = useBackupRuntime(),
    id = useId();
  const blocked = pending || (!!runtime && (!runtime.available || runtime.busy));
  const plan = state.plan,
    edited = !!plan && (Number(keepCount) !== plan.policy.keepCount || Number(ageDays) !== plan.policy.ageDays);
  return (
    <div className="space-y-5">
      <form action={action} className="space-y-4" aria-busy={pending}>
        <input
          type="hidden"
          name="request"
          value={JSON.stringify({ operation: "plan" } satisfies Partial<RetentionRequest>)}
        />
        <fieldset disabled={blocked} className="flex flex-wrap items-end gap-4">
          <label className="space-y-1 text-sm" htmlFor={`${id}-keep`}>
            <span className="block">新しい保存を残す件数</span>
            <Input
              id={`${id}-keep`}
              name="keepCount"
              type="number"
              min="1"
              max="1000"
              value={keepCount}
              onChange={(event) => setCount(event.target.value)}
              required
              className="w-40"
            />
          </label>
          <label className="space-y-1 text-sm" htmlFor={`${id}-days`}>
            <span className="block">経過日数</span>
            <Input
              id={`${id}-days`}
              name="ageDays"
              type="number"
              min="0"
              max="3650"
              value={ageDays}
              onChange={(event) => setDays(event.target.value)}
              required
              className="w-40"
            />
          </label>
          <Button type="submit" disabled={blocked}>
            {pending ? "候補を確認しています…" : "整理候補を確認"}
          </Button>
        </fieldset>
        <p className="text-xs leading-6 text-muted-foreground">
          保護した保存と直近の復元確認済みデータを残します。0日は日付を絞らず件数で整理します。初期表示の3件・30日は提案値で、自動削除の設定ではありません。
        </p>
      </form>
      {state.message && (
        <p role="status" className="text-sm">
          {state.message}
        </p>
      )}
      {plan && (
        <section className="space-y-4 rounded-xl border p-4" aria-label="整理候補の確認">
          <h3 className="font-semibold">
            退避する候補：{plan.candidates.length}件・{backupBytes(plan.bytes)}
          </h3>
          <p className="text-sm">
            新しい{plan.policy.keepCount}件と保護指定・直近の復元確認済みを残し、
            {plan.policy.ageDays === 0 ? "日付を絞らず" : `${plan.policy.ageDays}日より前の保存から`}
            選びました。今回残す保存：{plan.preserved}件。
          </p>
          {plan.eligible > plan.candidates.length && (
            <p className="text-sm">
              対象は合計{plan.eligible}件です。今回は先頭の{plan.candidates.length}
              件を整理します。残りは結果を確認してから続けられます。
            </p>
          )}
          <p className="break-all font-mono text-xs text-muted-foreground">保存先：{plan.root}</p>
          <ul className="max-h-80 space-y-2 overflow-auto">
            {plan.candidates.map((item) => (
              <li key={item.id} className="rounded-lg bg-muted/40 p-3 text-xs">
                <code className="block break-all">{item.path}</code>
                <span>
                  {backupBytes(item.bytes)}・{item.files}ファイル・リンク／共有なし
                </span>
              </li>
            ))}
          </ul>
          {edited && (
            <p role="status" className="text-sm text-amber-800">
              条件を変更しました。「整理候補を確認」を押して候補を更新してください。
            </p>
          )}
          {!!plan.candidates.length && (
            <RetentionForm
              key={plan.token}
              request={{ operation: "move", policy: plan.policy, token: plan.token }}
              label="候補を退避先へ移す"
              disabled={edited || blocked}
            >
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="confirmed" required className="mt-1" />
                <span>
                  対象と残す条件を確認しました。退避先も同じディスクを使い、完全削除するまで容量を使うことを確認しました。
                </span>
              </label>
            </RetentionForm>
          )}
        </section>
      )}
    </div>
  );
}
export function PurgeRetention({ batch, keepers }: { batch: StoredBatch; keepers: StoredBackup[] }) {
  const id = useId();
  return (
    <RetentionForm
      request={{ operation: "purge", id: batch.id }}
      label="復元確認して完全削除する"
      disabled={!keepers.length || batch.moved < 1}
      danger
    >
      <p className="text-sm leading-7">
        完全削除は元に戻せません。残すバックアップを別フォルダーで実際に復元し、照合が成功した後に、この退避先の記録済みファイルだけを削除します。途中で止まった場合も保管一覧から再開できます。
      </p>
      <p className="text-xs text-muted-foreground">新しい復元確認済みの保存から最大20件を表示します。</p>
      <label htmlFor={`${id}-keeper`} className="block space-y-1 text-sm">
        <span>残すバックアップ</span>
        <select
          id={`${id}-keeper`}
          name="keeper"
          required
          className="h-10 w-full min-w-0 rounded-lg border bg-background px-3 text-xs"
        >
          {keepers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.savedAt.slice(0, 10)} / {item.id}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`${id}-password`} className="block space-y-1 text-sm">
        <span>残すバックアップのパスフレーズ</span>
        <Input
          id={`${id}-password`}
          name="password"
          type="password"
          autoComplete="off"
          required
          minLength={12}
          maxLength={1024}
        />
      </label>
      {!keepers.length && (
        <p className="text-sm text-amber-900">
          選べる復元確認済みの保存がありません。先に新しいバックアップを作成して確認してください。
        </p>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="confirmed" required className="mt-1" />
        <span>
          上の対象・容量・保管場所を確認し、この退避データが今後不要で、完全削除すると元に戻せないことを確認しました。
        </span>
      </label>
    </RetentionForm>
  );
}
