import { randomUUID } from "node:crypto";
import { DEFAULT_DESIGN_BRIEF, DESIGN_LABELS, type DesignBrief, systemClock } from "@siteoffer/core";
import {
  designBriefDrafts,
  designVersions,
  proposals,
  proposalVersions,
  siteAudits,
  workerRuntimes,
} from "@siteoffer/db";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { ArrowRight, Palette } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DesignBriefForm } from "@/components/ops/design-brief-form";
import { DesignRefresh, DesignSubmit } from "@/components/ops/design-controls";
import { DesignCompanyPicker, DesignHistory } from "@/components/ops/design-index";
import { DesignJourney } from "@/components/ops/design-journey";
import { DesignWorkerStatus } from "@/components/ops/design-worker-status";
import { Flash, first } from "@/components/ops/ui";
import { getDb } from "@/lib/db";
import { loadDesignDraft } from "@/lib/ops/design-drafts";
import { readDesignIndex } from "@/lib/ops/design-index";
import { designIndexHref, parseDesignIndexQuery } from "@/lib/ops/design-index-query";
import { isUuid } from "@/lib/ops/form";
import { assessWorkers } from "@/lib/ops/processing";
import { requireUser } from "@/lib/session";
import { buildDesignAction, retryDesignBuildAction, reviewDesignAction, uploadDesignAction } from "./actions";
import "./studio.css";

export default async function DesignPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("ops");
  const db = getDb();
  const sp = await searchParams;
  const input = parseDesignIndexQuery(sp);
  if (!input) notFound();
  const indexed = await readDesignIndex(db, user.actor, input);
  if (!indexed.ok) notFound();
  const data = indexed.value;
  const { company } = data;
  if (!company)
    return (
      <div className="design-studio">
        <h1>デザインする案件を探す</h1>
        <DesignCompanyPicker data={data} query={data.query} />
        <p>企業を収集するか、検索条件を変えて案件を探してください。</p>
      </div>
    );
  const companyId = company.id;
  const selected = data.selected ?? undefined;
  const selectedId = selected?.id ?? "new";
  const auditParam = input.auditId;
  const [auditRecord] =
    auditParam === "none"
      ? []
      : await db
          .select({ id: siteAudits.id, status: siteAudits.status, decision: siteAudits.decision })
          .from(siteAudits)
          .where(
            and(
              eq(siteAudits.companyId, companyId),
              auditParam
                ? eq(siteAudits.id, auditParam)
                : and(eq(siteAudits.status, "evaluated"), eq(siteAudits.decision, "create")),
            ),
          )
          .orderBy(desc(siteAudits.createdAt))
          .limit(1);
  if (auditParam && auditParam !== "none" && !auditRecord) notFound();
  // Pin both source version and diagnosis. Background work must not replace an open working copy.
  const query = { ...data.query, designId: selectedId, auditId: auditRecord?.id ?? "none" };
  if (!input.designId || !auditParam) {
    const url = new URL(designIndexHref(query), "http://local.invalid");
    for (const key of ["error", "msg"]) {
      const message = first(sp, key);
      if (message) url.searchParams.set(key, message);
    }
    redirect(`${url.pathname}${url.search}`);
  }
  const audit = auditRecord?.status === "evaluated" && auditRecord.decision === "create" ? auditRecord : undefined;
  const [proposal] = selected
    ? await db
        .select({ id: proposalVersions.id, status: proposalVersions.status, version: proposalVersions.version })
        .from(proposalVersions)
        .innerJoin(proposals, eq(proposals.id, proposalVersions.proposalId))
        .where(
          and(
            eq(proposals.companyId, companyId),
            sql`${proposalVersions.content}->>'designVersionId' = ${selected.id}`,
          ),
        )
        .orderBy(desc(proposalVersions.version))
        .limit(1)
    : [];
  const brief = (selected?.brief ?? DEFAULT_DESIGN_BRIEF) as DesignBrief;
  const draftScope = { companyId, designId: selected?.id ?? null, auditId: auditRecord?.id ?? null };
  const draft = await loadDesignDraft(db, user.actor, draftScope);
  const recentDrafts =
    user.actor.kind === "ops"
      ? await db
          .select({ context: designBriefDrafts.context, updatedAt: designBriefDrafts.updatedAt })
          .from(designBriefDrafts)
          .where(
            and(
              eq(designBriefDrafts.userId, user.actor.userId),
              eq(designBriefDrafts.companyId, companyId),
              isNotNull(designBriefDrafts.values),
            ),
          )
          .orderBy(desc(designBriefDrafts.updatedAt))
          .limit(20)
      : [];
  const draftSourceIds = recentDrafts
    .map((item) => item.context.split(":")[0])
    .filter((id): id is string => !!id && isUuid(id));
  const draftSources = draftSourceIds.length
    ? await db
        .select({ id: designVersions.id, version: designVersions.version })
        .from(designVersions)
        .where(and(eq(designVersions.companyId, companyId), inArray(designVersions.id, draftSourceIds)))
    : [];
  const draftTime = new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tokyo",
  });
  const configured = !!(process.env.SITEOFFER_IMAGE_MODEL?.trim() && process.env.OPENAI_API_KEY?.trim());
  const availability = assessWorkers(await db.select().from(workerRuntimes), systemClock.now());
  const busy =
    selected?.status === "queued" ||
    selected?.status === "generating" ||
    (!!selected?.buildRequestedAt && (!proposal || proposal.status === "generating"));
  const hidden = (
    <>
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="designId" value={selected?.id ?? ""} />
    </>
  );
  return (
    <div className="design-studio">
      <Flash searchParams={sp} />
      <header className="design-heading">
        <div>
          <span className="design-eyebrow">DESIGN STUDIO</span>
          <h1>デザインから、提案をつくる。</h1>
          <p>画像で方向性を揃え、同じ版から制作と提案書へ。</p>
        </div>
        <DesignCompanyPicker data={data} query={query} />
      </header>
      <DesignJourney
        companyId={companyId}
        canCreate={!!audit}
        configured={configured}
        design={selected}
        proposal={proposal}
        imageAvailability={availability.image}
      />
      <DesignWorkerStatus image={availability.image} companyId={companyId} design={selected} />
      <div className={`design-grid ${selected?.imageSha256 ? "" : "no-design-image"}`}>
        <section id="design-brief" tabIndex={-1} className="design-card design-brief">
          <h2>
            <Palette size={19} />
            制作条件
          </h2>
          <h3>{company.name}</h3>
          {recentDrafts.length > 0 && (
            <details className="design-personal-drafts">
              <summary>この案件の自分の下書き（最近20件まで）</summary>
              <ul>
                {recentDrafts.map((item) => {
                  const [sourceDesign, sourceAudit] = item.context.split(":");
                  const source = draftSources.find((v) => v.id === sourceDesign);
                  return (
                    <li key={item.context}>
                      <Link href={designIndexHref({ ...query, designId: sourceDesign!, auditId: sourceAudit! })}>
                        {source ? `第${source.version}版をもとにした条件` : "新しい条件"} ·{" "}
                        {draftTime.format(item.updatedAt)}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
          <DesignBriefForm
            key={`${user.actor.kind === "ops" ? user.actor.userId : ""}:${companyId}:${selected?.id ?? "new"}:${auditRecord?.id ?? "none"}`}
            scope={draftScope}
            initial={draft}
            defaults={brief}
            configured={configured}
            canCreate={!!audit}
            requestKey={randomUUID()}
            reviewNote={selected?.reviewNote}
          />
        </section>
        <section className="design-card design-canvas">
          <div className="design-section-heading">
            <h2>デザインプレビュー</h2>
            {selected && (
              <span className={`design-status ${selected.status}`}>
                第{selected.version}版 · {DESIGN_LABELS[selected.status]}
              </span>
            )}
          </div>
          <DesignHistory data={data} query={query} />
          {selected?.imageSha256 ? (
            <a className="design-image" href={`/ops/designs/${selected.id}/image`} target="_blank" rel="noreferrer">
              <Image
                unoptimized
                width={selected.width ?? 1536}
                height={selected.height ?? 1024}
                src={`/ops/designs/${selected.id}/image`}
                alt={`${company.name} デザイン第${selected.version}版 PC・スマートフォン`}
              />
            </a>
          ) : (
            <div className="design-empty">
              <Palette size={44} />
              <h3>{selected?.status === "generating" ? "デザインを生成しています" : "最初に、完成イメージを共有。"}</h3>
              <p>
                制作条件を入力し、画像を生成するか
                <br />
                imagegenで作成した画像を取り込んでください。
              </p>
            </div>
          )}
          <DesignRefresh active={busy} />
          {selected?.error && (
            <p className="design-error" role="alert">
              {selected.error}
            </p>
          )}
          {selected?.status === "draft" && (
            <form id="design-upload" tabIndex={-1} action={uploadDesignAction} className="design-upload">
              {hidden}
              <label>
                デザイン画像（PNG・JPEG・WebP、12MB以下）
                <input name="image" type="file" accept="image/png,image/jpeg,image/webp" required />
              </label>
              <DesignSubmit>画像を保存して確認へ</DesignSubmit>
            </form>
          )}
          {selected?.imageSha256 && (
            <div className="design-canvas-footer">
              <span>
                画像 {selected.width} × {selected.height} ·{" "}
                {selected.source === "openai" ? `API生成 / ${selected.model}` : "取り込み画像"}
              </span>
            </div>
          )}
          {selected?.status === "in_review" && (
            <form id="design-review" tabIndex={-1} action={reviewDesignAction} className="design-review">
              {hidden}
              <h3>制作へ進む前の確認</h3>
              <label className="design-check">
                <input type="checkbox" name="facts" />
                企業情報・文言に未確認の事実がない
              </label>
              <label className="design-check">
                <input type="checkbox" name="rights" />
                画像の利用範囲・権利を確認した
              </label>
              <label className="design-check">
                <input type="checkbox" name="layout" />
                PC・スマートフォンの構成を確認した
              </label>
              <label>
                確認メモ・修正指示
                <textarea
                  name="note"
                  rows={3}
                  maxLength={2000}
                  placeholder="修正依頼の場合は、変更点を記入してください"
                />
              </label>
              <div className="design-actions">
                <DesignSubmit name="decision" value="approve">
                  デザインを承認
                </DesignSubmit>
                <DesignSubmit name="decision" value="reject" secondary>
                  修正を依頼
                </DesignSubmit>
              </div>
            </form>
          )}
          {selected?.status === "approved" && (
            <div id="design-build" tabIndex={-1} className="design-review">
              <h3>このデザインで制作を進める</h3>
              <p>画像・制作条件・診断を固定し、サイト生成へ渡します。</p>
              {!selected.buildRequestedAt && !proposal ? (
                <form action={buildDesignAction}>
                  {hidden}
                  <DesignSubmit>
                    承認した画像からサイトを制作 <ArrowRight size={16} />
                  </DesignSubmit>
                </form>
              ) : (
                <p className="design-note">
                  サイト制作を依頼済みです。
                  {proposal?.status === "failed"
                    ? "制作に失敗しました。原因を確認し、下のボタンから再制作できます。"
                    : "制作結果を提案レビューで確認してください。"}
                </p>
              )}
              {proposal && ["failed", "rejected"].includes(proposal.status) && (
                <form action={retryDesignBuildAction}>
                  {hidden}
                  <DesignSubmit>同じ承認画像で再制作</DesignSubmit>
                  <p className="design-note">画像APIは再実行せず、新しい制作版を作ります。</p>
                </form>
              )}
              {proposal && (
                <Link
                  className="design-button secondary"
                  href={`/ops/review?company=${companyId}&version=${proposal.id}`}
                >
                  提案 第{proposal.version}版を確認 <ArrowRight size={16} />
                </Link>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
