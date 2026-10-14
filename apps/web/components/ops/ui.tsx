import {
  ClipboardCheck,
  FileSignature,
  LayoutDashboard,
  LogOut,
  PackageCheck,
  Search,
  Settings,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { logoutAction } from "@/app/(auth)/actions";
import { Brand } from "@/components/shell/brand";
import { NavLink } from "@/components/shell/nav-link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/** 運営画面の共通部品（Tailwind ＋ shadcn/ui） */

export const NAV_ITEMS = [
  { href: "/ops", label: "概要", icon: LayoutDashboard, exact: true },
  { href: "/ops/discovery", label: "収集・候補", icon: Search },
  { href: "/ops/review", label: "診断・レビュー・営業可能化", icon: ClipboardCheck },
  { href: "/ops/assignments", label: "担当・営業拒否・引き継ぎ", icon: Users },
  { href: "/ops/contracts", label: "商品条件・契約・入金・報酬", icon: FileSignature },
  { href: "/ops/delivery", label: "制作・ドメイン希望", icon: PackageCheck },
  { href: "/ops/settings", label: "設定・操作履歴", icon: Settings },
] as const;

const linkBase =
  "flex items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sm no-underline transition-colors hover:no-underline [&_svg]:size-4 [&_svg]:shrink-0";

export function OpsShell({ userName, children }: { userName: string; children: ReactNode }) {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_1fr]">
      <aside className="sticky top-0 z-20 bg-sidebar text-sidebar-foreground lg:h-dvh lg:overflow-y-auto">
        <div className="flex items-center justify-between gap-2 px-4 py-3 lg:py-5">
          <Brand label="運営" />
          <form action={logoutAction} className="lg:hidden">
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              <LogOut />
              ログアウト
            </Button>
          </form>
        </div>
        <nav aria-label="運営メニュー" className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-col lg:px-3">
          {NAV_ITEMS.map((item, i) => (
            <NavLink
              key={item.href}
              href={item.href}
              exact={"exact" in item && item.exact}
              className={`${linkBase} text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground`}
              activeClassName="bg-sidebar-accent font-medium text-sidebar-foreground"
            >
              <item.icon aria-hidden="true" />
              <span>
                {i > 0 ? <span className="mr-1 tabular-nums opacity-60">{i}.</span> : null}
                {item.label}
              </span>
            </NavLink>
          ))}
        </nav>
        <div className="hidden border-sidebar-accent border-t px-4 py-4 lg:block">
          <div className="mb-2 text-sidebar-muted text-xs">ログイン中</div>
          <div className="mb-3 truncate text-sm">{userName}（運営）</div>
          <form action={logoutAction}>
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              className="w-full justify-start text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              <LogOut />
              ログアウト
            </Button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <div className="mx-auto max-w-7xl">{children}</div>
      </main>
    </div>
  );
}

type SearchParams = Record<string, string | string[] | undefined>;

export function first(sp: SearchParams, key: string): string | undefined {
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}

/** 処理結果（Server Function からの戻り先の msg / error） */
export function Flash({ searchParams }: { searchParams: SearchParams }) {
  const msg = first(searchParams, "msg");
  const error = first(searchParams, "error");
  return (
    <>
      {msg ? (
        <Alert variant="success" className="mb-4">
          <AlertDescription>{msg}</AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive" role="alert" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

/** 戻り先を Server Function に渡す隠し項目 */
export function ReturnTo({ path }: { path: string }) {
  return <input type="hidden" name="returnTo" value={path} />;
}

export function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  return (
    <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function Forbidden() {
  return (
    <Alert variant="destructive">
      <AlertDescription>運営だけが閲覧できます。</AlertDescription>
    </Alert>
  );
}
