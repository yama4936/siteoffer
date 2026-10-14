import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Brand } from "@/components/shell/brand";

// 顧客向けの画面（共有リンクで開く）。URLにトークンを含むため、
// 外部へのリファラーを送らず、検索エンジンに載せない。
export const metadata: Metadata = {
  title: "制作サイトのご確認",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function CustomerLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl items-center px-4 py-3">
          <Brand />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:py-10">{children}</main>
    </div>
  );
}
