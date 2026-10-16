"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { readConsultationAction, unreadConsultationCountAction } from "@/app/consultation-actions";
import { Button } from "@/components/ui/button";

const READ_EVENT = "siteoffer-consultation-read";

/** バッジはこの利用者の件数だけ。別画面の回答も、画面が見えている間に更新する。 */
export function ConsultationUnreadBadge({ initialCount }: { initialCount: number | null }) {
  const [count, setCount] = useState(initialCount);
  const [failed, setFailed] = useState(initialCount === null);
  useEffect(() => {
    setCount(initialCount);
    setFailed(initialCount === null);
  }, [initialCount]);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    async function update() {
      if (pending || disposed || document.visibilityState !== "visible") return;
      pending = true;
      try {
        const result = await unreadConsultationCountAction();
        if (!disposed) {
          setFailed(!result.ok);
          if (result.ok) setCount(result.value);
        }
      } catch {
        if (!disposed) setFailed(true);
      } finally {
        pending = false;
      }
    }
    const timer = setInterval(() => void update(), 30_000);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener(READ_EVENT, update);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener(READ_EVENT, update);
    };
  }, []);
  if (failed)
    return (
      <span
        className="ml-auto rounded-full bg-white/15 px-1.5 text-xs"
        role="status"
        aria-label="未読件数を確認できません"
        title="未読件数を確認できません。相談一覧で確認してください。"
      >
        ?
      </span>
    );
  if (!count) return null;
  return (
    <span
      className="ml-auto min-w-5 shrink-0 rounded-full bg-blue-100 px-1.5 py-0.5 text-center text-xs font-semibold text-blue-900"
      role="status"
      aria-label={`未読の相談 ${count}件`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** 最新の表示済み履歴が画面内で見えたときだけ記録する。SSR・先読みには副作用がない。 */
export function ConsultationReadMarker({ activityId, revision }: { activityId: string; revision: number }) {
  const router = useRouter();
  const marker = useRef<HTMLElement>(null);
  const [state, setState] = useState<"waiting" | "saving" | "saved" | "error">("waiting");
  const inFlight = useRef(false);
  const completed = useRef(false);
  async function mark() {
    if (inFlight.current || completed.current || document.visibilityState !== "visible") return;
    inFlight.current = true;
    setState("saving");
    try {
      const result = await readConsultationAction(activityId, revision);
      if (!result.ok) {
        setState("error");
        return;
      }
      completed.current = true;
      setState("saved");
      window.dispatchEvent(new Event(READ_EVENT));
      router.refresh();
    } catch {
      setState("error");
    } finally {
      inFlight.current = false;
    }
  }
  const markRef = useRef(mark);
  markRef.current = mark;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let visible = false;
    let attempted = false;
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      cancel();
      if (visible && !attempted && document.visibilityState === "visible")
        timer = setTimeout(() => {
          attempted = true;
          void markRef.current();
        }, 800);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = !!entry?.isIntersecting && entry.intersectionRatio >= 1;
        schedule();
      },
      { threshold: 1 },
    );
    if (marker.current) observer.observe(marker.current);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      cancel();
      observer.disconnect();
      document.removeEventListener("visibilitychange", schedule);
    };
  }, []);
  return (
    <section
      ref={marker}
      className="mb-5 rounded-lg border border-dashed p-3 text-sm text-muted-foreground"
      aria-label="相談の確認状態"
    >
      <p role="status">
        {state === "error"
          ? "確認状態を保存できたか確認できません。もう一度保存できます。"
          : state === "saved"
            ? "表示した更新を確認済みにしました。"
            : state === "saving"
              ? "確認状態を保存しています…"
              : "ここまで表示した更新を確認済みにします。"}
      </p>
      {state === "error" && (
        <Button variant="outline" size="sm" className="mt-2" onClick={() => void mark()}>
          確認状態の保存を再試行
        </Button>
      )}
    </section>
  );
}

export function ConsultationListRefresh() {
  const router = useRouter();
  const [pending, refresh] = useTransition();
  useEffect(() => {
    const timer = setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName ?? "")
      )
        refresh(() => router.refresh());
    }, 30_000);
    return () => clearInterval(timer);
  }, [router]);
  return (
    <Button variant="ghost" size="sm" disabled={pending} onClick={() => refresh(() => router.refresh())}>
      {pending ? "更新中…" : "一覧を更新"}
    </Button>
  );
}
