import { LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { Brand } from "@/components/shell/brand";
import { NavLink } from "@/components/shell/nav-link";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/session";
import { logoutAction } from "../(auth)/actions";

const NAV = [
  { href: "/sales/companies", label: "企業一覧" },
  { href: "/sales/assignments", label: "担当案件" },
  { href: "/sales/earnings", label: "実績・報酬" },
] as const;

/** 営業ユーザーの画面（16章）。未ログインは /login、営業以外は / へ移動する */
export default async function SalesLayout({ children }: { children: ReactNode }) {
  const user = await requireUser("sales");
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b bg-card/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
          <Brand label="営業" />
          <nav
            aria-label="営業メニュー"
            className="order-3 -mx-1 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto"
          >
            {NAV.map((item) => (
              <NavLink
                key={item.href}
                href={item.href}
                className="whitespace-nowrap rounded-md px-3 py-1.5 text-muted-foreground text-sm no-underline transition-colors hover:bg-accent hover:text-accent-foreground hover:no-underline"
                activeClassName="bg-accent font-medium text-accent-foreground"
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <span className="hidden text-muted-foreground sm:inline">{user.displayName} さん</span>
            <form action={logoutAction}>
              <Button type="submit" variant="ghost" size="sm">
                <LogOut />
                ログアウト
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:py-8">{children}</main>
    </div>
  );
}
