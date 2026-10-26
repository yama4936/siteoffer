"use client";
import { ArrowRight, Bell, LoaderCircle, RefreshCw, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { type AttentionRole, type AttentionSummary, parseAttentionSummary } from "@/lib/attention-model";
import { CONSULTATION_READ_EVENT } from "@/lib/client/consultation-events";
import { readPrivateJson } from "@/lib/client/private-json";
import "./attention.css";

export function WorkspaceAttention({ role }: { role: AttentionRole }) {
  const pathname = usePathname(),
    id = useId();
  const dialog = useRef<HTMLDialogElement>(null),
    openRef = useRef(false),
    request = useRef<(() => void) | null>(null);
  const [ready, setReady] = useState(false),
    [open, setOpen] = useState(false),
    [pending, setPending] = useState(false);
  const [data, setData] = useState<AttentionSummary | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let disposed = false,
      busy = false,
      denied = false,
      refreshAfterFlight = false,
      lastStarted = 0;
    let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
    setReady(true);
    function schedule() {
      clearTimeout(timer);
      if (!disposed && !denied) timer = setTimeout(() => void load(), openRef.current ? 15000 : 60000);
    }
    async function load() {
      if (disposed || busy) return;
      clearTimeout(timer);
      if (document.hidden) {
        schedule();
        return;
      }
      busy = true;
      lastStarted = Date.now();
      denied = false;
      controller = new AbortController();
      setPending(true);
      try {
        const { response, body } = await readPrivateJson("/workspace/attention", {
          signal: controller.signal,
          timeoutMs: 5000,
          retryOnce: true,
        });
        if (disposed) return;
        const payload = body as { ok?: boolean; result?: { role?: unknown } } | null;
        if ([401, 403].includes(response.status) || (payload?.ok && payload.result?.role !== role)) {
          denied = true;
          setData(null);
          setError("利用権限を確認できません。ログインし直してください。");
          return;
        }
        const next = response.ok && payload?.ok ? parseAttentionSummary(payload.result, role) : null;
        if (!next) throw new Error("Invalid attention response");
        setData(next);
        setError("");
      } catch {
        if (!disposed) setError("最新の対応を確認できません。接続を確認し、もう一度更新してください。");
      } finally {
        busy = false;
        if (!disposed) {
          setPending(false);
          if (refreshAfterFlight && !denied) {
            refreshAfterFlight = false;
            timer = setTimeout(() => void load(), 0);
          } else schedule();
        }
      }
    }
    function wake() {
      if (!document.hidden && !denied && Date.now() - lastStarted > 5000) void load();
    }
    function changed() {
      if (denied || disposed) return;
      if (busy) refreshAfterFlight = true;
      else void load();
    }
    request.current = () => void load();
    void load();
    window.addEventListener("focus", wake);
    window.addEventListener(CONSULTATION_READ_EVENT, changed);
    document.addEventListener("visibilitychange", wake);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      request.current = null;
      window.removeEventListener("focus", wake);
      window.removeEventListener(CONSULTATION_READ_EVENT, changed);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [role]);
  useEffect(() => {
    if (pathname) request.current?.();
  }, [pathname]);
  function close() {
    dialog.current?.close();
    openRef.current = false;
    setOpen(false);
  }
  const label = error
    ? "対応のお知らせ（更新できません）"
    : data
      ? `対応のお知らせ（${data.total}件）`
      : "対応のお知らせ";
  const checked = data
    ? new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(data.checkedAt))
    : null;
  return (
    <>
      <button
        type="button"
        className="attention-trigger"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        disabled={!ready}
        onClick={() => {
          dialog.current?.showModal();
          openRef.current = true;
          setOpen(true);
          request.current?.();
        }}
      >
        <Bell aria-hidden="true" size={20} />
        {(error || (data && data.total > 0)) && (
          <span className={error ? "attention-badge is-stale" : "attention-badge"} aria-hidden="true">
            {error ? "!" : data!.total > 99 ? "99+" : data!.total}
          </span>
        )}
      </button>
      <dialog
        ref={dialog}
        id={id}
        className="attention-dialog"
        aria-labelledby={`${id}-title`}
        onCancel={close}
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
        }}
        onClose={() => {
          openRef.current = false;
          setOpen(false);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            const box = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < box.left ||
              event.clientX > box.right ||
              event.clientY < box.top ||
              event.clientY > box.bottom
            )
              close();
          }
        }}
      >
        <div className="attention-heading">
          <div>
            <h2 id={`${id}-title`}>対応のお知らせ</h2>
            <p>いま必要な確認を、ここから進められます。</p>
          </div>
          <button type="button" className="attention-icon" aria-label="お知らせを閉じる" onClick={close}>
            <X size={20} />
          </button>
        </div>
        <div className="attention-tools">
          <span>{data ? `${data.total}件の対応` : pending ? "確認しています…" : "まだ取得できていません"}</span>
          <button type="button" onClick={() => request.current?.()} disabled={pending} className="attention-refresh">
            {pending ? <LoaderCircle className="animate-spin" size={14} /> : <RefreshCw size={14} />}
            {pending ? "更新中" : "最新に更新"}
          </button>
        </div>
        <div className="attention-content" aria-busy={pending}>
          {error && (
            <div role="alert" className="attention-error">
              <p>{error}</p>
              {data && <p>前回取得した内容を表示しています。</p>}
            </div>
          )}
          {data &&
            (data.total === 0 ? (
              <p className="attention-empty">いま確認できる対応待ちはありません。</p>
            ) : (
              <>
                <nav aria-label="対応の種類" className="attention-groups">
                  {data.groups.map((group) => (
                    <Link key={group.key} href={group.href} onClick={close} prefetch={false}>
                      {group.label}
                      <b>{group.count}</b>
                    </Link>
                  ))}
                </nav>
                <p className="attention-caption">
                  優先する対応
                  {data.total > data.items.length ? `（全${data.total}件のうち${data.items.length}件）` : ""}
                </p>
                <ul className="attention-list">
                  {data.items.map((item) => (
                    <li key={item.key}>
                      <Link href={item.href} onClick={close} prefetch={false}>
                        <small>{data.groups.find((group) => group.key === item.group)?.label}</small>
                        <strong>{item.title}</strong>
                        <p>{item.reason}</p>
                        <span>
                          {item.action}
                          <ArrowRight size={14} aria-hidden="true" />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            ))}
          {!data && pending && (
            <p className="attention-empty" role="status">
              最新の対応を確認しています。
            </p>
          )}
        </div>
        <div className="attention-footer">
          <Link href={role === "ops" ? "/ops" : "/sales/assignments"} onClick={close} prefetch={false}>
            {role === "ops" ? "今日の仕事をすべて見る" : "担当案件をすべて見る"}
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
          <p>
            {checked
              ? `${error ? "前回の確認" : "最終確認"} ${checked}（日本時間）`
              : "画面が表示されている間、自動で確認します。"}
          </p>
        </div>
      </dialog>
    </>
  );
}
