"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export type OpsRailItem = {
  label: string;
  /** 押したときに移動する先（グループの先頭ページ） */
  href: string;
  /** このグループに属するページ。exact のときは完全一致だけを選択中とする */
  hrefs: readonly string[];
  exact?: boolean;
  icon: ReactNode;
};

function matches(pathname: string, href: string, exact: boolean) {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

/** 運営サイドバーの左に置く、グループ単位のアイコン列（Discordのサーバー一覧風） */
export function OpsRail({ items }: { items: readonly OpsRailItem[] }) {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="運営メニューのグループ" className="ops-rail">
      {items.map((item) => {
        const active = item.hrefs.some((href) => matches(pathname, href, item.exact ?? false));
        return (
          <Link
            key={item.label}
            href={item.href}
            aria-label={item.label}
            title={item.label}
            aria-current={active ? "true" : undefined}
            className={active ? "ops-rail-button is-active" : "ops-rail-button"}
          >
            {item.icon}
          </Link>
        );
      })}
    </nav>
  );
}
