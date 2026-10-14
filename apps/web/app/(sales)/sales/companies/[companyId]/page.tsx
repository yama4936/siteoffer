import Link from "next/link";
import { notFound } from "next/navigation";
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
import { getDb } from "@/lib/db";
import { getImprovementAvailability, getImprovementSource } from "@/lib/sales/improvement";
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
  // 改良資料・改善後サイト（最新の評価済み診断の成果物ディレクトリ）。権限は企業詳細と同じ判定
  const imp = await getImprovementSource(getDb(), user.actor, companyId);
  const available = await getImprovementAvailability(imp.ok ? imp.value.artifactDir : null);

  return (
    <main>
      <p>
        <Link href="/sales/companies">← 企業一覧へ</Link>
      </p>
      <h1>{c.name}</h1>
      <p>
        <SharedStateBadges assignment={d.assignment} suppression={c.suppression} />
      </p>
      {c.suppression === "not_now" && c.recontactAfter && (
        <p className="sub">企業が示した再連絡の目安：{formatDate(c.recontactAfter)}（担当の再開は運営の確認後）</p>
      )}

      <section>
        {d.showClaim ? (
          <ClaimButton action={claimAction} companyId={c.id} />
        ) : d.assignment === "mine" && d.myAssignmentId ? (
          <Link href={`/sales/assignments/${d.myAssignmentId}`}>担当案件を開く（活動記録・成約報告）</Link>
        ) : (
          <p className="sub">現在この企業の担当は確保できません。</p>
        )}
      </section>

      <section>
        <h2>企業情報</h2>
        <dl className="kv">
          <dt>所在地</dt>
          <dd>{c.address ?? ([c.prefecture, c.city].filter(Boolean).join(" ") || "不明")}</dd>
          <dt>業種</dt>
          <dd>{c.industry ?? "不明"}</dd>
          <dt>代表電話</dt>
          <dd>{c.representativePhone ?? "不明"}</dd>
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
        </dl>
      </section>

      <section>
        <h2>診断の根拠</h2>
        {!d.audit ? (
          <p>診断結果はまだありません。</p>
        ) : (
          <>
            <dl className="kv">
              <dt>診断したURL</dt>
              <dd>
                <ExternalLink href={d.audit.finalUrl ?? d.audit.targetUrl} />
              </dd>
              <dt>診断日時</dt>
              <dd>{formatDateTime(d.audit.evaluatedAt)}</dd>
              <dt>総合点</dt>
              <dd>
                {d.audit.totalScore === null
                  ? "未確定（評価できない項目が多いため）"
                  : `${d.audit.totalScore}${d.audit.scoreConfirmed === false ? "（未確定）" : ""}`}
              </dd>
            </dl>
            {d.audit.status === "unevaluable" && (
              <p className="warn">このサイトは評価できませんでした：{d.audit.unevaluableReason ?? "理由不明"}</p>
            )}
            <p className="hint">
              「観測事実に基づく」はページ上で確認した内容です。「推測を含む」は観測から推し量った内容で、企業に伝えるときは断定しないでください。
            </p>
            <FindingsList findings={d.audit.findings} />
          </>
        )}
      </section>

      <section>
        <h2>改善提案とデモ</h2>
        {!d.proposal ? (
          <p>運営のレビューを終えた改善提案はまだありません。</p>
        ) : (
          <div className="stack">
            <p className="sub">提案 第{d.proposal.version}版（運営レビュー済み）</p>
            {!d.proposal.hasDemo ? (
              <p className="sub">改善デモはまだありません。</p>
            ) : d.assignment === "mine" && c.suppression === "none" ? (
              <>
                <h3>提案を共有</h3>
                <ProposalSharePanel
                  actor={user.actor}
                  proposalVersionId={d.proposal.versionId}
                  issueAction={issueShareAction}
                  revokeAction={revokeShareAction}
                />
              </>
            ) : (
              <p className="sub">
                改善デモがあります。企業への共有（期限付きリンクの発行）は、この企業の担当を確保してから行えます。
              </p>
            )}
            {d.proposal.proposalText && <ProposalSummary text={d.proposal.proposalText} />}
          </div>
        )}
      </section>

      <section>
        <h2>改良資料と改善後サイト</h2>
        <ul>
          <li>
            {available.hasProposal ? (
              <Link href={`/sales/companies/${c.id}/proposal`}>改良資料を見る</Link>
            ) : (
              <span className="sub">改良資料：準備中</span>
            )}
          </li>
          <li>
            {available.hasSite ? (
              <a href={`/sales/companies/${c.id}/site/index.html`} target="_blank" rel="noopener noreferrer">
                改善後サイトを開く（新しいタブ）
              </a>
            ) : (
              <span className="sub">改善後サイト：準備中</span>
            )}
          </li>
        </ul>
        <p className="hint">営業の確認用の表示です。企業に渡すURLではありません（ログインが必要です）。</p>
      </section>

      <section>
        <h2>販売条件・報酬条件</h2>
        <TermsTable terms={d.terms} />
      </section>

      <section>
        <h2>電話台本</h2>
        {d.proposal?.callScript ? <CallScriptView script={d.proposal.callScript} /> : <p>電話台本はまだありません。</p>}
        <p className="hint">成約や効果を約束する言い方はしないでください。改善提案は非公式のものです。</p>
      </section>
    </main>
  );
}
