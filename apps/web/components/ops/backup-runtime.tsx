"use client";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { parseBackupRuntimeStatus } from "@/lib/ops/backup-status";
import type { BackupRuntimeStatus } from "@/lib/ops/backups";

const RuntimeContext = createContext<BackupRuntimeStatus | null>(null);
export function useBackupRuntime() {
  return useContext(RuntimeContext);
}
export function BackupRuntimePanel({ initial, children }: { initial: BackupRuntimeStatus; children: ReactNode }) {
  const [status, setStatus] = useState(initial),
    [retry, setRetry] = useState(0),
    [refreshNeeded, setRefreshNeeded] = useState(false),
    [denied, setDenied] = useState(false);
  const router = useRouter();
  useEffect(() => {
    setStatus(initial);
    setRefreshNeeded(false);
  }, [initial]);
  useEffect(() => {
    if (retry > 0) setDenied(false);
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      controller: AbortController | undefined,
      previousBusy = initial.busy,
      delay = 15000,
      unauthorized = false;
    async function read() {
      try {
        if (document.hidden) return;
        controller = new AbortController();
        const res = await fetch("/ops/backups/status", {
          cache: "no-store",
          credentials: "same-origin",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        });
        if (res.status === 401 || res.status === 403) {
          unauthorized = true;
          if (!disposed) setDenied(true);
          throw new Error("permission");
        }
        if (!res.ok) throw new Error("unavailable");
        const body = await res.json(),
          next = body?.ok ? parseBackupRuntimeStatus(body.result) : null;
        if (!next) throw new Error("invalid status");
        if (disposed) return;
        if (next.available && previousBusy && !next.busy) setRefreshNeeded(true);
        previousBusy = next.busy;
        delay = next.busy ? 2000 : 15000;
        setStatus(next);
        setDenied(false);
      } catch {
        if (!disposed) setStatus((current) => ({ ...current, available: false }));
      } finally {
        if (!disposed && !unauthorized) timer = setTimeout(read, delay);
      }
    }
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [initial.busy, retry]);
  const phase = {
    waiting: "DB処理の完了を待っています",
    snapshot: "DBの保存状態を取得しています",
    files: "成果物を照合しています",
    encrypt: "暗号化して保存しています",
    verify: "隔離環境で復元を確認しています",
  };
  return (
    <RuntimeContext value={status}>
      {!status.available ? (
        <div
          role="alert"
          className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
        >
          <p>
            {denied
              ? "利用権限を確認できません。運営アカウントでログインし直してください。"
              : "受付状況を確認できません。進行中の処理を完了済みとは扱っていません。接続が戻ると自動で再確認します。"}
          </p>
          <Button variant="outline" size="sm" onClick={() => setRetry((n) => n + 1)}>
            <RefreshCw />
            状況を再確認
          </Button>
        </div>
      ) : (
        status.busy && (
          <div
            role="status"
            className="mb-5 flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950"
          >
            <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" />
            <div>
              <strong>{status.phase ? phase[status.phase] : "処理の終了を待っています"}</strong>
              <p className="mt-1">
                {status.files > 0 ? `${status.files}ファイルを確認。` : ""}
                新しい保存・再検証は、現在の処理が終わってから行えます。
              </p>
            </div>
          </div>
        )
      )}
      {refreshNeeded && (
        <div
          role="status"
          className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 text-sm"
        >
          <p>処理が終了しました。保存結果を一覧で確認してください。</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRefreshNeeded(false);
              router.refresh();
            }}
          >
            <RefreshCw />
            保存済み一覧を更新
          </Button>
        </div>
      )}
      {children}
    </RuntimeContext>
  );
}
