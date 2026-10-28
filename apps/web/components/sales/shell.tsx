import { BriefcaseBusiness, Building2, CircleHelp, MessageCircle, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { ConsultationUnreadBadge } from "@/components/consultation-read";
import { OpsFrame } from "@/components/ops/frame";
import { AccountMenu } from "@/components/shell/account-menu";
import { Brand } from "@/components/shell/brand";
import { NavLink } from "@/components/shell/nav-link";

const NAV = [
  { href: "/sales/companies", label: "企業・案件", icon: Building2 },
  { href: "/sales/assignments", label: "担当案件", icon: BriefcaseBusiness },
  { href: "/sales/consultations", label: "運営への相談", icon: MessageCircle },
  { href: "/sales/earnings", label: "実績・報酬", icon: Wallet },
];

export function SalesShell({
  userName,
  children,
  unreadCount,
}: {
  userName: string;
  children: ReactNode;
  unreadCount: number | null;
}) {
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
                {item.href.endsWith("/consultations") && <ConsultationUnreadBadge initialCount={unreadCount} />}
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
          <AccountMenu userName={userName} roleLabel="営業パートナー" />
        </>
      }
    >
      {children}
    </OpsFrame>
  );
}
