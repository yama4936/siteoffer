import { getDeliveryDetail } from "@siteoffer/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CustomerReviewForm } from "@/components/ops/customer-review-form";
import { CustomerReviewLinks } from "@/components/ops/customer-review-links";
import { DeliveryPreviewPair } from "@/components/ops/delivery-preview";
import { DeliveryVersionPicker } from "@/components/ops/delivery-version-picker";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
import { DELIVERY_STATUS_LABEL, fmtDate, label } from "@/lib/ops/format";
import { requireUser } from "@/lib/session";
import { sendToCustomerReviewAction } from "../../../actions";

export default async function DeliveryReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ deliveryId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("ops");
  const { deliveryId } = await params,
    sp = await searchParams;
  if (!isUuid(deliveryId)) notFound();
  const result = await getDeliveryDetail(getDb(), user.actor, deliveryId);
  if (!result.ok) notFound();
  const d = result.value;
  for (const key of ["version", "compare"])
    if (sp[key] !== undefined && (typeof sp[key] !== "string" || (sp[key] !== "none" && !isUuid(sp[key])))) notFound();
  const selected = sp.version
    ? d.versions.find((v) => v.id === sp.version)
    : (d.versions.find((v) => v.id === d.delivery.reviewVersionId) ?? d.versions[0]);
  if (!selected) notFound();
  const comparison =
    sp.compare === "none"
      ? undefined
      : sp.compare
        ? d.versions.find((v) => v.id === sp.compare)
        : d.versions.find((v) => v.version < selected.version && v.artifactDir);
  if (sp.compare && sp.compare !== "none" && !comparison) notFound();
  const latestRequest = d.approvals
    .filter((a) => a.decision === "changes_requested")
    .sort(
      (a, b) =>
        (d.versions.find((v) => v.id === b.deliveryVersionId)?.version ?? 0) -
        (d.versions.find((v) => v.id === a.deliveryVersionId)?.version ?? 0),
    )[0];
  const rejectedVersion = d.versions.find((v) => v.id === latestRequest?.deliveryVersionId)?.version ?? 0;
  const eligible =
    selected.artifactDir &&
    selected.version > rejectedVersion &&
    (!d.delivery.currentBuildId || selected.buildId === d.delivery.currentBuildId) &&
    (d.delivery.status === "ops_review" ||
      (d.delivery.status === "customer_review" && d.delivery.reviewVersionId === selected.id));
  const viewVersion = (v: typeof selected) => ({ id: v.id, version: v.version, available: !!v.artifactDir });
  return (
    <div className="space-y-6 min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          className="mb-0"
          title={`${d.companyName} · 制作版の確認`}
          description="修正前後を見比べ、確認した版を顧客へ渡します。"
        />
        <Link href={`/ops/delivery?focus=${deliveryId}`} className={buttonVariants({ variant: "outline" })}>
          制作・公開へ戻る
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge variant="info">{label(DELIVERY_STATUS_LABEL, d.delivery.status)}</Badge>
        <span>確認中：第{selected.version}版</span>
        <span className="text-muted-foreground">作成：{fmtDate(selected.createdAt)}</span>
        {selected.id === d.delivery.lockedVersionId && <Badge variant="success">顧客承認済み・公開対象</Badge>}
        {selected.version <= rejectedVersion && <Badge variant="warning">修正前・再提出不可</Badge>}
      </div>
      <DeliveryVersionPicker
        deliveryId={deliveryId}
        selectedId={selected.id}
        comparisonId={comparison?.id ?? "none"}
        versions={d.versions.map((v) => ({ id: v.id, version: v.version }))}
      />
      <div className="grid min-w-0 gap-6 2xl:grid-cols-[minmax(0,1fr)_320px]">
        <DeliveryPreviewPair
          deliveryId={deliveryId}
          selected={viewVersion(selected)}
          comparison={comparison && comparison.id !== selected.id ? viewVersion(comparison) : undefined}
        />
        <aside aria-label="この版の確認と次の操作" className="min-w-0 space-y-5 rounded-xl border bg-card p-5">
          <h2 className="font-semibold">顧客へ渡す前に</h2>
          <p className="text-sm text-muted-foreground">
            会社情報・連絡先、使用画像、PC・スマホでの表示、修正依頼の反映を確認してください。
          </p>
          {latestRequest && (
            <section
              className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3"
              aria-label="顧客からの修正依頼"
            >
              <h3 className="text-sm font-semibold">第{rejectedVersion}版への修正依頼</h3>
              <p className="text-xs text-muted-foreground">{fmtDate(latestRequest.decidedAt)}</p>
              <p className="whitespace-pre-wrap break-words text-sm">{latestRequest.comment}</p>
            </section>
          )}
          {eligible ? (
            <CustomerReviewForm
              key={selected.id}
              action={sendToCustomerReviewAction}
              deliveryId={deliveryId}
              versions={[{ id: selected.id, label: `第${selected.version}版（表示中）` }]}
              reissue={d.delivery.status === "customer_review"}
            />
          ) : (
            <p className="text-sm">
              {d.delivery.lockedVersionId
                ? "顧客が承認した版は固定されています。公開・納品の作業は制作・公開画面から進めてください。"
                : selected.version <= rejectedVersion
                  ? "この版への修正依頼があります。新しい制作版を選んで確認してください。"
                  : d.delivery.status === "building"
                    ? "制作・公開画面から運営確認へ進めると、この版を顧客確認に回せます。"
                    : "この版は表示の確認だけができます。現在の顧客確認対象と制作の進行状態をご確認ください。"}
            </p>
          )}
          <CustomerReviewLinks deliveryId={deliveryId} revision={d.delivery.updatedAt.toISOString()} />
        </aside>
      </div>
    </div>
  );
}
