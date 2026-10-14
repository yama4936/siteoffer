import { EXISTING_DOMAIN_REVIEW_NOTICE, NEW_DOMAIN_AVAILABILITY_NOTICE } from "@siteoffer/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActivityForm, ContractReportForm, DomainPreferenceForm, ReleaseForm } from "@/components/sales/forms";
import { ExternalLink } from "@/components/sales/views";
import { getDb } from "@/lib/db";
import {
  ASSIGNMENT_STATUS_LABELS,
  activityKindLabel,
  CONTRACT_STATUS_LABELS,
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
import { recordActivityAction, releaseAction, reportDealAction, saveDomainWishAction } from "../../../actions";

export const metadata = { title: "担当案件 | SiteOffer" };

/** 担当案件の詳細：活動記録、次回対応、運営相談、ドメイン希望、成約報告、契約確認状況 */
export default async function AssignmentDetailPage({ params }: { params: Promise<{ assignmentId: string }> }) {
  const user = await requireUser("sales");
  const { assignmentId } = await params;
  const r = await getMyAssignmentDetail(getDb(), user.actor, assignmentId);
  if (!r.ok) notFound();
  const d = r.value;
  const a = d.assignment;
  const pref = d.domainPreference;
  const firstSite = d.sites[0];

  return (
    <main>
      <p>
        <Link href="/sales/assignments">← 担当案件へ</Link>
      </p>
      <h1>{d.company.name}</h1>
      <dl className="kv">
        <dt>担当の状態</dt>
        <dd>{ASSIGNMENT_STATUS_LABELS[a.status as keyof typeof ASSIGNMENT_STATUS_LABELS] ?? a.status}</dd>
        <dt>確保日時</dt>
        <dd>{formatDateTime(a.claimedAt)}</dd>
        <dt>次回対応日</dt>
        <dd>{formatDateTime(a.nextActionAt)}</dd>
        <dt>担当の期限</dt>
        <dd>{formatDateTime(a.expiresAt)}</dd>
        <dt>代表電話</dt>
        <dd>{d.company.representativePhone ?? "不明"}</dd>
        <dt>現在のサイト</dt>
        <dd>{firstSite ? <ExternalLink href={firstSite.url} /> : "不明"}</dd>
        {d.company.suppression !== "none" && (
          <>
            <dt>営業抑止</dt>
            <dd>
              {SUPPRESSION_LABELS[d.company.suppression] ?? d.company.suppression}
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
      </dl>
      <p>
        <Link href={`/sales/companies/${d.company.id}`}>企業詳細（診断根拠・改善デモ・電話台本）</Link>
      </p>

      <section>
        <h2>契約確認の状況</h2>
        {d.contracts.length === 0 ? (
          <p>成約報告はまだありません。</p>
        ) : (
          <ul className="cards">
            {d.contracts.map((c) => (
              <li key={c.id}>
                <strong>{CONTRACT_STATUS_LABELS[c.status] ?? c.status}</strong>
                <div className="sub">報告日時：{formatDateTime(c.reportedAt)}</div>
                {c.completedAt && <div className="sub">契約完了：{formatDateTime(c.completedAt)}</div>}
                {c.documentRef && <div>契約資料：{c.documentRef}</div>}
                {c.reportNote && <div>報告メモ：{c.reportNote}</div>}
                {c.closeReason && <div>運営からの理由：{c.closeReason}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {a.active && (
        <section>
          <h2>活動を記録する</h2>
          <ActivityForm action={recordActivityAction} assignmentId={a.id} />
        </section>
      )}

      <section>
        <h2>活動履歴</h2>
        {d.activities.length === 0 ? (
          <p>活動の記録はまだありません。</p>
        ) : (
          <ul className="cards">
            {d.activities.map((x) => (
              <li key={x.id}>
                <strong>{activityKindLabel(x.kind)}</strong> <span className="sub">{formatDateTime(x.occurredAt)}</span>
                {x.consultOps && <span className="badge badge-guess">運営に相談</span>}
                {x.note && <p>{x.note}</p>}
                {x.nextActionAt && <div className="sub">次回対応日：{formatDateTime(x.nextActionAt)}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>ドメイン希望の聞き取り</h2>
        {pref && (
          <div className="stack">
            <dl className="kv">
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
                {pref.confirmedAt
                  ? `確認済み（${formatDateTime(pref.confirmedAt)}）`
                  : pref.needsOpsReview
                    ? "確認待ち"
                    : "不要"}
              </dd>
              <dt>最終更新</dt>
              <dd>{formatDateTime(pref.updatedAt)}</dd>
            </dl>
            {pref.newDomainCandidates.length > 0 && <p className="hint">{NEW_DOMAIN_AVAILABILITY_NOTICE}</p>}
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
          !pref && <p>記録はありません。</p>
        )}
      </section>

      {d.showReport && (
        <section>
          <h2>成約報告</h2>
          {d.terms.length === 0 && <p className="warn">販売条件・報酬条件：未設定（運営に確認してください）</p>}
          <ContractReportForm
            action={reportDealAction}
            assignmentId={a.id}
            proposalVersionId={d.proposalVersionId}
            terms={d.terms.map((t) => ({ id: t.id, label: `${t.name}（${formatYen(t.price)}）` }))}
          />
        </section>
      )}

      {a.active && a.status !== "contract_pending" && (
        <section>
          <h2>担当を手放す</h2>
          <p className="hint">手放すと他の営業ユーザーが確保できるようになります。営業拒否の記録は消えません。</p>
          <ReleaseForm action={releaseAction} assignmentId={a.id} />
        </section>
      )}
    </main>
  );
}
