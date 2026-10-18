import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "SiteOffer" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-dvh">
        {process.env.DEMO_RESTORE_DIR && (
          <div
            role="status"
            className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-950"
          >
            復元した確認用データで動作しています。通常のデモとは別の環境です。
          </div>
        )}
        {children}
      </body>
    </html>
  );
}
