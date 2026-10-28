"use client";

import { ChevronUp, LogOut, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { logoutAction } from "@/app/(auth)/actions";

/** サイドバー左下のアカウント欄。押すと安全設定・ログアウトを開く（運営・営業で共通） */
export function AccountMenu({ userName, roleLabel }: { userName: string; roleLabel: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();
  // 画面を移ったら閉じる
  useEffect(() => {
    if (pathname && ref.current) ref.current.open = false;
  }, [pathname]);
  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const menu = ref.current;
      if (menu?.open && !menu.contains(event.target as Node)) menu.open = false;
    }
    function onKeyDown(event: KeyboardEvent) {
      const menu = ref.current;
      if (event.key !== "Escape" || !menu?.open) return;
      menu.open = false;
      menu.querySelector("summary")?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  return (
    <details ref={ref} className="ops-account">
      <summary
        className="ops-account-summary"
        aria-label={`${userName}（${roleLabel}）のアカウントメニュー`}
        title="安全設定・ログアウト"
      >
        <span className="ops-avatar">{userName.slice(0, 1)}</span>
        <div className="ops-account-name">
          <strong>{userName}</strong>
          <small>{roleLabel}</small>
        </div>
        <ChevronUp size={16} aria-hidden="true" className="ops-account-chevron" />
      </summary>
      <div className="ops-account-menu">
        <Link href="/account/security">
          <ShieldCheck size={16} aria-hidden="true" />
          安全設定
        </Link>
        <form action={logoutAction}>
          <button type="submit">
            <LogOut size={16} aria-hidden="true" />
            ログアウト
          </button>
        </form>
      </div>
    </details>
  );
}
