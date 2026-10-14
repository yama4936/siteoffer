import { ChevronRight, Info, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ClaimButton } from "@/components/sales/forms";
import { BackLink, SectionCard } from "@/components/sales/section-card";
import { ProposalSharePanel } from "@/components/sales/share-panel";
import {
  CallScriptView,
  ExternalLink,
  FindingsList,
  ProposalSummary,
  SharedStateBadges,
  TermsTable,
} from "@/components/sales/views";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DescriptionList, Muted, PageHeader } from "@/components/ui/page";
import { getDb } from "@/lib/db";
import { formatDate, formatDateTime } from "@/lib/sales/labels";
import { getCompanyDetail } from "@/lib/sales/queries";
import { requireUser } from "@/lib/session";
import { claimAction, issueShareAction, revokeShareAction } from "../../../actions";

export const metadata = { title: "企業詳細 | SiteOffer" };

/** 企業詳細（16章）：現サイト、診断根拠、改善デモ、販売条件・報酬、電話台本、担当確保 */
export default async function CompanyDetailPage({ params }: { params: Promise<{ companyId: string }> }) {
  const user = await requireUser("sales");
  const { companyId } = await params;
  const r = await getCompanyDetail(getDb(), user.actor, companyId);
  if (!r.ok) notFound();
  const d = r.value;
  const c = d.company;

  return (
    <>
      <BackLink href="/sales/companies">企業一覧へ</BackLink>
      <PageHeader
        title={c.name}
        description={
          <div className="space-y-2">
            <SharedStateBadges assignment={d.assignment} suppression={c.suppression} />
            {c.suppression === "not_now" && c.recontactAfter && (
              <p>企業が示した再連絡の目安：{formatDate(c.recontactAfter)}（担当の再開は運営の確認後）</p>
            )}
          </div>
        }
      />

      <Card className="mb-6 py-4">
        <CardContent className="px-4">
          {d.showClaim ? (
            <ClaimButton action={claimAction} companyId={c.id} />
          ) : d.assignment === "mine" && d.myAssignmentId ? (
            <Link href={`/sales/assignments/${d.myAssignmentId}`} className={buttonVariants({ variant: "default" })}>
              担当案件を開く（活動記録・成約報告）
              <ChevronRight />
            </Link>
          ) : (
            <Muted>現在この企業の担当は確保できません。</Muted>
          )}
        </CardContent>
      </Card>

      <SectionCard title="企業情報">
        <DescriptionList>
          <dt>所在地</dt>
          <dd>{c.address ?? ([c.prefecture, c.city].filter(Boolean).join(" ") || "不明")}</dd>
          <dt>業種</dt>
          <dd>{c.industry ?? "不明"}</dd>
          <dt>代表電話</dt>
          <dd className="tabular-nums">{c.representativePhone ?? "不明"}</dd>
          <dt>現在のサイト</dt>
          <dd>
            {d.sites.length === 0
              ? "不明"
              : d.sites.map((s) => (
                  <div key={s.url}>
                    <ExternalLink href={s.url} />
                  </div>
                ))}
          </dd>
        </DescriptionList>
      </SectionCard>

      <SectionCard title="診断の根拠">
        {!d.audit ? (
          <Muted>診断結果はまだありません。</Muted>
        ) : (
          <>
            <DescriptionList>
              <dt>診断したURL</dt>
              <dd>
                <ExternalLink href={d.audit.finalUrl ?? d.audit.targetUrl} />
              </dd>
              <dt>診断日時</dt>
              <dd>{formatDateTime(d.audit.evaluatedAt)}</dd>
              <dt>総合点</dt>
              <dd className="font-semibold tabular-nums">
                {d.audit.totalScore === null
                  ? "未確定（評価できない項目が多いため）"
                  : `${d.audit.totalScore}${d.audit.scoreConfirmed === false ? "（未確定）" : ""}`}
              </dd>
            </DescriptionList>
            {d.audit.status === "unevaluable" && (
              <Alert variant="warning">
                <TriangleAlert />
                <AlertDescription>
                  このサイトは評価できませんでした：{d.audit.unevaluableReason ?? "理由不明"}
                </AlertDescription>
              </Alert>
            )}
            <Alert variant="info">
              <Info />
              <AlertDescription>
                「観測事実に基づく」はページ上で確認した内容です。「推測を含む」は観測から推し量った内容で、企業に伝えるときは断定しないでください。
              </AlertDescription>
            </Alert>
            <FindingsList findings={d.audit.findings} />
          </>
        )}
      </SectionCard>

      <SectionCard
        title="改善提案とデモ"
        actions={
          d.proposal ? <Badge variant="secondary">提案 第{d.proposal.version}版（運営レビュー済み）</Badge> : undefined
        }
      >
        {!d.proposal ? (
          <Muted>運営のレビューを終えた改善提案はまだありません。</Muted>
        ) : (
          <div className="space-y-5">
            {!d.proposal.hasDemo ? (
              <Muted className="block">改善デモはまだありません。</Muted>
            ) : d.assignment === "mine" && c.suppression === "none" ? (
              <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
                <h3 className="font-semibold text-base">提案を共有</h3>
                <ProposalSharePanel
                  actor={user.actor}
                  proposalVersionId={d.proposal.versionId}
                  issueAction={issueShareAction}
                  revokeAction={revokeShareAction}
                />
              </div>
            ) : (
              <Muted className="block">
                改善デモがあります。企業への共有（期限付きリンクの発行）は、この企業の担当を確保してから行えます。
              </Muted>
            )}
            {d.proposal.proposalText && <ProposalSummary text={d.proposal.proposalText} />}
          </div>
        )}
      </SectionCard>

      <SectionCard title="販売条件・報酬条件">
        <TermsTable terms={d.terms} />
      </SectionCard>

      <SectionCard title="電話台本">
        {d.proposal?.callScript ? (
          <CallScriptView script={d.proposal.callScript} />
        ) : (
          <Muted className="block">電話台本はまだありません。</Muted>
        )}
        <Alert variant="warning">
          <TriangleAlert />
          <AlertDescription>
            成約や効果を約束する言い方はしないでください。改善提案は非公式のものです。
          </AlertDescription>
        </Alert>
      </SectionCard>
    </>
  );
}
