"use client";
import { useEffect, useState } from "react";
import { pendingMaterialCountAction } from "@/app/image-submission-actions";
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
      try {
        const r = await pendingMaterialCountAction();
        if (!disposed && version === expected) {
          setFailed(!r.ok);
          if (r.ok) setCount(r.count);
        }
      } catch {
        if (!disposed && version === expected) setFailed(true);
      } finally {
        running = false;
        if (queued && !disposed) {
          queued = false;
          void update();
        }
      }
    }
    function changed() {
      version++;
      void update();
    }
    const wake = () => void update();
    const timer = window.setInterval(wake, 30000);
    window.addEventListener(MATERIALS_CHANGED_EVENT, changed);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener(MATERIALS_CHANGED_EVENT, changed);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
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
