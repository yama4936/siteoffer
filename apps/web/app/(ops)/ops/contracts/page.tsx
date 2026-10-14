import { isTermsReadyForSales } from "@siteoffer/core";
import Link from "next/link";
import { Flash, Forbidden, Json, ReturnTo } from "@/components/ops/ui";
import { getDb } from "@/lib/db";
import {
  CONTRACT_STATUS_LABEL,
  fmtDate,
  label,
  PAYMENT_STATUS_LABEL,
  REWARD_STATUS_LABEL,
  rewardRuleText,
  yen,
} from "@/lib/ops/format";
import { listContractsOverview, listProductTerms } from "@/lib/ops/queries";
import { termsIssueText } from "@/lib/ops/sellable";
import { getCurrentActor } from "@/lib/session";
import {
  adjustRewardAction,
  cancelRewardAction,
  confirmContractAction,
  createProductTermsAction,
  markRewardPaidAction,
  recordPaymentAction,
  rejectContractAction,
  scheduleRewardAction,
  setProductTermsActiveAction,
  startContractReviewAction,
  updatePaymentStatusAction,
} from "../actions";

const here = "/ops/contracts";

export default async function ContractsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const db = getDb();
  const actor = await getCurrentActor();
  const [terms, list] = await Promise.all([listProductTerms(db, actor), listContractsOverview(db, actor)]);
  if (!terms.ok || !list.ok) return <Forbidden />;

  return (
    <main>
      <h1>4. 商品条件・契約確認・入金・報酬</h1>
      <Flash searchParams={await searchParams} />

      <section>
        <h2>販売条件・報酬条件の版</h2>
        <p className="muted">
          販売価格・報酬額は未決です。既存の版は書き換えず、新しい版を作ります。完了した契約は完了時の写しで固定され、後の変更の影響を受けません（AC-16）。
          価格・報酬条件が未設定の版は保存できますが、その版では営業可能にできません。
        </p>
        <table>
          <thead>
            <tr>
              <th>版</th>
              <th>名称</th>
              <th>範囲</th>
              <th>販売価格</th>
              <th>月額</th>
              <th>報酬条件</th>
              <th>営業に使えるか</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {terms.value.map((t) => (
              <tr key={t.id}>
                <td>{t.version}</td>
                <td>{t.name}</td>
                <td>
                  <Json value={t.scope} />
                </td>
                <td>{yen(t.price)}</td>
                <td>{t.monthlyFee === null ? "—" : yen(t.monthlyFee)}</td>
                <td>{rewardRuleText(t.rewardRule)}</td>
                <td className={isTermsReadyForSales(t) ? undefined : "warn"}>
                  {isTermsReadyForSales(t) ? "使える" : `使えない（${termsIssueText(t)}）`}
                </td>
                <td>
                  <form action={setProductTermsActiveAction} className="inline">
                    <ReturnTo path={here} />
                    <input type="hidden" name="productTermsId" value={t.id} />
                    <input type="hidden" name="active" value={t.active ? "false" : "true"} />
                    <button type="submit">{t.active ? "無効にする" : "有効にする"}</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <details>
          <summary>新しい版を作成する</summary>
          <form action={createProductTermsAction} className="stack">
            <ReturnTo path={here} />
            <label>
              版（一意。例：2026-10-a）
              <input name="version" required />
            </label>
            <label>
              名称
              <input name="name" required />
            </label>
            <label>
              提供範囲（ページ数・修正回数・納期など）
              <textarea name="scope" rows={3} />
            </label>
            <label>
              販売価格（円・空欄は未設定）
              <input name="price" inputMode="numeric" />
            </label>
            <label>
              月額（円・任意）
              <input name="monthlyFee" inputMode="numeric" />
            </label>
            <label>
              報酬条件の種類
              <select name="rewardType" defaultValue="">
                <option value="">未設定</option>
                <option value="fixed">定額（円）</option>
                <option value="rate">販売価格に対する割合（万分率。1000 = 10%）</option>
              </select>
            </label>
            <label>
              報酬条件の値
              <input name="rewardValue" inputMode="numeric" />
            </label>
            <button type="submit">版を作成</button>
          </form>
        </details>
      </section>

      <section>
        <h2>契約（成約報告）</h2>
        <p className="muted">
          営業ユーザーの成約報告だけでは報酬は発生しません。運営が契約資料を確認して契約完了にしたときに、報酬が1回だけ発生します。入金と報酬は別に記録します。
        </p>
        <table>
          <thead>
            <tr>
              <th>企業・営業</th>
              <th>状態</th>
              <th>報告・資料</th>
              <th>契約確認</th>
              <th>入金</th>
              <th>報酬</th>
            </tr>
          </thead>
          <tbody>
            {list.value.map(({ c, companyName, salesName, payments, reward }) => (
              <tr key={c.id}>
                <td>
                  <Link href={`/ops/companies/${c.companyId}`}>{companyName}</Link>
                  <div className="muted">営業：{salesName}</div>
                </td>
                <td>
                  {label(CONTRACT_STATUS_LABEL, c.status)}
                  {c.closeReason ? <div className="muted">{c.closeReason}</div> : null}
                </td>
                <td>
                  報告 {fmtDate(c.reportedAt)}
                  <div>資料：{c.documentRef ?? "未登録"}</div>
                  {c.reportNote ? <div className="muted">{c.reportNote}</div> : null}
                </td>
                <td>
                  {c.status === "completed" ? (
                    <>
                      完了 {fmtDate(c.completedAt)}
                      <details>
                        <summary>契約時点の写し</summary>
                        <Json value={c.snapshot} />
                      </details>
                    </>
                  ) : null}
                  {c.status === "reported" ? (
                    <form action={startContractReviewAction} className="inline">
                      <ReturnTo path={here} />
                      <input type="hidden" name="contractId" value={c.id} />
                      <button type="submit">確認を開始</button>
                    </form>
                  ) : null}
                  {c.status === "reported" || c.status === "under_review" ? (
                    <>
                      <form action={confirmContractAction} className="stack">
                        <ReturnTo path={here} />
                        <input type="hidden" name="contractId" value={c.id} />
                        <select name="productTermsId" defaultValue={c.productTermsId ?? ""}>
                          <option value="">条件の版（報告時の版を使う）</option>
                          {terms.value
                            .filter((t) => isTermsReadyForSales(t))
                            .map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.version}：{yen(t.price)} / {rewardRuleText(t.rewardRule)}
                              </option>
                            ))}
                        </select>
                        <input
                          name="documentRef"
                          placeholder="契約資料の参照（未登録なら必須）"
                          defaultValue={c.documentRef ?? ""}
                        />
                        <button type="submit">契約完了を確認</button>
                      </form>
                      <form action={rejectContractAction} className="inline">
                        <ReturnTo path={here} />
                        <input type="hidden" name="contractId" value={c.id} />
                        <input name="reason" placeholder="差し戻しの理由（必須）" required />
                        <button type="submit">差し戻し</button>
                      </form>
                    </>
                  ) : null}
                </td>
                <td>
                  {payments.map((p) => (
                    <div key={p.id}>
                      {yen(p.amount)}：{label(PAYMENT_STATUS_LABEL, p.status)}
                      {p.receivedAt ? `（${fmtDate(p.receivedAt)}）` : ""}
                      {p.status === "pending" ? (
                        <>
                          <PaymentButton paymentId={p.id} status="received" text="入金済みにする" />
                          <PaymentButton paymentId={p.id} status="cancelled" text="取消" />
                        </>
                      ) : null}
                      {p.status === "received" ? (
                        <PaymentButton paymentId={p.id} status="refunded" text="返金にする" />
                      ) : null}
                    </div>
                  ))}
                  {c.status === "completed" ? (
                    <form action={recordPaymentAction} className="inline">
                      <ReturnTo path={here} />
                      <input type="hidden" name="contractId" value={c.id} />
                      <input name="amount" inputMode="numeric" placeholder="金額（円）" required size={10} />
                      <label>
                        <input type="checkbox" name="received" /> 入金済み
                      </label>
                      <input name="note" placeholder="メモ" size={10} />
                      <button type="submit">入金を記録</button>
                    </form>
                  ) : null}
                </td>
                <td>
                  {reward ? (
                    <>
                      <div>
                        {label(REWARD_STATUS_LABEL, reward.reward.status)}：現在額 {yen(reward.currentAmount)}
                        <span className="muted">（発生時 {yen(reward.reward.amount)}）</span>
                      </div>
                      {reward.reward.scheduledFor ? <div>支払予定 {fmtDate(reward.reward.scheduledFor)}</div> : null}
                      {reward.reward.paidAt ? <div>支払済み {fmtDate(reward.reward.paidAt)}</div> : null}
                      {reward.adjustments.map((adj) => (
                        <div key={adj.id} className="muted">
                          調整 {adj.delta > 0 ? "+" : ""}
                          {adj.delta.toLocaleString("ja-JP")}円：{adj.reason}（{fmtDate(adj.createdAt)}）
                        </div>
                      ))}
                      {reward.reward.status === "accrued" || reward.reward.status === "scheduled" ? (
                        <form action={scheduleRewardAction} className="inline">
                          <ReturnTo path={here} />
                          <input type="hidden" name="rewardId" value={reward.reward.id} />
                          <input type="date" name="scheduledFor" required aria-label="支払予定日" />
                          <button type="submit">支払予定を設定</button>
                        </form>
                      ) : null}
                      {reward.reward.status === "scheduled" ? (
                        <form action={markRewardPaidAction} className="inline">
                          <ReturnTo path={here} />
                          <input type="hidden" name="rewardId" value={reward.reward.id} />
                          <button type="submit">支払済みにする</button>
                        </form>
                      ) : null}
                      {reward.reward.status !== "cancelled" ? (
                        <form action={adjustRewardAction} className="inline">
                          <ReturnTo path={here} />
                          <input type="hidden" name="rewardId" value={reward.reward.id} />
                          <input name="delta" inputMode="numeric" placeholder="増減（円）" required size={8} />
                          <input name="reason" placeholder="理由（必須）" required size={10} />
                          <button type="submit">調整</button>
                        </form>
                      ) : null}
                      {reward.reward.status === "accrued" || reward.reward.status === "scheduled" ? (
                        <form action={cancelRewardAction} className="inline">
                          <ReturnTo path={here} />
                          <input type="hidden" name="rewardId" value={reward.reward.id} />
                          <input name="reason" placeholder="取消の理由（必須）" required size={10} />
                          <button type="submit">取消</button>
                        </form>
                      ) : null}
                    </>
                  ) : (
                    <span className="muted">未発生</span>
                  )}
                </td>
              </tr>
            ))}
            {list.value.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  契約はまだありません
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </main>
  );
}

function PaymentButton({ paymentId, status, text }: { paymentId: string; status: string; text: string }) {
  return (
    <form action={updatePaymentStatusAction} className="inline">
      <ReturnTo path={here} />
      <input type="hidden" name="paymentId" value={paymentId} />
      <input type="hidden" name="status" value={status} />
      <button type="submit">{text}</button>
    </form>
  );
}
