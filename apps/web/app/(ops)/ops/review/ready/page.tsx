import { notFound, redirect } from "next/navigation";
import { ReadyCandidates } from "@/components/ops/ready-candidates";
import { Forbidden } from "@/components/ops/ui";
import { getDb } from "@/lib/db";
import { getSalesReadiness } from "@/lib/ops/sales-readiness";
import { getCurrentActor } from "@/lib/session";

export default async function ReadyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  for (const key of ["q", "page", "company"]) if (sp[key] !== undefined && typeof sp[key] !== "string") notFound();
  const result = await getSalesReadiness(getDb(), await getCurrentActor(), {
    query: sp.q as string | undefined,
    page: Number(sp.page),
    companyId: sp.company as string | undefined,
  });
  if (!result.ok) return result.error === "forbidden" ? <Forbidden /> : notFound();
  if (sp.company && !result.value.selected) notFound();
  if (!sp.company && result.value.selected)
    redirect(
      `/ops/review/ready?${new URLSearchParams({ q: result.value.query, page: String(result.value.page), company: result.value.selected.id })}`,
    );
  return <ReadyCandidates key={result.value.selected?.id ?? "none"} data={result.value} />;
}
