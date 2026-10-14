import { getDb } from "@/lib/db";
import {
  CONTRACT_STATUS_LABELS,
  formatDate,
  formatDateTime,
  formatYen,
  REWARD_STATUS_LABELS,
} from "@/lib/sales/labels";
import { getMyEarnings } from "@/lib/sales/queries";
import { requireUser } from "@/lib/session";

export const metadata = { title: "実績・報酬 | SiteOffer" };

/** 実績・報酬（16章）：契約完了、発生報酬、支払予定、支払済み。自分の分だけ */
export default async function EarningsPage() {
  const user = await requireUser("sales");
  const r = await getMyEarnings(getDb(), user.actor);
  if (!r.ok) {
    return (
      <main>
        <h1>実績・報酬</h1>
        <p role="alert">表示できませんでした。</p>
      </main>
    );
  }
  const { contracts, rewards, totals } = r.value;

  return (
    <main>
      <h1>実績・報酬</h1>
      <div className="totals">
        <div>
          契約完了
          <strong>{totals.completedContracts}件</strong>
        </div>
        <div>
          発生報酬（取り消しを除く）
          <strong>{formatYen(totals.accrued)}</strong>
        </div>
        <div>
          支払予定
          <strong>{formatYen(totals.scheduled)}</strong>
        </div>
        <div>
          支払済み
          <strong>{formatYen(totals.paid)}</strong>
        </div>
      </div>
      <p className="hint">
        報酬は運営が契約資料を確認して契約完了にした時点で発生します。成約報告だけでは発生しません。支払日・金額の変更は運営が記録します。
      </p>

      <h2>報酬</h2>
      {rewards.length === 0 ? (
        <p>報酬はまだありません。</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>企業</th>
                <th>状態</th>
                <th>金額</th>
                <th>発生日</th>
                <th>支払予定日</th>
                <th>支払日</th>
              </tr>
            </thead>
            <tbody>
              {rewards.map((x) => (
                <tr key={x.id}>
                  <td>{x.companyName}</td>
                  <td>{REWARD_STATUS_LABELS[x.status] ?? x.status}</td>
                  <td>
                    {formatYen(x.currentAmount)}
                    {x.adjusted && <span className="sub">（運営が調整）</span>}
                  </td>
                  <td>{formatDate(x.accruedAt)}</td>
                  <td>{formatDate(x.scheduledFor)}</td>
                  <td>{formatDate(x.paidAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>成約報告と契約</h2>
      {contracts.length === 0 ? (
        <p>成約報告はまだありません。</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>企業</th>
                <th>契約の状態</th>
                <th>報告日時</th>
                <th>契約完了</th>
              </tr>
            </thead>
            <tbody>
              {contracts.map((c) => (
                <tr key={c.id}>
                  <td>{c.companyName}</td>
                  <td>{CONTRACT_STATUS_LABELS[c.status] ?? c.status}</td>
                  <td>{formatDateTime(c.reportedAt)}</td>
                  <td>{formatDateTime(c.completedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
