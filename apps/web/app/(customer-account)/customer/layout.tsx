import Link from "next/link";
import type { ReactNode } from "react";
import { logoutAction } from "@/app/(auth)/actions";
import { Brand } from "@/components/shell/brand";
import { requireUser } from "@/lib/session";
import { listTeamAdminCompanies } from "./team/companies";
export const metadata = { title: "記事の更新 | SiteOffer", robots: { index: false, follow: false } };
export default async function Layout({ children }: { children: ReactNode }) {
  const user = await requireUser("customer");
  // 「担当者の管理」は管理者のときだけ出す（T23の(c)）。画面側でも core が管理者か確かめる
  const { admin } = await listTeamAdminCompanies(user.actor);
  return (
    <div className="min-h-dvh bg-slate-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div className="flex flex-wrap items-center gap-5">
            <Brand />
            <nav aria-label="顧客メニュー" className="flex gap-4 text-sm">
              <Link href="/customer/content">記事の更新</Link>
              <Link href="/customer/materials">写真・ロゴ</Link>
              {admin.length > 0 && <Link href="/customer/team">担当者の管理</Link>}
            </nav>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span>{user.displayName} さん</span>
            <Link href="/account/security" className="underline">
              安全設定
            </Link>
            <form action={logoutAction}>
              <button type="submit" className="underline">
                ログアウト
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8">{children}</main>
    </div>
  );
}
