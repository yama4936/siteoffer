import type { ReactNode } from "react";
import { Brand } from "@/components/shell/brand";

/** ログイン・登録・ログアウトの共通枠（中央にカードを置く） */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col items-center bg-[radial-gradient(ellipse_at_top,var(--color-accent),transparent_60%)] px-4 py-10 sm:py-16">
      <Brand className="mb-8 text-lg" />
      <main className="w-full max-w-md">{children}</main>
    </div>
  );
}
