import { Filter } from "lucide-react";
import { Flash, Forbidden, first, Json, ReturnTo } from "@/components/ops/ui";
import { inlineFormClass } from "@/components/ops/ui-parts-1";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader, Section } from "@/components/ui/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
    <>
      <PageHeader title="6. 設定・操作履歴" />
      <Flash searchParams={sp} />

      <Section
        title="運営設定"
        description="既定値は推奨案（同時担当3社・未着手72時間など）です。変更は操作履歴に残ります。変更は以後の確保・期限計算に使われ、既存の担当の期限は変えません。"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>設定</TableHead>
              <TableHead>現在値</TableHead>
              <TableHead>既定値</TableHead>
              <TableHead>最終変更</TableHead>
              <TableHead>変更</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {settings.value.map((s) => (
              <TableRow key={s.key}>
                <TableCell className="min-w-48">
                  <div className="font-medium">{s.label}</div>
                  <div className="text-muted-foreground text-xs">
                    <code>{s.key}</code>
                  </div>
                </TableCell>
                <TableCell className="font-semibold tabular-nums">{s.value}</TableCell>
                <TableCell className="text-muted-foreground tabular-nums">{s.defaultValue}</TableCell>
                <TableCell className="whitespace-nowrap text-xs tabular-nums">{fmtDate(s.updatedAt)}</TableCell>
                <TableCell>
                  <form action={updateSettingAction} className={inlineFormClass}>
                    <ReturnTo path={here} />
                    <input type="hidden" name="key" value={s.key} />
                    <Input
                      name="value"
                      type="number"
                      min={s.min}
                      max={s.max}
                      defaultValue={s.value}
                      required
                      aria-label={s.label}
                      className="h-8 w-28 tabular-nums"
                    />
                    <Button type="submit" size="xs">
                      変更
                    </Button>
                  </form>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section
        title="ユーザー"
        description="利用停止にすると、ログインと既存のセッションでの操作ができなくなります。運営アカウントは対象外です。"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>表示名</TableHead>
              <TableHead>メール</TableHead>
              <TableHead>役割</TableHead>
              <TableHead>状態</TableHead>
              <TableHead>有効な担当</TableHead>
              <TableHead>登録</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.value.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">{u.displayName}</TableCell>
                <TableCell className="break-all">{u.email}</TableCell>
                <TableCell>
                  <Badge variant={u.role === "ops" ? "info" : "outline"}>{u.role === "ops" ? "運営" : "営業"}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={u.status === "suspended" ? "destructive" : "success"}>
                    {u.status === "suspended" ? "利用停止" : "利用中"}
                  </Badge>
                </TableCell>
                <TableCell className="tabular-nums">{u.activeAssignments}</TableCell>
                <TableCell className="whitespace-nowrap text-xs tabular-nums">{fmtDate(u.createdAt)}</TableCell>
                <TableCell className="min-w-64">
                  {u.role === "sales" ? (
                    <form
                      action={u.status === "active" ? suspendUserAction : reactivateUserAction}
                      className={inlineFormClass}
                    >
                      <ReturnTo path={here} />
                      <input type="hidden" name="userId" value={u.id} />
                      <Input name="reason" placeholder="理由" className="h-8 w-auto flex-1 basis-32" />
                      <Button type="submit" variant={u.status === "active" ? "destructive" : "outline"} size="xs">
                        {u.status === "active" ? "利用停止" : "利用停止を解除"}
                      </Button>
                    </form>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section title="操作履歴（最新200件）">
        <form className={inlineFormClass} method="get" action={here}>
          <Input
            name="targetType"
            placeholder="対象の種類（例：settings, company）"
            defaultValue={filter.targetType ?? ""}
            aria-label="対象の種類"
            className="w-full sm:w-72"
          />
          <Input
            name="action"
            placeholder="操作の前方一致（例：assignment.）"
            defaultValue={filter.actionPrefix ?? ""}
            aria-label="操作の前方一致"
            className="w-full sm:w-72"
          />
          <Button type="submit" variant="secondary">
            <Filter />
            絞り込み
          </Button>
        </form>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>日時</TableHead>
              <TableHead>主体</TableHead>
              <TableHead>操作</TableHead>
              <TableHead>対象</TableHead>
              <TableHead>変更前</TableHead>
              <TableHead>変更後</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.value.map(({ e, actorName }) => (
              <TableRow key={e.id}>
                <TableCell className="whitespace-nowrap text-xs tabular-nums">{fmtDate(e.createdAt)}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {e.actorKind}
                  {actorName ? `：${actorName}` : ""}
                </TableCell>
                <TableCell>
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">{e.action}</code>
                </TableCell>
                <TableCell>
                  {e.targetType}
                  <div className="break-all font-mono text-muted-foreground text-xs">{e.targetId}</div>
                </TableCell>
                <TableCell className="min-w-56 max-w-96">
                  <Json value={e.before} />
                </TableCell>
                <TableCell className="min-w-56 max-w-96">
                  <Json value={e.after} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>
    </>
  );
}
