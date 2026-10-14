import { EXISTING_DOMAIN_REVIEW_NOTICE, NEW_DOMAIN_AVAILABILITY_NOTICE } from "@siteoffer/core";
import Link from "next/link";
import { Flash, Forbidden, ReturnTo } from "@/components/ops/ui";
import { getDb } from "@/lib/db";
import {
  CONTRACT_STATUS_LABEL,
  DELIVERY_STATUS_LABEL,
  DOMAIN_INTENT_LABEL,
  DOMAIN_MANAGER_LABEL,
  fmtDate,
  label,
  TRI_LABEL,
} from "@/lib/ops/format";
import { listDeliveriesForOps, listDomainPreferencesForOps } from "@/lib/ops/queries";
import { getCurrentActor } from "@/lib/session";
import { confirmDomainPreferenceAction } from "../actions";

export default async function DeliveryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const db = getDb();
  const actor = await getCurrentActor();
  const [prefs, deliveries] = await Promise.all([
    listDomainPreferencesForOps(db, actor),
    listDeliveriesForOps(db, actor),
  ]);
  if (!prefs.ok || !deliveries.ok) return <Forbidden />;
  const here = "/ops/delivery";

  return (
    <main>
      <h1>5. 制作・顧客確認・ドメイン希望</h1>
      <Flash searchParams={await searchParams} />

      <section>
        <h2>ドメイン希望（未確認を先に表示）</h2>
        <p className="muted">
          {EXISTING_DOMAIN_REVIEW_NOTICE}
          <br />
          {NEW_DOMAIN_AVAILABILITY_NOTICE}
          <br />
          実設定・移管・DNS変更はこの画面では行いません（AWSの実環境構築は範囲外）。
        </p>
        <table>
          <thead>
            <tr>
              <th>企業</th>
              <th>希望</th>
              <th>現在のURL・ドメイン</th>
              <th>新規候補</th>
              <th>管理者・メール</th>
              <th>企業の希望</th>
              <th>記録</th>
              <th>運営確認</th>
            </tr>
          </thead>
          <tbody>
            {prefs.value.map(({ d, companyName, recordedByName }) => (
              <tr key={d.id}>
                <td>
                  <Link href={`/ops/companies/${d.companyId}`}>{companyName}</Link>
                </td>
                <td>{label(DOMAIN_INTENT_LABEL, d.intent)}</td>
                <td>
                  {d.currentUrl ?? "—"}
                  <div>{d.currentDomain ?? ""}</div>
                </td>
                <td>{d.newDomainCandidates.length ? d.newDomainCandidates.join(", ") : "—"}</td>
                <td>
                  管理：{label(DOMAIN_MANAGER_LABEL, d.currentManager)}
                  <br />
                  メール：{label(TRI_LABEL, d.usesEmail)}
                </td>
                <td>{d.customerWish ?? "—"}</td>
                <td>
                  {recordedByName}
                  <div className="muted">{fmtDate(d.updatedAt)}</div>
                </td>
                <td>
                  {d.needsOpsReview ? <div className="warn">要確認</div> : null}
                  {d.confirmedAt ? (
                    <>確認済み {fmtDate(d.confirmedAt)}</>
                  ) : (
                    <form action={confirmDomainPreferenceAction} className="inline">
                      <ReturnTo path={here} />
                      <input type="hidden" name="id" value={d.id} />
                      <button type="submit">確認済みにする</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
            {prefs.value.length === 0 ? (
              <tr>
                <td colSpan={8} className="muted">
                  ドメイン希望の記録はありません
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section>
        <h2>制作・納品（一覧の入口）</h2>
        <p className="muted">納品の状態遷移・顧客確認・公開対象版の記録は別の画面（T14）で扱います。</p>
        <table>
          <thead>
            <tr>
              <th>企業</th>
              <th>契約</th>
              <th>納品の状態</th>
              <th>公開対象版</th>
              <th>作成</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.value.map(({ d, companyName, contractStatus }) => (
              <tr key={d.id}>
                <td>{companyName}</td>
                <td>{label(CONTRACT_STATUS_LABEL, contractStatus)}</td>
                <td>{label(DELIVERY_STATUS_LABEL, d.status)}</td>
                <td>{d.lockedVersionId ?? "未固定"}</td>
                <td>{fmtDate(d.createdAt)}</td>
              </tr>
            ))}
            {deliveries.value.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  納品はまだありません
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </main>
  );
}
