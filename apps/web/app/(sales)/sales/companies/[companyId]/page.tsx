import { ArrowRight, ExternalLink as ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CompanyWorkspace } from "@/components/sales/company-workspace";
import { ClaimButton } from "@/components/sales/forms";
import { ProposalSharePanel } from "@/components/sales/share-panel";
import {
  CallScriptView,
  ExternalLink,
  FindingsList,
  ProposalSummary,
  SharedStateBadges,
  TermsTable,
} from "@/components/sales/views";
import { DescriptionList, Muted } from "@/components/ui/page";
import { getDb } from "@/lib/db";
import { getImprovementAvailability, getImprovementSource } from "@/lib/sales/improvement";
import { formatDate, formatDateTime } from "@/lib/sales/labels";
import { getCompanyDetail, listSellableCompanies } from "@/lib/sales/queries";
import { requireUser } from "@/lib/session";
import { claimAction, issueShareAction, revokeShareAction } from "../../../actions";

export const metadata = { title: "提案・サイト比較 | SiteOffer" };
export default async function CompanyDetailPage({ params }: { params: Promise<{ companyId: string }> }) {
  const user = await requireUser("sales");
  const { companyId } = await params;
  const db = getDb();
  const r = await getCompanyDetail(db, user.actor, companyId);
  if (!r.ok) notFound();
  const d = r.value;
  const c = d.company;
  const [imp, queue] = await Promise.all([
    getImprovementSource(db, user.actor, companyId),
    listSellableCompanies(db, user.actor),
  ]);
  const available = await getImprovementAvailability(imp.ok ? imp.value.artifactDir : null);
  const preview = d.proposal?.hasDemo
    ? `/sales/companies/${c.id}/preview/index.html`
    : available.hasSite
      ? `/sales/companies/${c.id}/site/index.html`
      : null;
  const action = d.showClaim ? (
    <ClaimButton action={claimAction} companyId={c.id} salesOfferId={d.salesOfferId!} />
  ) : d.assignment === "mine" && d.myAssignmentId ? (
    <Link href={`/sales/assignments/${d.myAssignmentId}`} className="review-primary">
      担当案件を開く <ArrowRight size={18} />
    </Link>
  ) : (
    <Muted>現在この企業の担当は確保できません。</Muted>
  );
  const sharing =
    d.proposal?.hasDemo && d.assignment === "mine" && c.suppression === "none" ? (
      <ProposalSharePanel
        actor={user.actor}
        proposalVersionId={d.proposal.versionId}
        issueAction={issueShareAction}
        revokeAction={revokeShareAction}
      />
    ) : (
      <p>
        {d.proposal?.hasDemo
          ? "担当を確保すると、期限付きの提案リンクを発行できます。"
          : "共有できる提案デモは準備中です。"}
      </p>
    );
  return (
    <CompanyWorkspace
      key={c.id}
      company={{
        id: c.id,
        name: c.name,
        location: [c.prefecture, c.city].filter(Boolean).join(" "),
        industry: c.industry,
        phone: c.representativePhone,
        version: d.proposal?.version ?? null,
        mock: d.proposal?.isMock ?? false,
        pdf: d.proposal?.hasDesignPdf ? `/sales/proposals/${d.proposal.versionId}/pdf` : null,
        assignment: d.assignment,
        website: d.sites[0]?.url ?? null,
        preview,
      }}
      queue={queue.ok ? queue.value : []}
      highlights={d.proposal?.proposalText?.measures.map((m) => m.title) ?? []}
      action={action}
      sharing={sharing}
      proposal={
        <>
          <h2>改善提案</h2>
          {d.proposal?.proposalText ? (
            <ProposalSummary text={d.proposal.proposalText} />
          ) : (
            <Muted>運営のレビューを終えた改善提案はまだありません。</Muted>
          )}
          {available.hasProposal && (
            <p className="mt-6">
              <Link href={`/sales/companies/${c.id}/proposal`} className="review-outline">
                改良資料を見る <ArrowRight size={16} />
              </Link>
            </p>
          )}
          {available.hasSite && (
            <p className="mt-4">
              <a
                href={`/sales/companies/${c.id}/site/index.html`}
                target="_blank"
                rel="noreferrer"
                className="review-outline"
              >
                診断に付属する改善サイト <ExternalLinkIcon size={16} />
              </a>
            </p>
          )}
        </>
      }
      info={
        <>
          <h2>企業情報</h2>
          <SharedStateBadges assignment={d.assignment} suppression={c.suppression} />
          {c.suppression === "not_now" && c.recontactAfter && (
            <p className="my-4">再連絡の目安：{formatDate(c.recontactAfter)}（担当の再開は運営の確認後）</p>
          )}
          <DescriptionList className="mt-6">
            <dt>企業名</dt>
            <dd>{c.name}</dd>
            <dt>所在地</dt>
            <dd>{c.address ?? ([c.prefecture, c.city].filter(Boolean).join(" ") || "不明")}</dd>
            <dt>業種</dt>
            <dd>{c.industry ?? "不明"}</dd>
            <dt>代表電話</dt>
            <dd>{c.representativePhone ?? "不明"}</dd>
            <dt>現在のサイト</dt>
            <dd>
              {d.sites.length
                ? d.sites.map((s) => (
                    <div key={s.url}>
                      <ExternalLink href={s.url} />
                    </div>
                  ))
                : "不明"}
            </dd>
          </DescriptionList>
        </>
      }
      audit={
        <>
          <h2>診断結果・改善の根拠</h2>
          {d.audit ? (
            <>
              <p className="mb-4 text-sm text-muted-foreground">
                評価日時：{formatDateTime(d.audit.evaluatedAt)} / 総合点：{d.audit.totalScore ?? "未評価"}
                {d.audit.scoreConfirmed === false ? "（未確定）" : ""}
              </p>
              {d.audit.status === "unevaluable" && (
                <p className="mb-4">評価できませんでした：{d.audit.unevaluableReason ?? "理由不明"}</p>
              )}
              <p className="mb-5 text-sm text-muted-foreground">
                観測事実と推測を区別し、未確認の内容は企業に断定して伝えないでください。
              </p>
              <FindingsList findings={d.audit.findings} />
            </>
          ) : (
            <Muted>診断結果はまだありません。</Muted>
          )}
        </>
      }
      terms={
        <>
          <h2>販売条件・報酬条件</h2>
          <TermsTable terms={d.terms} />
        </>
      }
      script={
        <>
          <h2>電話台本</h2>
          {d.proposal?.callScript ? (
            <CallScriptView script={d.proposal.callScript} />
          ) : (
            <Muted>電話台本はまだありません。</Muted>
          )}
          <p className="mt-6 text-sm text-muted-foreground">
            提案は非公式のものです。成約や効果を約束する言い方はしないでください。
          </p>
        </>
      }
    />
  );
}
