import {
  ClipboardCheck,
  FileSignature,
  Images,
  KeyRound,
  LayoutDashboard,
  LogOut,
  MessageCircle,
  Newspaper,
  PackageCheck,
  Palette,
  Search,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { logoutAction } from "@/app/(auth)/actions";
import { ConsultationUnreadBadge } from "@/components/consultation-read";
import { OpsFrame } from "@/components/ops/frame";
import { Brand } from "@/components/shell/brand";
import { NavLink } from "@/components/shell/nav-link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/** 運営画面の共通部品（Tailwind ＋ shadcn/ui） */

export const NAV_ITEMS = [
  { href: "/ops", label: "今日の仕事", icon: LayoutDashboard, exact: true },
  { href: "/ops/discovery", label: "企業・案件", icon: Search },
  { href: "/ops/designs", label: "デザイン・提案書", icon: Palette },
  { href: "/ops/review", label: "提案レビュー", icon: ClipboardCheck },
  { href: "/ops/materials", label: "顧客の写真・ロゴ", icon: Images },
  { href: "/ops/content", label: "お知らせ・ブログ", icon: Newspaper },
  { href: "/ops/delivery", label: "制作・公開", icon: PackageCheck },
  { href: "/ops/consultations", label: "営業からの相談", icon: MessageCircle },
  { href: "/ops/assignments", label: "担当・引き継ぎ", icon: Users },
  { href: "/ops/contracts", label: "契約・報酬", icon: FileSignature },
  { href: "/ops/settings", label: "設定・操作履歴", icon: Settings },
  { href: "/ops/account-recovery", label: "ログイン復旧", icon: KeyRound },
  { href: "/account/security", label: "安全設定", icon: ShieldCheck },
] as const;

export function OpsShell({
  userName,
  children,
  unreadCount,
  recoveryCount = null,
  materialCount = null,
}: {
  userName: string;
  children: ReactNode;
  unreadCount: number | null;
  recoveryCount?: number | null;
  materialCount?: number | null;
}) {
  return (
    <OpsFrame
      userName={userName}
      sidebar={
        <>
          <div className="ops-brand">
            <Brand />
            <span>運営ワークスペース</span>
          </div>
          <nav aria-label="運営メニュー" className="ops-nav">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.href}
                href={item.href}
                exact={"exact" in item && item.exact}
                className="ops-nav-link"
                activeClassName="is-active"
              >
                <item.icon aria-hidden="true" />
                <span>{item.label}</span>
                {item.href.endsWith("/consultations") && <ConsultationUnreadBadge initialCount={unreadCount} />}
                {item.href === "/ops/materials" && materialCount !== null && materialCount > 0 && (
                  <span
                    className="ml-auto rounded-full bg-blue-100 px-2 text-xs text-blue-900"
                    title={`確認待ち ${materialCount}件`}
                  >
                    {materialCount}
                  </span>
                )}
                {item.href === "/ops/account-recovery" && recoveryCount !== null && recoveryCount > 0 && (
                  <span
                    className="ml-auto rounded-full bg-blue-100 px-2 text-xs text-blue-900"
                    title={`未完了 ${recoveryCount}件`}
                  >
                    {recoveryCount}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="ops-account">
            <span className="ops-avatar">{userName.slice(0, 1)}</span>
            <div>
              <strong>{userName}</strong>
              <small>運営担当</small>
            </div>
            <form action={logoutAction}>
              <Button type="submit" variant="ghost" size="icon" aria-label="ログアウト">
                <LogOut />
              </Button>
            </form>
          </div>
        </>
      }
    >
      {children}
    </OpsFrame>
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
