import type { ReactNode } from "react";
import { SalesShell } from "@/components/sales/shell";
import { requireUser } from "@/lib/session";
import "@/components/ops/workspace.css";
import "@/components/sales/workspace.css";
export default async function SalesLayout({ children }: { children: ReactNode }) {
  const user = await requireUser("sales");
  return <SalesShell userName={user.displayName}>{children}</SalesShell>;
}
