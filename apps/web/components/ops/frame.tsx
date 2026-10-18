"use client";

import { ChevronRight, Search } from "lucide-react";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef } from "react";
import { WorkspaceAttention } from "@/components/shell/attention";

const titles: Record<string, string> = {
  discovery: "企業・案件",
  companies: "企業・案件",
  review: "提案レビュー",
  designs: "デザイン・提案書",
  content: "お知らせ・ブログ",
  materials: "顧客の写真・ロゴ",
  assignments: "担当・引き継ぎ",
  consultations: "営業からの相談",
  contracts: "契約・報酬",
  delivery: "制作・公開",
  "publication-checks": "公開後の素材確認",
  processing: "処理の状況",
  settings: "設定・操作履歴",
  backups: "バックアップ・復元確認",
  "account-recovery": "ログインの復旧",
};

export function OpsFrame({
  userName,
  sidebar,
  children,
  workspaceRole = "ops",
}: {
  userName: string;
  sidebar: ReactNode;
  children: ReactNode;
  workspaceRole?: "ops" | "sales";
}) {
  const pathname = usePathname();
  const sidebarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!pathname) return;
    function revealActive() {
      const nav = sidebarRef.current?.querySelector<HTMLElement>(".ops-nav:has(.ops-nav-group)");
      const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!nav || !active) return;
      // Scroll only the menu container, preserving a deep link's position in the page.
      const box = nav.getBoundingClientRect(),
        target = active.getBoundingClientRect();
      if (getComputedStyle(nav).flexDirection === "row") {
        if (target.left < box.left) nav.scrollLeft += target.left - box.left;
        else if (target.right > box.right) nav.scrollLeft += target.right - box.right;
      } else {
        if (target.top < box.top) nav.scrollTop += target.top - box.top;
        else if (target.bottom > box.bottom) nav.scrollTop += target.bottom - box.bottom;
      }
    }
    revealActive();
    window.addEventListener("resize", revealActive);
    return () => window.removeEventListener("resize", revealActive);
  }, [pathname]);
  const sales = workspaceRole === "sales";
  const review = pathname === "/ops/review" || (sales && /^\/sales\/companies\/[^/]+$/.test(pathname));
  const salesTitles: Record<string, string> = {
    companies: review ? "提案・サイト比較" : "企業・案件",
    assignments: "担当案件",
    consultations: "運営への相談",
    earnings: "実績・報酬",
  };
  const title = (sales ? salesTitles : titles)[pathname.split("/")[2] ?? ""] ?? "今日の仕事";
  return (
    <div className={`ops-app ${sales ? "sales-app" : ""}`}>
      <a href="#ops-main" className="ops-skip">
        本文へ移動
      </a>
      <aside ref={sidebarRef} className="ops-sidebar">
        {sidebar}
      </aside>
      <div className="ops-body">
        <header className="ops-topbar">
          <div className="ops-breadcrumb">
            <span>{sales ? "営業ワークスペース" : "ワークスペース"}</span>
            <ChevronRight size={14} />
            <strong>{title}</strong>
          </div>
          <form action={sales ? "/sales/companies" : "/ops/discovery"} className="ops-search">
            <Search size={17} />
            <input name="q" aria-label="企業・案件を検索" placeholder="企業名・案件を検索" />
            <button type="submit">検索</button>
          </form>
          <WorkspaceAttention role={workspaceRole} />
          <div className="ops-top-user">
            <span className="ops-avatar">{userName.slice(0, 1)}</span>
            <span>{userName}</span>
          </div>
        </header>
        <main id="ops-main" className={review ? "ops-main ops-main-review" : "ops-main"}>
          {children}
        </main>
      </div>
    </div>
  );
}
