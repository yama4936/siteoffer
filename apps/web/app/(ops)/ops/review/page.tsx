import Link from "next/link";
import { Flash, Forbidden, ReturnTo } from "@/components/ops/ui";
import { getDb } from "@/lib/db";
import { sellableIssueText } from "@/lib/ops/commands";
import { fmtDate, label, PIPELINE_LABEL, PROPOSAL_STATUS_LABEL, rewardRuleText, yen } from "@/lib/ops/format";
import { listReviewQueue } from "@/lib/ops/queries";
import { sellableIssues } from "@/lib/ops/sellable";
import { getCurrentActor } from "@/lib/session";
import { makeSellableAction, reviewProposalAction } from "../actions";

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const r = await listReviewQueue(getDb(), await getCurrentActor());
  if (!r.ok) return <Forbidden />;
  const { inReview, readyCandidates, activeTerms } = r.value;
  const here = "/ops/review";
  return (
    <main>
      <h1>2. 診断・生成・レビュー・営業可能化</h1>
      <Flash searchParams={await searchParams} />

      <section>
        <h2>運営確認待ちの提案版（{inReview.length}件）</h2>
        <p className="muted">
          診断の根拠・生成内容・デモは企業の詳細で確認できます。根拠のない実績等が含まれていないかを確かめてから承認します（AC-08）。
        </p>
        <table>
          <thead>
            <tr>
              <th>企業</th>
              <th>版</th>
              <th>状態</th>
              <th>生成日時</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {inReview.map(({ v, companyId, companyName }) => (
              <tr key={v.id}>
                <td>
                  <Link href={`/ops/companies/${companyId}?returnTo=${encodeURIComponent(here)}`}>{companyName}</Link>
                </td>
                <td>v{v.version}</td>
                <td>{label(PROPOSAL_STATUS_LABEL, v.status)}</td>
                <td>{fmtDate(v.createdAt)}</td>
                <td>
                  <form action={reviewProposalAction} className="inline">
                    <ReturnTo path={here} />
                    <input type="hidden" name="proposalVersionId" value={v.id} />
                    <input type="hidden" name="decision" value="approved" />
                    <input name="note" placeholder="確認メモ（任意）" />
                    <button type="submit">承認</button>
                  </form>
                  <form action={reviewProposalAction} className="inline">
                    <ReturnTo path={here} />
                    <input type="hidden" name="proposalVersionId" value={v.id} />
                    <input type="hidden" name="decision" value="rejected" />
                    <input name="note" placeholder="差し戻しの理由（必須）" required />
                    <button type="submit">差し戻し</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>営業可能化を待つ候補（承認済みの版がある）</h2>
        {activeTerms.length === 0 ? (
          <p className="warn">
            有効な販売条件・報酬条件の版がありません。<Link href="/ops/contracts">商品条件</Link>で作成してください。
          </p>
        ) : null}
        <table>
          <thead>
            <tr>
              <th>企業</th>
              <th>準備段階</th>
              <th>最新の版</th>
              <th>営業可能にできない理由</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {readyCandidates.map(({ company, latestVersion }) => {
              const issues = sellableIssues({ company, latestVersion, terms: null }).filter(
                (i) => i !== "terms_not_selected",
              );
              return (
                <tr key={company.id}>
                  <td>
                    <Link href={`/ops/companies/${company.id}?returnTo=${encodeURIComponent(here)}`}>
                      {company.name}
                    </Link>
                  </td>
                  <td>{label(PIPELINE_LABEL, company.pipelineStatus)}</td>
                  <td>
                    {latestVersion
                      ? `v${latestVersion.version}（${label(PROPOSAL_STATUS_LABEL, latestVersion.status)}）`
                      : "—"}
                  </td>
                  <td className="warn">{issues.map(sellableIssueText).join(" / ") || "—"}</td>
                  <td>
                    <form action={makeSellableAction} className="inline">
                      <ReturnTo path={here} />
                      <input type="hidden" name="companyId" value={company.id} />
                      <select name="productTermsId" defaultValue="">
                        <option value="">条件の版を選ぶ</option>
                        {activeTerms.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.version}：{yen(t.price)} / {rewardRuleText(t.rewardRule)}
                          </option>
                        ))}
                      </select>
                      <button type="submit">営業可能にする</button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted">条件が未設定の版を選んだ場合や、最新の版が未承認の場合は、サーバー側で拒否されます。</p>
      </section>
    </main>
  );
}
