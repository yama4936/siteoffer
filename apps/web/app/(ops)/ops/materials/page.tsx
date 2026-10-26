import { ContentError, listImageSubmissionsForOps } from "@siteoffer/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OperatorMaterials } from "@/components/materials/operator-materials";
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
    sp = await searchParams,
    companyId = typeof sp.company === "string" ? sp.company : undefined,
    assetId = typeof sp.focus === "string" ? sp.focus : undefined,
    pendingOnly = sp.all !== "1",
    raw = Number(sp.page ?? 0),
    page = Number.isSafeInteger(raw) && raw >= 0 ? Math.min(raw, 100000) : 0;
  if ((companyId && !isUuid(companyId)) || (assetId && !isUuid(assetId))) notFound();
  try {
    const initial = await listImageSubmissionsForOps(getDb(), user.actor, { companyId, assetId, page, pendingOnly });
    const prefix = `/ops/materials?${companyId ? `company=${companyId}&` : ""}`;
    return (
      <>
        <PageHeader title="顧客からの写真・ロゴ" description="画像と利用許可を確認し、必要な説明を顧客へ返します。" />
        <div className="mb-5 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-7">
          提出された画像は、確認するまで営業デモ・本番サイトには使いません。顧客が許可した用途の範囲で確認し、配置先は画像素材台帳で指定します。
        </div>
        <nav className="mb-5 flex flex-wrap gap-3 text-sm" aria-label="素材の確認状況">
          <Link
            href={`${prefix}all=0`}
            className={
              pendingOnly ? "rounded-lg bg-blue-600 px-4 py-2 text-white" : "rounded-lg border bg-white px-4 py-2"
            }
          >
            確認待ち
          </Link>
          <Link
            href={`${prefix}all=1`}
            className={
              !pendingOnly ? "rounded-lg bg-blue-600 px-4 py-2 text-white" : "rounded-lg border bg-white px-4 py-2"
            }
          >
            すべて
          </Link>
          {companyId && (
            <Link className="px-4 py-2 underline" href="/ops/materials">
              すべての会社
            </Link>
          )}
        </nav>
        <p className="mb-5 text-sm">
          <Link
            className="text-blue-700 underline"
            href={`/ops/publication-checks${companyId ? `?company=${companyId}` : ""}`}
          >
            利用許可の変更が公開済みサイトに影響していないか確認
          </Link>
        </p>
        {assetId && (
          <p className="mb-4 text-sm">
            選択した素材を表示しています。
            <Link href={`/ops/materials${companyId ? `?company=${companyId}` : ""}`} className="ml-2 underline">
              会社の素材一覧に戻る
            </Link>
          </p>
        )}
        <OperatorMaterials
          key={`${companyId}:${assetId}:${page}:${pendingOnly}`}
          initial={initial}
          companyId={companyId}
          assetId={assetId}
          page={page}
          pendingOnly={pendingOnly}
        />
      </>
    );
  } catch (e) {
    if (e instanceof ContentError) return <Forbidden />;
    throw e;
  }
}
