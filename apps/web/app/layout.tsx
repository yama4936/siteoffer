import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "SiteOffer" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
