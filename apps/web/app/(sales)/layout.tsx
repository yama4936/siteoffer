import Link from "next/link";
import type { ReactNode } from "react";
import { SALES_CSS } from "@/components/sales/styles";
import { requireUser } from "@/lib/session";

/** 営業ユーザーの画面（16章）。未ログインは /login、営業以外は / へ移動する */
export default async function SalesLayout({ children }: { children: ReactNode }) {
  const user = await requireUser("sales");
  return (
    <div className="sales">
      <style>{SALES_CSS}</style>
      <header className="top">
        <strong>SiteOffer 営業</strong>
        <nav aria-label="営業メニュー">
          <Link href="/sales/companies">企業一覧</Link>
          <Link href="/sales/assignments">担当案件</Link>
          <Link href="/sales/earnings">実績・報酬</Link>
        </nav>
        <span className="sub">
          {user.displayName} さん <Link href="/logout">ログアウト</Link>
        </span>
      </header>
      {children}
    </div>
  );
}
