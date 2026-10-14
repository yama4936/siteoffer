import type { Metadata } from "next";
import type { ReactNode } from "react";
import { customerCss } from "@/components/customer/styles";

// 顧客向けの画面（共有リンクで開く）。URLにトークンを含むため、
// 外部へのリファラーを送らず、検索エンジンに載せない。
export const metadata: Metadata = {
  title: "制作サイトのご確認",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function CustomerLayout({ children }: { children: ReactNode }) {
  return (
    <div className="customer">
      <style>{customerCss}</style>
      {children}
    </div>
  );
}
