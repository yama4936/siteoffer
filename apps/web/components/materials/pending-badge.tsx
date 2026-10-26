"use client";
import { useEffect, useState } from "react";
import { readMaterialCount } from "@/lib/client/material-reads";
import { MATERIALS_CHANGED_EVENT } from "./shared";
export function PendingMaterialBadge({ initialCount }: { initialCount: number | null }) {
  const [count, setCount] = useState(initialCount),
    [failed, setFailed] = useState(initialCount === null);
  useEffect(() => {
    setCount(initialCount);
    setFailed(initialCount === null);
    let disposed = false,
      running = false,
      queued = false,
      version = 0;
    let controller: AbortController | null = null;
    async function update() {
      if (disposed || document.visibilityState === "hidden") return;
      if (running) {
        queued = true;
        return;
      }
      if (!navigator.onLine) {
        setFailed(true);
        return;
      }
      running = true;
      const expected = version;
      const request = new AbortController();
      controller = request;
      try {
        const r = await readMaterialCount(request.signal);
        if (!disposed && version === expected && !request.signal.aborted) {
          setFailed(!r.ok);
          if (r.ok) setCount(r.result);
        }
      } catch {
        if (!disposed && version === expected && !request.signal.aborted) setFailed(true);
      } finally {
        running = false;
        if (controller === request) controller = null;
        if (queued && !disposed) {
          queued = false;
          void update();
        }
      }
    }
    function changed() {
      version++;
      controller?.abort();
      void update();
    }
    const wake = () => {
      if (document.visibilityState === "hidden") controller?.abort();
      else void update();
    };
    const offline = () => {
      controller?.abort();
      setFailed(true);
    };
    const timer = window.setInterval(wake, 30000);
    window.addEventListener(MATERIALS_CHANGED_EVENT, changed);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", wake);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(timer);
      window.removeEventListener(MATERIALS_CHANGED_EVENT, changed);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [initialCount]);
  if (failed || count === null)
    return (
      <span
        role="status"
        aria-label="素材の確認待ち件数を取得できません"
        title="件数を取得できません。写真・ロゴの一覧で確認してください。"
        className="ml-auto shrink-0 rounded-full bg-white/15 px-1.5 text-xs"
      >
        ?
      </span>
    );
  if (count === 0) return null;
  return (
    <span
      role="status"
      aria-label={`写真・ロゴの確認待ち ${count}件`}
      title={`確認待ち ${count}件。30秒ごとに更新します。`}
      className="ml-auto min-w-5 shrink-0 rounded-full bg-blue-100 px-1.5 text-center text-xs text-blue-900"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
