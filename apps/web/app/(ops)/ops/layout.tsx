import { countUnreadConsultations } from "@siteoffer/core";
import type { ReactNode } from "react";
import { OpsShell } from "@/components/ops/ui";
import { getDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
import "@/components/ops/workspace.css";

export const metadata = { title: "SiteOffer 運営" };

/**
 * 運営画面の共通枠。未ログインは /login、運営以外は / へ移動する（AC-17）。
 * layout の判定だけに頼らず、各ページの読み取り（lib/ops/queries.ts）と Server Function でも運営かを確かめる。
 */
export default async function OpsLayout({ children }: { children: ReactNode }) {
  const user = await requireUser("ops");
  const unread = await countUnreadConsultations(getDb(), user.actor).catch(() => null);
  return (
    <OpsShell userName={user.displayName} unreadCount={unread?.ok ? unread.value : null}>
      {children}
    </OpsShell>
  );
}
