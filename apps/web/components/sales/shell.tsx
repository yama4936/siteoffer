import { BriefcaseBusiness, Building2, CircleHelp, LogOut, MessageCircle, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { logoutAction } from "@/app/(auth)/actions";
import { OpsFrame } from "@/components/ops/frame";
import { Brand } from "@/components/shell/brand";
import { NavLink } from "@/components/shell/nav-link";
import { Button } from "@/components/ui/button";

const NAV = [
  { href: "/sales/companies", label: "企業・案件", icon: Building2 },
  { href: "/sales/assignments", label: "担当案件", icon: BriefcaseBusiness },
  { href: "/sales/consultations", label: "運営への相談", icon: MessageCircle },
  { href: "/sales/earnings", label: "実績・報酬", icon: Wallet },
];

export function SalesShell({ userName, children }: { userName: string; children: ReactNode }) {
  return (
    <OpsFrame
      workspaceRole="sales"
      userName={userName}
      sidebar={
        <>
          <div className="ops-brand">
            <Brand />
            <span>営業ワークスペース</span>
          </div>
          <nav aria-label="営業メニュー" className="ops-nav">
            {NAV.map((item) => (
              <NavLink key={item.href} href={item.href} className="ops-nav-link" activeClassName="is-active">
                <item.icon aria-hidden="true" />
                <span>{item.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="sales-sidebar-note">
            <CircleHelp size={18} />
            <p>
              提案から、次の商談へ。
              <br />
              <small>案件を選んで内容を確認しましょう。</small>
            </p>
          </div>
          <div className="ops-account">
            <span className="ops-avatar">{userName.slice(0, 1)}</span>
            <div>
              <strong>{userName}</strong>
              <small>営業パートナー</small>
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
