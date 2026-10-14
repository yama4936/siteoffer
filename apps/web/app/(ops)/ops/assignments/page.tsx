import Link from "next/link";
import { Flash, Forbidden, first, ReturnTo } from "@/components/ops/ui";
import { getDb } from "@/lib/db";
import { ACTIVITY_LABEL, ASSIGNMENT_STATUS_LABEL, fmtDate, label, SUPPRESSION_LABEL } from "@/lib/ops/format";
import {
  listActiveSalesUsers,
  listAssignmentsOverview,
  listConsultations,
  listSuppressedCompanies,
} from "@/lib/ops/queries";
import { getCurrentActor } from "@/lib/session";
import {
  extendAssignmentAction,
  liftSuppressionAction,
  reassignAssignmentAction,
  releaseAssignmentAction,
} from "../actions";

export default async function AssignmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const includeClosed = first(sp, "all") === "1";
  const db = getDb();
  const actor = await getCurrentActor();
  const [list, salesUsers, suppressed, consultations] = await Promise.all([
    listAssignmentsOverview(db, actor, { includeClosed }),
    listActiveSalesUsers(db, actor),
    listSuppressedCompanies(db, actor),
    listConsultations(db, actor),
  ]);
  if (!list.ok || !salesUsers.ok || !suppressed.ok || !consultations.ok) return <Forbidden />;
  const here = includeClosed ? "/ops/assignments?all=1" : "/ops/assignments";
  // 運営確認待ちを先頭に
  const rows = [...list.value].sort(
    (x, y) => Number(y.a.status === "awaiting_ops") - Number(x.a.status === "awaiting_ops"),
  );

  return (
    <main>
      <h1>3. 担当状況・営業拒否・引き継ぎ</h1>
      <Flash searchParams={sp} />

      <section>
        <h2>担当の一覧{includeClosed ? "（終了を含む）" : "（有効な担当）"}</h2>
        <p>
          {includeClosed ? (
            <Link href="/ops/assignments">有効な担当だけ表示</Link>
          ) : (
            <Link href="/ops/assignments?all=1">終了した担当も表示</Link>
          )}
        </p>
        <p className="muted">
          運営確認待ち（商談中の期限超過など）は即座に別の営業ユーザーへ渡さず、延長・付け替え・解除を運営が判断します（12.2）。
        </p>
        <table>
          <thead>
            <tr>
              <th>企業</th>
              <th>営業ユーザー</th>
              <th>状態</th>
              <th>確保・期限・次回対応</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ a, companyName, suppression, userName, userStatus }) => {
              const active = !["completed", "released", "lost"].includes(a.status);
              return (
                <tr key={a.id}>
                  <td>
                    <Link href={`/ops/companies/${a.companyId}`}>{companyName}</Link>
                    {suppression !== "none" ? (
                      <div className="warn">抑止：{label(SUPPRESSION_LABEL, suppression)}</div>
                    ) : null}
                  </td>
                  <td>
                    {userName}
                    {userStatus === "suspended" ? <span className="warn">（利用停止中）</span> : null}
                  </td>
                  <td className={a.status === "awaiting_ops" ? "warn" : undefined}>
                    {label(ASSIGNMENT_STATUS_LABEL, a.status)}
                    {a.releaseReason ? <div className="muted">{a.releaseReason}</div> : null}
                  </td>
                  <td>
                    確保 {fmtDate(a.claimedAt)}
                    <br />
                    期限 {fmtDate(a.expiresAt)}
                    <br />
                    次回 {fmtDate(a.nextActionAt)}
                  </td>
                  <td>
                    {active ? (
                      <>
                        <form action={extendAssignmentAction} className="inline">
                          <ReturnTo path={here} />
                          <input type="hidden" name="assignmentId" value={a.id} />
                          <input type="datetime-local" name="expiresAt" required aria-label="新しい期限（日本時間）" />
                          <select name="resumeStatus" defaultValue="">
                            <option value="">
                              {a.status === "awaiting_ops" ? "状態：商談中に戻す（既定）" : "状態：変えない"}
                            </option>
                            <option value="claimed">確保（未着手）</option>
                            <option value="working">営業中</option>
                            <option value="negotiating">商談中</option>
                          </select>
                          <input name="reason" placeholder="理由（任意）" />
                          <button type="submit">延長</button>
                        </form>
                        <form action={reassignAssignmentAction} className="inline">
                          <ReturnTo path={here} />
                          <input type="hidden" name="assignmentId" value={a.id} />
                          <select name="toUserId" required defaultValue="">
                            <option value="" disabled>
                              付け替え先
                            </option>
                            {salesUsers.value
                              .filter((u) => u.id !== a.userId)
                              .map((u) => (
                                <option key={u.id} value={u.id}>
                                  {u.displayName}
                                </option>
                              ))}
                          </select>
                          <input name="reason" placeholder="理由（必須）" required />
                          <button type="submit">付け替え</button>
                        </form>
                        <form action={releaseAssignmentAction} className="inline">
                          <ReturnTo path={here} />
                          <input type="hidden" name="assignmentId" value={a.id} />
                          <input name="reason" placeholder="解除の理由（必須）" required />
                          <button type="submit">解除</button>
                        </form>
                      </>
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  担当はありません
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section>
        <h2>運営への相談（{consultations.value.length}件）</h2>
        <p className="muted">対応済みの管理は未実装です（core・スキーマに列がありません）。</p>
        <table>
          <thead>
            <tr>
              <th>日時</th>
              <th>企業</th>
              <th>営業ユーザー</th>
              <th>活動</th>
              <th>メモ</th>
              <th>次回対応</th>
            </tr>
          </thead>
          <tbody>
            {consultations.value.map(({ activity, companyName, userName }) => (
              <tr key={activity.id}>
                <td>{fmtDate(activity.occurredAt)}</td>
                <td>
                  <Link href={`/ops/companies/${activity.companyId}`}>{companyName}</Link>
                </td>
                <td>{userName}</td>
                <td>{label(ACTIVITY_LABEL, activity.kind)}</td>
                <td>{activity.note ?? "—"}</td>
                <td>{fmtDate(activity.nextActionAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>営業抑止のある企業（{suppressed.value.length}件）</h2>
        <p className="muted">
          抑止は企業共通で、担当解除や再収集では消えません。「今は不要」の再連絡目安を過ぎても自動では解除しません。
        </p>
        <table>
          <thead>
            <tr>
              <th>企業</th>
              <th>抑止</th>
              <th>理由</th>
              <th>再連絡の目安</th>
              <th>記録日時</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {suppressed.value.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link href={`/ops/companies/${c.id}`}>{c.name}</Link>
                </td>
                <td>{label(SUPPRESSION_LABEL, c.suppression)}</td>
                <td>{c.suppressionReason ?? "—"}</td>
                <td>{fmtDate(c.recontactAfter)}</td>
                <td>{fmtDate(c.suppressionUpdatedAt)}</td>
                <td>
                  <form action={liftSuppressionAction} className="inline">
                    <ReturnTo path={here} />
                    <input type="hidden" name="companyId" value={c.id} />
                    <input name="reason" placeholder="解除の理由（必須）" required />
                    <button type="submit">抑止を解除</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
