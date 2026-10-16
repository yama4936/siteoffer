import type { ReactNode } from "react";
import { logoutAction } from "@/app/(auth)/actions";
import { Brand } from "@/components/shell/brand";
import { requireUser } from "@/lib/session";
export const metadata = { title: "記事の更新 | SiteOffer", robots: { index: false, follow: false } };
export default async function Layout({ children }: { children: ReactNode }) {
  const user = await requireUser("customer");
  return (
    <div className="min-h-dvh bg-slate-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-4">
          <Brand />
          <div className="flex items-center gap-4 text-sm">
            <span>{user.displayName} さん</span>
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
