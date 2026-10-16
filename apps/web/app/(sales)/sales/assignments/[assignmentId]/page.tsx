import { randomUUID } from "node:crypto";
import { EXISTING_DOMAIN_REVIEW_NOTICE, NEW_DOMAIN_AVAILABILITY_NOTICE } from "@siteoffer/core";
import { ChevronRight, Info, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OfferChanges } from "@/components/offer-changes";
import { ActivityForm } from "@/components/sales/activity-form";
import { ContractReportForm, DomainPreferenceForm, ReleaseForm } from "@/components/sales/forms";
import { BackLink, SectionCard } from "@/components/sales/section-card";
import { ProposalSharePanel } from "@/components/sales/share-panel";
import { AssignmentStatusBadge, ContractStatusBadge } from "@/components/sales/status-badge";
import { ExternalLink, TermsTable } from "@/components/sales/views";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { DescriptionList, EmptyState, Muted, PageHeader } from "@/components/ui/page";
import { getDb } from "@/lib/db";
import { getOfferChangeView } from "@/lib/offer-changes";
import { emptyActivity } from "@/lib/sales/activity-draft-types";
import { loadActivityDraft } from "@/lib/sales/activity-drafts";
import {
  activityKindLabel,
  DOMAIN_INTENTS,
  DOMAIN_MANAGERS,
  formatDate,
  formatDateTime,
  formatYen,
  labelOf,
  SUPPRESSION_LABELS,
  TRI_STATES,
} from "@/lib/sales/labels";
import { getMyAssignmentDetail } from "@/lib/sales/queries";
import { requireUser } from "@/lib/session";
import {
  issueShareAction,
  releaseAction,
  reportDealAction,
  revokeShareAction,
  saveDomainWishAction,
} from "../../../actions";

export const metadata = { title: "担当案件 | SiteOffer" };

/** 担当案件の詳細：活動記録、次回対応、運営相談、ドメイン希望、成約報告、契約確認状況 */
export default async function AssignmentDetailPage({ params }: { params: Promise<{ assignmentId: string }> }) {
  const user = await requireUser("sales");
  const { assignmentId } = await params;
  const r = await getMyAssignmentDetail(getDb(), user.actor, assignmentId);
  if (!r.ok) notFound();
  const d = r.value;
  const a = d.assignment;
  const offerChanges = await getOfferChangeView(getDb(), user.actor, assignmentId);
  const pref = d.domainPreference;
  const firstSite = d.sites[0];
  const draft = a.active ? await loadActivityDraft(getDb(), user.actor, a.id) : null;

  return (
    <>
      <BackLink href="/sales/assignments">担当案件へ</BackLink>
      <PageHeader
        title={d.company.name}
        actions={
          <Link
            href={`/sales/companies/${d.company.id}`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            企業詳細（診断根拠・改善デモ・電話台本）
            <ChevronRight />
          </Link>
        }
      />
      <nav className="mb-5 flex flex-wrap gap-2" aria-label="案件内の操作">
        {a.active && (
          <a href="#activity-entry" className={buttonVariants({ size: "sm" })}>
            活動・次回予定を記録
          </a>
        )}
        <a href="#activity-history" className={buttonVariants({ variant: "outline", size: "sm" })}>
          活動履歴を見る
        </a>
        {d.activities.some((x) => x.consultOps) && (
          <Link
            href={`/sales/consultations?assignment=${a.id}`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            運営への相談・回答
          </Link>
        )}
      </nav>
      {offerChanges && offerChanges.history.length > 0 && (
        <SectionCard id="offer-changes" title="販売条件の変更・確認">
          <OfferChanges data={offerChanges} viewerRole="sales" />
        </SectionCard>
      )}
      <SectionCard title="担当の概要">
        <DescriptionList>
          <dt>担当の状態</dt>
          <dd>
            <AssignmentStatusBadge status={a.status} />
          </dd>
          <dt>確保日時</dt>
          <dd>{formatDateTime(a.claimedAt)}</dd>
          <dt>次回対応日</dt>
          <dd>{formatDateTime(a.nextActionAt)}</dd>
          <dt>担当の期限</dt>
          <dd>{formatDateTime(a.expiresAt)}</dd>
          <dt>代表電話</dt>
          <dd className="tabular-nums">{d.company.representativePhone ?? "不明"}</dd>
          <dt>現在のサイト</dt>
          <dd>{firstSite ? <ExternalLink href={firstSite.url} /> : "不明"}</dd>
          {d.company.suppression !== "none" && (
            <>
              <dt>営業抑止</dt>
              <dd>
                <Badge variant="destructive">
                  {SUPPRESSION_LABELS[d.company.suppression] ?? d.company.suppression}
                </Badge>
                {d.company.recontactAfter && `（再連絡の目安：${formatDate(d.company.recontactAfter)}）`}
              </dd>
            </>
          )}
          {a.releaseReason && (
            <>
              <dt>終了の理由</dt>
              <dd>{a.releaseReason}</dd>
            </>
          )}
        </DescriptionList>
      </SectionCard>

      {a.active && (
        <SectionCard title="提案を共有">
          {!d.proposalVersionId ? (
            <Muted>運営のレビューを終えた改善提案はまだありません。</Muted>
          ) : !d.proposalHasDemo ? (
            <Muted>改善デモはまだありません。</Muted>
          ) : d.company.suppression !== "none" ? (
            <Muted>営業が止まっている企業のため、提案は共有できません。</Muted>
          ) : (
            <ProposalSharePanel
              actor={user.actor}
              proposalVersionId={d.proposalVersionId}
              issueAction={issueShareAction}
              revokeAction={revokeShareAction}
            />
          )}
        </SectionCard>
      )}

      <SectionCard title="契約確認の状況">
        {d.contracts.length === 0 ? (
          <Muted>成約報告はまだありません。</Muted>
        ) : (
          <ul className="grid gap-3">
            {d.contracts.map((c) => (
              <li key={c.id} className="space-y-1 rounded-lg border p-4 text-sm">
                <ContractStatusBadge status={c.status} />
                <div className="text-muted-foreground text-xs">報告日時：{formatDateTime(c.reportedAt)}</div>
                {c.completedAt && (
                  <div className="text-muted-foreground text-xs">契約完了：{formatDateTime(c.completedAt)}</div>
                )}
                {c.documentRef && <div>契約資料：{c.documentRef}</div>}
                {c.reportNote && <div className="whitespace-pre-wrap">報告メモ：{c.reportNote}</div>}
                {c.closeReason && <div>運営からの理由：{c.closeReason}</div>}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {a.active && (
        <SectionCard id="activity-entry" title="活動を記録する">
          {draft && (
            <ActivityForm
              key={a.id}
              assignmentId={a.id}
              initial={draft}
              defaults={emptyActivity(new Date())}
              requestKey={randomUUID()}
              nextActionLabel={formatDateTime(a.nextActionAt)}
              previousNote={d.activities.find((x) => !!x.note)?.note ?? null}
            />
          )}
        </SectionCard>
      )}

      <SectionCard id="activity-history" title="活動履歴">
        {d.activities.length === 0 ? (
          <EmptyState>活動の記録はまだありません。</EmptyState>
        ) : (
          <ol className="relative space-y-4 border-l pl-5">
            {d.activities.map((x) => (
              <li key={x.id} className="relative space-y-1 text-sm">
                <span
                  aria-hidden="true"
                  className="absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 border-card bg-primary"
                />
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <strong className="font-semibold">{activityKindLabel(x.kind)}</strong>{" "}
                  <span className="text-muted-foreground text-xs">{formatDateTime(x.occurredAt)}</span>
                  {x.consultOps && (
                    <Link href={`/sales/consultations?focus=${x.id}`} className="text-primary underline">
                      相談の回答・状況を見る
                    </Link>
                  )}
                </div>
                {x.note && <p className="whitespace-pre-wrap leading-relaxed">{x.note}</p>}
                {x.nextActionMode === "clear" && (
                  <div className="text-muted-foreground text-xs">次回対応日を解除しました</div>
                )}
                {x.nextActionAt && (
                  <div className="text-muted-foreground text-xs">次回対応日：{formatDateTime(x.nextActionAt)}</div>
                )}
              </li>
            ))}
          </ol>
        )}
      </SectionCard>

      <SectionCard title="ドメイン希望の聞き取り">
        {pref && (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
            <DescriptionList>
              <dt>希望</dt>
              <dd>{labelOf(DOMAIN_INTENTS, pref.intent)}</dd>
              <dt>新規ドメイン候補</dt>
              <dd>{pref.newDomainCandidates.length > 0 ? pref.newDomainCandidates.join("、") : "なし"}</dd>
              <dt>現在の管理者</dt>
              <dd>{labelOf(DOMAIN_MANAGERS, pref.currentManager)}</dd>
              <dt>メールの利用</dt>
              <dd>{labelOf(TRI_STATES, pref.usesEmail)}</dd>
              <dt>運営の確認</dt>
              <dd>
                {pref.confirmedAt ? (
                  <Badge variant="success">確認済み（{formatDateTime(pref.confirmedAt)}）</Badge>
                ) : pref.needsOpsReview ? (
                  <Badge variant="warning">確認待ち</Badge>
                ) : (
                  <Badge variant="secondary">不要</Badge>
                )}
              </dd>
              <dt>最終更新</dt>
              <dd>{formatDateTime(pref.updatedAt)}</dd>
            </DescriptionList>
            {pref.newDomainCandidates.length > 0 && (
              <p className="text-muted-foreground text-xs">{NEW_DOMAIN_AVAILABILITY_NOTICE}</p>
            )}
          </div>
        )}
        {a.active ? (
          <DomainPreferenceForm
            action={saveDomainWishAction}
            assignmentId={a.id}
            companyId={d.company.id}
            initial={{
              currentUrl: pref?.currentUrl ?? firstSite?.url ?? "",
              currentDomain: pref?.currentDomain ?? firstSite?.domain ?? "",
              intent: pref?.intent ?? "undecided",
              newDomainCandidates: pref?.newDomainCandidates ?? [],
              currentManager: pref?.currentManager ?? "unknown",
              usesEmail: pref?.usesEmail ?? "unknown",
              customerWish: pref?.customerWish ?? "",
            }}
            availabilityNotice={NEW_DOMAIN_AVAILABILITY_NOTICE}
            reviewNotice={EXISTING_DOMAIN_REVIEW_NOTICE}
          />
        ) : (
          !pref && <Muted>記録はありません。</Muted>
        )}
      </SectionCard>

      {(d.showReport || d.contracts.some((c) => c.status === "reported" || c.status === "under_review")) && (
        <SectionCard title="成約報告">
          {d.terms.length === 0 && (
            <Alert variant="warning">
              <TriangleAlert />
              <AlertDescription>販売条件・報酬条件：未設定（運営に確認してください）</AlertDescription>
            </Alert>
          )}
          <TermsTable terms={d.terms} />
          {d.showReport ? (
            <ContractReportForm
              blockedReason={
                offerChanges?.history.some((h) => h.status === "pending")
                  ? "販売条件の変更に回答してから成約を報告してください。"
                  : undefined
              }
              action={reportDealAction}
              assignmentId={a.id}
              salesOfferId={d.salesOfferId}
              proposalVersionId={d.proposalVersionId}
              terms={d.terms.map((t) => ({ id: t.id, label: `${t.name}（${formatYen(t.price)}）` }))}
            />
          ) : (
            <p
              role="status"
              className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
            >
              成約報告を受け付けました。運営が契約資料を確認しています。報酬は契約完了時に確定します。
            </p>
          )}
        </SectionCard>
      )}

      {a.active && a.status !== "contract_pending" && (
        <SectionCard title="担当を手放す" className="border-destructive/30">
          <Alert variant="info">
            <Info />
            <AlertDescription>
              手放すと他の営業ユーザーが確保できるようになります。営業拒否の記録は消えません。
            </AlertDescription>
          </Alert>
          <ReleaseForm action={releaseAction} assignmentId={a.id} />
        </SectionCard>
      )}
    </>
  );
}
