import { countUnreadConsultations } from "@siteoffer/core";
import type { ReactNode } from "react";
import { SalesShell } from "@/components/sales/shell";
import { getDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
import "@/components/ops/workspace.css";
import "@/components/sales/workspace.css";
export default async function SalesLayout({ children }: { children: ReactNode }) {
  const user = await requireUser("sales");
  const unread = await countUnreadConsultations(getDb(), user.actor).catch(() => null);
  return (
    <SalesShell userName={user.displayName} unreadCount={unread?.ok ? unread.value : null}>
      {children}
    </SalesShell>
  );
}
