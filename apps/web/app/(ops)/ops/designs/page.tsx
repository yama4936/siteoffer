import { randomUUID } from "node:crypto";
import { DEFAULT_DESIGN_BRIEF, DESIGN_LABELS, type DesignBrief } from "@siteoffer/core";
import { companies, designVersions, proposals, proposalVersions, siteAudits } from "@siteoffer/db";
import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { ArrowRight, Download, ImagePlus, Palette, Sparkles } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DesignRefresh, DesignSubmit } from "@/components/ops/design-controls";
import { Flash, first } from "@/components/ops/ui";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
import { requireUser } from "@/lib/session";
import {
  buildDesignAction,
  createDesignAction,
  retryDesignBuildAction,
  reviewDesignAction,
  uploadDesignAction,
} from "./actions";
import "./studio.css";

const fields: [keyof DesignBrief, string][] = [
  ["objective", "サイトで実現したいこと"],
  ["audience", "想定するお客様"],
  ["direction", "デザインの方向性"],
  ["scope", "制作範囲・確認事項"],
  ["updatePlan", "更新機能・既存データの引き継ぎ"],
];
export default async function DesignPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser("ops");
  const db = getDb();
  const sp = await searchParams;
  const candidates = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .orderBy(desc(companies.updatedAt))
    .limit(300);
  const companyId = first(sp, "company") ?? candidates[0]?.id;
  if (!companyId) return <p>企業を収集するとデザインを作成できます。</p>;
  if (!isUuid(companyId)) notFound();
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  if (!company) notFound();
  const { imageBase64: _image, ...metadata } = getTableColumns(designVersions);
  const versions = await db
    .select(metadata)
    .from(designVersions)
    .where(eq(designVersions.companyId, companyId))
    .orderBy(desc(designVersions.version));
  const selectedId = first(sp, "design");
  const selected = selectedId ? versions.find((d) => d.id === selectedId) : versions[0];
  if (selectedId && !selected) notFound();
  const [audit] = await db
    .select({ id: siteAudits.id })
    .from(siteAudits)
    .where(
      and(eq(siteAudits.companyId, companyId), eq(siteAudits.status, "evaluated"), eq(siteAudits.decision, "create")),
    )
    .orderBy(desc(siteAudits.createdAt))
    .limit(1);
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
  const configured = !!(process.env.SITEOFFER_IMAGE_MODEL && process.env.OPENAI_API_KEY);
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
        <form>
          <label htmlFor="design-company">案件を選択</label>
          <div className="design-inline">
            <select id="design-company" name="company" defaultValue={companyId}>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button className="design-button secondary" type="submit">
              開く
            </button>
          </div>
        </form>
      </header>
      <div className="design-steps">
        <span className="active">01　制作条件</span>
        <ArrowRight size={16} />
        <span className={selected?.imageSha256 ? "active" : ""}>02　デザイン画像</span>
        <ArrowRight size={16} />
        <span className={selected?.status === "approved" ? "active" : ""}>03　確認・承認</span>
        <ArrowRight size={16} />
        <span className={proposal ? "active" : ""}>04　サイト制作・提案PDF</span>
      </div>
      <div className="design-grid">
        <section className="design-card design-brief">
          <h2>
            <Palette size={19} />
            制作条件
          </h2>
          <h3>{company.name}</h3>
          <form action={createDesignAction}>
            {hidden}
            <input type="hidden" name="auditId" value={audit?.id ?? ""} />
            <input type="hidden" name="requestKey" value={randomUUID()} />
            {fields.map(([key, label]) => (
              <label key={key}>
                {label}
                <textarea
                  name={key}
                  required
                  maxLength={1600}
                  rows={key === "direction" || key === "updatePlan" ? 3 : 2}
                  defaultValue={brief[key]}
                />
              </label>
            ))}
            {selected?.reviewNote && <p className="design-note">前回の確認メモ：{selected.reviewNote}</p>}
            <div className="design-actions">
              <DesignSubmit name="source" value="openai" disabled={!audit || !configured}>
                <Sparkles size={16} />
                画像を生成
              </DesignSubmit>
              <DesignSubmit name="source" value="import" secondary disabled={!audit}>
                <ImagePlus size={16} />
                画像を取り込む版を作成
              </DesignSubmit>
            </div>
            <p className="design-muted">変更・再生成は新しい版として保存します。承認済みの画像は変更されません。</p>
            {!configured && (
              <p className="design-note">
                画像APIは未設定です。imagegenで生成した画像を取り込めます。APIを設定すると、この画面から生成できます。
              </p>
            )}
            {!audit && <p className="design-note">改善提案の対象と判定された診断が必要です。</p>}
          </form>
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
          {versions.length > 0 && (
            <nav className="design-versions" aria-label="デザインの版">
              {versions.map((d) => (
                <Link
                  key={d.id}
                  className={d.id === selected?.id ? "selected" : ""}
                  href={`/ops/designs?company=${companyId}&design=${d.id}`}
                >
                  第{d.version}版<span>{DESIGN_LABELS[d.status]}</span>
                </Link>
              ))}
            </nav>
          )}
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
            <form action={uploadDesignAction} className="design-upload">
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
              <a className="design-button secondary" href={`/ops/designs/${selected.id}/pdf`}>
                <Download size={16} />
                デザイン提案PDF
              </a>
            </div>
          )}
          {selected?.status === "in_review" && (
            <form action={reviewDesignAction} className="design-review">
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
            <div className="design-review">
              <h3>このデザインで制作を進める</h3>
              <p>画像・制作条件・診断を固定し、サイト生成へ渡します。</p>
              {!selected.buildRequestedAt ? (
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
              {proposal?.status === "approved" && (
                <a className="design-button secondary" href={`/ops/proposals/${proposal.id}/pdf`}>
                  <Download size={16} />
                  承認済み提案PDF
                </a>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
