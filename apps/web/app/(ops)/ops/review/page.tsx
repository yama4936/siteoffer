import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ReviewWorkspace } from "@/components/ops/review-workspace";
import { Flash, Forbidden, first } from "@/components/ops/ui";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
import { getCompanyDetail } from "@/lib/ops/queries";
import { readReviewDesign } from "@/lib/ops/review-design";
import { EMPTY_REVIEW_DRAFT } from "@/lib/ops/review-draft-types";
import { loadReviewDraft } from "@/lib/ops/review-drafts";
import { getReviewInbox } from "@/lib/ops/review-inbox";
import { getCurrentActor } from "@/lib/session";

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  const db = getDb();
  for (const key of ["company", "version", "reviewView", "reviewQuery"])
    if (sp[key] !== undefined && typeof sp[key] !== "string") notFound();
  const inbox = await getReviewInbox(db, actor, {
    view: first(sp, "reviewView"),
    query: first(sp, "reviewQuery"),
    page: Number(sp.reviewPage),
  });
  if (!inbox.ok) return inbox.error === "forbidden" ? <Forbidden /> : notFound();
  if (inbox.value.view === "ready")
    redirect(`/ops/review/ready?${new URLSearchParams({ q: inbox.value.query, page: String(inbox.value.page) })}`);
  const requested = first(sp, "company");
  if (requested && !isUuid(requested)) notFound();
  const selectedId = requested ?? inbox.value.items[0]?.id;
  const detail = selectedId ? await getCompanyDetail(db, actor, selectedId) : null;
  if (detail && (!detail.ok || !detail.value)) notFound();
  const d = detail?.ok ? detail.value : null;
  const selectedVersion = first(sp, "version");
  if (selectedVersion && !d?.proposalVersions.some((v) => v.id === selectedVersion)) notFound();
  const version = selectedVersion ? d?.proposalVersions.find((v) => v.id === selectedVersion) : d?.proposalVersions[0];
  const initialDraft = version ? await loadReviewDraft(db, actor, version.id) : EMPTY_REVIEW_DRAFT;
  const design = version ? await readReviewDesign(db, actor, version.id) : null;
  const context = new URLSearchParams({ reviewView: inbox.value.view, reviewPage: String(inbox.value.page) });
  if (inbox.value.query) context.set("reviewQuery", inbox.value.query);
  function listHref(view: string, page: number) {
    const q = new URLSearchParams(context);
    q.set("reviewView", view);
    q.set("reviewPage", String(page));
    return `/ops/review?${q}`;
  }
  return (
    <>
      <div className="review-flash">
        <Flash searchParams={sp} />
      </div>
      <ReviewWorkspace
        key={`${selectedId}-${version?.id ?? "none"}`}
        initialDraft={initialDraft}
        items={inbox.value.items}
        queue={{
          view: inbox.value.view,
          query: inbox.value.query,
          page: inbox.value.page,
          pages: inbox.value.pages,
          total: inbox.value.total,
          counts: inbox.value.counts,
          context: context.toString(),
          pendingHref: listHref("pending", 1),
          allHref: listHref("all", 1),
          previousHref: listHref(inbox.value.view, inbox.value.page - 1),
          nextHref: listHref(inbox.value.view, inbox.value.page + 1),
        }}
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
                      isLatest: version.id === d.proposalVersions[0]?.id,
                      id: version.id,
                      version: version.version,
                      status: version.status,
                      content: version.content,
                      hasDemo: !!version.demoArtifactDir,
                      note: version.reviewNote,
                      design,
                    }
                  : null,
              }
            : null
        }
      />
      <div className="review-ready">
        <Link href={`/ops/review/ready?${new URLSearchParams({ q: inbox.value.query })}`}>
          営業への引き継ぎ · {inbox.value.counts.ready}社 →
        </Link>
      </div>
    </>
  );
}
