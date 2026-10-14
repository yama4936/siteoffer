import { Flash, Forbidden, first, Json, ReturnTo } from "@/components/ops/ui";
import { getDb } from "@/lib/db";
import { fmtDate } from "@/lib/ops/format";
import { getSettingsForOps, listAuditEventsForOps, listUsersForOps } from "@/lib/ops/queries";
import { getCurrentActor } from "@/lib/session";
import { reactivateUserAction, suspendUserAction, updateSettingAction } from "../actions";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const filter = {
    targetType: first(sp, "targetType") || undefined,
    actionPrefix: first(sp, "action") || undefined,
  };
  const db = getDb();
  const actor = await getCurrentActor();
  const [settings, users, events] = await Promise.all([
    getSettingsForOps(db, actor),
    listUsersForOps(db, actor),
    listAuditEventsForOps(db, actor, { ...filter, limit: 200 }),
  ]);
  if (!settings.ok || !users.ok || !events.ok) return <Forbidden />;
  const here = "/ops/settings";

  return (
    <main>
      <h1>6. 設定・操作履歴</h1>
      <Flash searchParams={sp} />

      <section>
        <h2>運営設定</h2>
        <p className="muted">
          既定値は推奨案（同時担当3社・未着手72時間など）です。変更は操作履歴に残ります。変更は以後の確保・期限計算に使われ、既存の担当の期限は変えません。
        </p>
        <table>
          <thead>
            <tr>
              <th>設定</th>
              <th>現在値</th>
              <th>既定値</th>
              <th>最終変更</th>
              <th>変更</th>
            </tr>
          </thead>
          <tbody>
            {settings.value.map((s) => (
              <tr key={s.key}>
                <td>
                  {s.label}
                  <div className="muted">
                    <code>{s.key}</code>
                  </div>
                </td>
                <td>{s.value}</td>
                <td>{s.defaultValue}</td>
                <td>{fmtDate(s.updatedAt)}</td>
                <td>
                  <form action={updateSettingAction} className="inline">
                    <ReturnTo path={here} />
                    <input type="hidden" name="key" value={s.key} />
                    <input name="value" type="number" min={s.min} max={s.max} defaultValue={s.value} required />
                    <button type="submit">変更</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>ユーザー</h2>
        <p className="muted">
          利用停止にすると、ログインと既存のセッションでの操作ができなくなります。運営アカウントは対象外です。
        </p>
        <table>
          <thead>
            <tr>
              <th>表示名</th>
              <th>メール</th>
              <th>役割</th>
              <th>状態</th>
              <th>有効な担当</th>
              <th>登録</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.value.map((u) => (
              <tr key={u.id}>
                <td>{u.displayName}</td>
                <td>{u.email}</td>
                <td>{u.role === "ops" ? "運営" : "営業"}</td>
                <td className={u.status === "suspended" ? "warn" : undefined}>
                  {u.status === "suspended" ? "利用停止" : "利用中"}
                </td>
                <td>{u.activeAssignments}</td>
                <td>{fmtDate(u.createdAt)}</td>
                <td>
                  {u.role === "sales" ? (
                    <form action={u.status === "active" ? suspendUserAction : reactivateUserAction} className="inline">
                      <ReturnTo path={here} />
                      <input type="hidden" name="userId" value={u.id} />
                      <input name="reason" placeholder="理由" />
                      <button type="submit">{u.status === "active" ? "利用停止" : "利用停止を解除"}</button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>操作履歴（最新200件）</h2>
        <form className="inline" method="get" action={here}>
          <input
            name="targetType"
            placeholder="対象の種類（例：settings, company）"
            defaultValue={filter.targetType ?? ""}
          />
          <input
            name="action"
            placeholder="操作の前方一致（例：assignment.）"
            defaultValue={filter.actionPrefix ?? ""}
          />
          <button type="submit">絞り込み</button>
        </form>
        <table>
          <thead>
            <tr>
              <th>日時</th>
              <th>主体</th>
              <th>操作</th>
              <th>対象</th>
              <th>変更前</th>
              <th>変更後</th>
            </tr>
          </thead>
          <tbody>
            {events.value.map(({ e, actorName }) => (
              <tr key={e.id}>
                <td>{fmtDate(e.createdAt)}</td>
                <td>
                  {e.actorKind}
                  {actorName ? `：${actorName}` : ""}
                </td>
                <td>{e.action}</td>
                <td>
                  {e.targetType}
                  <div className="muted">{e.targetId}</div>
                </td>
                <td>
                  <Json value={e.before} />
                </td>
                <td>
                  <Json value={e.after} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
