import {
  Bot,
  ClipboardCheck,
  DatabaseBackup,
  FileSignature,
  History,
  LayoutDashboard,
  MessageCircle,
  Newspaper,
  PackageCheck,
  Settings,
  UserCog,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { ConsultationUnreadBadge } from "@/components/consultation-read";
import { OpsFrame } from "@/components/ops/frame";
import { AccountMenu } from "@/components/shell/account-menu";
import { Brand } from "@/components/shell/brand";
import { NavLink } from "@/components/shell/nav-link";
import { Alert, AlertDescription } from "@/components/ui/alert";

/** 運営画面の共通部品（Tailwind ＋ shadcn/ui） */

export const NAV_ITEMS = [
  { href: "/ops", label: "今日の仕事", icon: LayoutDashboard, exact: true },
  { href: "/ops/skills", label: "スキルの実行", icon: Bot },
  { href: "/ops/review", label: "最終確認", icon: ClipboardCheck },
  { href: "/ops/accounts", label: "アカウント管理", icon: UserCog },
  { href: "/ops/content", label: "お知らせ・ブログ", icon: Newspaper },
  { href: "/ops/delivery", label: "制作・公開", icon: PackageCheck },
  { href: "/ops/consultations", label: "営業からの相談", icon: MessageCircle },
  { href: "/ops/assignments", label: "担当・引き継ぎ", icon: Users },
  { href: "/ops/contracts", label: "契約・報酬", icon: FileSignature },
  { href: "/ops/settings", label: "設定・操作履歴", icon: Settings },
  { href: "/ops/history", label: "操作履歴を探す", icon: History },
  { href: "/ops/backups", label: "バックアップ", icon: DatabaseBackup },
] as const;

/** 運営の仕事は skills の実行・最終確認・アカウント管理に絞り、確認作業はAIが行う（2026-10-28 のユーザー決定） */
const NAV_GROUPS = [
  { label: "運営の仕事", hrefs: ["/ops/skills", "/ops/review", "/ops/accounts"] },
  { label: "営業・契約", hrefs: ["/ops/consultations", "/ops/assignments", "/ops/contracts"] },
  { label: "制作・公開", hrefs: ["/ops/delivery", "/ops/content"] },
  { label: "管理", hrefs: ["/ops/settings", "/ops/history", "/ops/backups"] },
];

export function OpsShell({
  userName,
  children,
  unreadCount,
  recoveryCount = null,
}: {
  userName: string;
  children: ReactNode;
  unreadCount: number | null;
  recoveryCount?: number | null;
}) {
  function renderLink(item: (typeof NAV_ITEMS)[number]) {
    return (
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
        {item.href === "/ops/accounts" && recoveryCount !== null && recoveryCount > 0 && (
          <span
            className="ml-auto rounded-full bg-blue-100 px-2 text-xs text-blue-900"
            title={`未完了 ${recoveryCount}件`}
          >
            {recoveryCount}
          </span>
        )}
      </NavLink>
    );
  }
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
            {renderLink(NAV_ITEMS[0])}
            {NAV_GROUPS.map((group) => (
              <section key={group.label} className="ops-nav-group" aria-label={group.label}>
                <h2 className="ops-nav-heading">{group.label}</h2>
                {NAV_ITEMS.filter((item) => group.hrefs.includes(item.href)).map(renderLink)}
              </section>
            ))}
          </nav>
          <AccountMenu userName={userName} roleLabel="運営担当" />
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
