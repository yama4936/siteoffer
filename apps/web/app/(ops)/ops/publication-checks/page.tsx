import { ContentError, listPublicationMaterials } from "@siteoffer/core";
import { notFound } from "next/navigation";
import { PublicationMaterials } from "@/components/ops/publication-materials";
import { Forbidden } from "@/components/ops/ui";
import { PageHeader } from "@/components/ui/page";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
import { requireUser } from "@/lib/session";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("ops"),
    sp = await searchParams;
  const companyId = typeof sp.company === "string" ? sp.company : undefined,
    deliveryId = typeof sp.delivery === "string" ? sp.delivery : undefined,
    deploymentId = typeof sp.focus === "string" ? sp.focus : undefined;
  if (
    (companyId && !isUuid(companyId)) ||
    (deliveryId && !isUuid(deliveryId)) ||
    (deploymentId && !isUuid(deploymentId))
  )
    notFound();
  const raw = Number(sp.page ?? 0),
    page = Number.isSafeInteger(raw) && raw >= 0 ? Math.min(raw, 100000) : 0;
  const mode = sp.mode === "all" ? "all" : sp.mode === "resolved" ? "resolved" : "pending";
  const filter = { companyId, deliveryId, deploymentId, page, mode } as const;
  try {
    const initial = await listPublicationMaterials(getDb(), user.actor, filter);
    return (
      <>
        <PageHeader
          title="公開後の素材確認"
          description="利用許可が変わった素材の公開先をまとめて確認し、修正・対応記録へ進めます。"
        />
        <div className="mb-5 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-7">
          公開記録と現在の素材の利用許可を照合しています。外部サイトの置き換え・停止は自動実行しません。実際の反映を確認した担当者が、確認したURLとメモを残してください。
        </div>
        <PublicationMaterials key={JSON.stringify(filter)} initial={initial} filter={filter} />
      </>
    );
  } catch (e) {
    if (e instanceof ContentError) return <Forbidden />;
    throw e;
  }
}
