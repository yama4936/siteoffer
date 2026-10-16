import { notFound } from "next/navigation";
import { ReadyCandidates } from "@/components/ops/ready-candidates";
import { ReviewWorkspace } from "@/components/ops/review-workspace";
import { Flash, Forbidden, first } from "@/components/ops/ui";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
import { getCompanyDetail, listCompanies, listReviewQueue } from "@/lib/ops/queries";
import { getCurrentActor } from "@/lib/session";

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  const db = getDb();
  const queue = await listReviewQueue(db, actor);
  const companies = await listCompanies(db, actor);
  if (!queue.ok || !companies.ok) return <Forbidden />;
  const requested = first(sp, "company");
  if (requested && !isUuid(requested)) notFound();
  const selectedId =
    requested ??
    queue.value.inReview[0]?.companyId ??
    queue.value.readyCandidates[0]?.company.id ??
    companies.value[0]?.id;
  const detail = selectedId ? await getCompanyDetail(db, actor, selectedId) : null;
  if (detail && (!detail.ok || !detail.value)) notFound();
  const d = detail?.ok ? detail.value : null;
  const selectedVersion = first(sp, "version");
  if (selectedVersion && !d?.proposalVersions.some((v) => v.id === selectedVersion)) notFound();
  const version = selectedVersion
    ? d?.proposalVersions.find((v) => v.id === selectedVersion)
    : (d?.proposalVersions.find((v) => v.status === "in_review") ?? d?.proposalVersions[0]);
  const pending = new Set(queue.value.inReview.map((row) => row.companyId));
  const items = companies.value
    .map((c) => ({
      id: c.id,
      name: c.name,
      location: [c.prefecture, c.city].filter(Boolean).join(" "),
      industry: c.industry,
      status: c.pipelineStatus,
      pending: pending.has(c.id),
    }))
    .sort((a, b) => Number(b.pending) - Number(a.pending));
  return (
    <>
      <div className="review-flash">
        <Flash searchParams={sp} />
      </div>
      <ReviewWorkspace
        key={`${selectedId}-${version?.id ?? "none"}`}
        items={items}
        selected={
          d
            ? {
                id: d.company.id,
                pipelineStatus: d.company.pipelineStatus,
                name: d.company.name,
                location: [d.company.prefecture, d.company.city].filter(Boolean).join(" "),
                industry: d.company.industry,
                address: d.company.address,
                phone: d.company.representativePhone,
                officialStatus: d.company.officialSiteStatus,
                website: d.websites.find((w) => w.isPrimary)?.url ?? d.websites[0]?.url ?? null,
                assets: d.imageAssets.map(({ asset }) => ({
                  id: asset.id,
                  name: asset.label,
                  allowed: asset.allowSalesDemo,
                  confirmed: !!asset.confirmedAt,
                })),
                versions: d.proposalVersions.map((v) => ({
                  id: v.id,
                  version: v.version,
                  status: v.status,
                  note: v.reviewNote,
                  date: v.createdAt.toISOString(),
                })),
                version: version
                  ? {
                      id: version.id,
                      version: version.version,
                      status: version.status,
                      content: version.content,
                      hasDemo: !!version.demoArtifactDir,
                      note: version.reviewNote,
                    }
                  : null,
              }
            : null
        }
      />
      <details className="review-ready">
        <summary>販売条件を選んで営業可能にする · {queue.value.readyCandidates.length} 件</summary>
        <ReadyCandidates />
      </details>
    </>
  );
}
