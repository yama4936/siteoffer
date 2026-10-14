import type { ReactNode } from "react";

export const metadata = { title: "SiteOffer" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
