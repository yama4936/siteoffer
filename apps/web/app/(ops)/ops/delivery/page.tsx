import {
  DELIVERY_STATUSES,
  type DeliveryDetail,
  EXISTING_DOMAIN_REVIEW_NOTICE,
  NEW_DOMAIN_AVAILABILITY_NOTICE,
} from "@siteoffer/core";
import Link from "next/link";
import { CustomerReviewForm } from "@/components/ops/customer-review-form";
import { Flash, Forbidden, ReturnTo } from "@/components/ops/ui";
import { getDb } from "@/lib/db";
import { listContractsAwaitingDelivery, listDeliveryDetails } from "@/lib/ops/delivery";
import {
  DELIVERY_STATUS_LABEL,
  DOMAIN_INTENT_LABEL,
  DOMAIN_MANAGER_LABEL,
  fmtDate,
  label,
  TRI_LABEL,
} from "@/lib/ops/format";
import { listDomainPreferencesForOps } from "@/lib/ops/queries";
import { getCurrentActor } from "@/lib/session";
import {
  confirmDomainPreferenceAction,
  createDeliveryAction,
  recordPublicationAction,
  sendToCustomerReviewAction,
  transitionDeliveryAction,
} from "../actions";

export default async function DeliveryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const db = getDb();
  const actor = await getCurrentActor();
  const [prefs, awaiting, details] = await Promise.all([
    listDomainPreferencesForOps(db, actor),
    listContractsAwaitingDelivery(db, actor),
    listDeliveryDetails(db, actor),
  ]);
  if (!prefs.ok || !awaiting.ok || !details.ok) return <Forbidden />;
  const here = "/ops/delivery";

  return (
    <main>
      <h1>5. 制作・顧客確認・ドメイン希望</h1>
      <Flash searchParams={await searchParams} />

      <section>
        <h2>契約完了で納品がまだない契約</h2>
        <p className="muted">
          契約確認が完了（契約完了）した契約ごとに納品を1件作ります。作成すると「情報確認」から始まります。
        </p>
        <table>
          <thead>
            <tr>
              <th>企業</th>
              <th>営業</th>
              <th>契約完了</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {awaiting.value.map((c) => (
              <tr key={c.contractId}>
                <td>
                  <Link href={`/ops/companies/${c.companyId}`}>{c.companyName}</Link>
                </td>
                <td>{c.salesName}</td>
                <td>{fmtDate(c.completedAt)}</td>
                <td>
                  <form action={createDeliveryAction} className="inline">
                    <ReturnTo path={here} />
                    <input type="hidden" name="contractId" value={c.contractId} />
                    <button type="submit">納品を作成する</button>
                  </form>
                </td>
              </tr>
            ))}
            {awaiting.value.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  納品を作成できる契約はありません（契約の確認は「4. 商品条件・契約・入金・報酬」で行います）
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section>
        <h2>制作・顧客確認・公開の記録・納品</h2>
        <p className="muted">
          流れ：{DELIVERY_STATUSES.map((st) => label(DELIVERY_STATUS_LABEL, st)).join(" → ")}。
          制作版はワーカーが作ります。状態はこの画面を<a href={here}>再読み込み</a>すると最新になります。
        </p>
        {details.value.length === 0 ? <p className="muted">納品はまだありません</p> : null}
        {details.value.map((d) => (
          <DeliveryCard key={d.delivery.id} d={d} here={here} />
        ))}
      </section>

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
    </main>
  );
}

const DECISION_LABEL: Record<string, string> = { approved: "承認", changes_requested: "修正依頼" };

/** 状態を変えるだけのボタン（制作へ・運営確認へ・納品済みへ） */
function StepButton({
  deliveryId,
  to,
  here,
  children,
}: {
  deliveryId: string;
  to: "building" | "ops_review" | "delivered";
  here: string;
  children: string;
}) {
  return (
    <form action={transitionDeliveryAction} className="inline">
      <ReturnTo path={here} />
      <input type="hidden" name="deliveryId" value={deliveryId} />
      <input type="hidden" name="to" value={to} />
      <button type="submit">{children}</button>
    </form>
  );
}

function DeliveryCard({ d, here }: { d: DeliveryDetail; here: string }) {
  const { delivery } = d;
  const status = delivery.status;
  const versionLabel = new Map(d.versions.map((v) => [v.id, `第${v.version}版`]));
  const reviewVersion = d.versions.find((v) => v.id === delivery.reviewVersionId);
  const reviewOptions =
    status === "customer_review"
      ? reviewVersion
        ? [{ id: reviewVersion.id, label: `第${reviewVersion.version}版（顧客確認中）` }]
        : []
      : d.versions.filter((v) => v.artifactDir).map((v) => ({ id: v.id, label: `第${v.version}版` }));
  const locked = delivery.lockedVersionId ? (versionLabel.get(delivery.lockedVersionId) ?? "固定済み") : "未固定";

  return (
    <details open={status !== "delivered"} style={{ border: "1px solid #ddd", padding: "6px 10px", margin: "8px 0" }}>
      <summary>
        <strong>{d.companyName}</strong> 状態：<strong>{label(DELIVERY_STATUS_LABEL, status)}</strong>{" "}
        <span className="muted">
          版 {d.versions.length} 件・公開対象版 {locked}・更新 {fmtDate(delivery.updatedAt)}
        </span>
      </summary>

      <div>
        {status === "info_gathering" ? (
          <>
            <p className="muted">
              制作に進めると、ワーカーが制作版を作ります（制作中で版のない納品を拾って処理します。数秒〜）。
            </p>
            <StepButton deliveryId={delivery.id} to="building" here={here}>
              制作に進める
            </StepButton>
          </>
        ) : null}
        {status === "building" ? (
          d.versions.length === 0 ? (
            <p className="warn">
              ワーカーが制作版を作っています（数秒〜）。<a href={here}>再読み込み</a>すると版が表示されます。
            </p>
          ) : (
            <>
              <p className="muted">
                制作版があります。内容を確認するため運営確認に回してください。
                差し戻し後に新しい版が要る場合、ワーカーが新しい版を作るかはワーカーの処理条件によります。
              </p>
              <StepButton deliveryId={delivery.id} to="ops_review" here={here}>
                運営確認に回す
              </StepButton>
            </>
          )
        ) : null}
        {status === "ops_review" || status === "customer_review" ? (
          <>
            <p className="muted">
              {status === "ops_review"
                ? "運営が確認した版を顧客確認に回すと、顧客に渡すURL（期限付きの共有リンク）をこの場で一度だけ表示します。"
                : "顧客の判断（承認・修正依頼）を待っています。リンクを控え忘れた・期限が切れた場合は再発行できます。"}
            </p>
            <CustomerReviewForm
              action={sendToCustomerReviewAction}
              deliveryId={delivery.id}
              versions={reviewOptions}
              reissue={status === "customer_review"}
            />
            <StepButton deliveryId={delivery.id} to="building" here={here}>
              {status === "ops_review" ? "制作に差し戻す" : "顧客確認を取り下げて制作に戻す"}
            </StepButton>
          </>
        ) : null}
        {status === "ready" ? (
          <>
            <p className="muted">
              顧客が承認した版（{locked}
              ）を公開対象として固定しました。公開は記録だけを残します。AWSへの公開・DNS変更・稼働確認は行いません（現時点の範囲外）。
            </p>
            <form action={recordPublicationAction} className="inline">
              <ReturnTo path={here} />
              <input type="hidden" name="deliveryId" value={delivery.id} />
              <label>
                環境
                <input name="environment" defaultValue="production" size={12} required />
              </label>
              <label>
                公開URL（任意）
                <input name="url" type="url" size={30} placeholder="https://" />
              </label>
              <button type="submit">公開を記録する</button>
            </form>
          </>
        ) : null}
        {status === "published" ? (
          <StepButton deliveryId={delivery.id} to="delivered" here={here}>
            納品済みにする
          </StepButton>
        ) : null}
        {status === "delivered" ? <p className="muted">納品済みです。</p> : null}
      </div>

      <h3>制作版</h3>
      <table>
        <thead>
          <tr>
            <th>版</th>
            <th>成果物</th>
            <th>作成</th>
            <th>扱い</th>
          </tr>
        </thead>
        <tbody>
          {d.versions.map((v) => (
            <tr key={v.id}>
              <td>第{v.version}版</td>
              <td>{v.artifactDir ? <code>{v.artifactDir}</code> : <span className="warn">成果物なし</span>}</td>
              <td>{fmtDate(v.createdAt)}</td>
              <td>
                {v.id === delivery.lockedVersionId ? "公開対象（固定）" : null}
                {v.id === delivery.reviewVersionId ? "顧客確認中" : null}
              </td>
            </tr>
          ))}
          {d.versions.length === 0 ? (
            <tr>
              <td colSpan={4} className="muted">
                版はまだありません
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <h3>顧客の判断</h3>
      <table>
        <thead>
          <tr>
            <th>日時</th>
            <th>版</th>
            <th>判断</th>
            <th>コメント</th>
          </tr>
        </thead>
        <tbody>
          {d.approvals.map((a) => (
            <tr key={a.id}>
              <td>{fmtDate(a.decidedAt)}</td>
              <td>{versionLabel.get(a.deliveryVersionId) ?? "—"}</td>
              <td>{label(DECISION_LABEL, a.decision)}</td>
              <td style={{ whiteSpace: "pre-wrap" }}>{a.comment ?? "—"}</td>
            </tr>
          ))}
          {d.approvals.length === 0 ? (
            <tr>
              <td colSpan={4} className="muted">
                顧客の判断はまだありません
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <h3>公開の記録</h3>
      {d.deployments.length === 0 ? (
        <p className="muted">記録はありません</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>日時</th>
              <th>環境</th>
              <th>URL</th>
              <th>版</th>
              <th>状態</th>
            </tr>
          </thead>
          <tbody>
            {d.deployments.map((x) => (
              <tr key={x.id}>
                <td>{fmtDate(x.createdAt)}</td>
                <td>{x.environment}</td>
                <td>{x.url ?? "—"}</td>
                <td>{versionLabel.get(x.deliveryVersionId) ?? "—"}</td>
                <td>{x.status === "recorded" ? "記録のみ（実公開なし）" : x.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}
