import { AccountSecurityError, listPasswordRecoveries, systemClock } from "@siteoffer/core";
import { cookies } from "next/headers";
import Link from "next/link";
import { Flash, Forbidden, ReturnTo } from "@/components/ops/ui";
import { inlineFormClass } from "@/components/ops/ui-parts-1";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { EmptyState, PageHeader, Section } from "@/components/ui/page";
import { NativeSelect } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { ACCOUNT_ROLE, ACCOUNT_STATUS, accountsHref, parseAccountsQuery, userFilterOf } from "@/lib/ops/accounts-query";
import { fmtDate } from "@/lib/ops/format";
import { listUsersForOps } from "@/lib/ops/queries";
import { getCurrentActor, requireUser, SESSION_COOKIE } from "@/lib/session";
import { reactivateUserAction, suspendUserAction } from "../actions";
import { RecoveryManager } from "./recovery-manager";

/**
 * アカウント管理。ユーザーの一覧・利用停止／解除と、パスワード再設定の発行・取消を1画面で行う。
 * 招待・役割変更・運営アカウントの作成はここでは扱わない（2026-10-28 のユーザー決定）。
 */
export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser("ops");
  const sp = await searchParams;
  const query = parseAccountsQuery(sp);
  const db = getDb();
  const actor = await getCurrentActor();
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  const users = await listUsersForOps(db, actor, userFilterOf(query));
  if (!users.ok) return <Forbidden />;
  let recoveries: Awaited<ReturnType<typeof listPasswordRecoveries>>;
  try {
    recoveries = await listPasswordRecoveries(db, systemClock, token, { page: query.page, history: query.history });
  } catch (error) {
    if (error instanceof AccountSecurityError) return <Forbidden />;
    throw error;
  }
  const here = accountsHref(query);
  const userFilter = { role: query.role, status: query.status };
  const filtered = query.role !== "all" || query.status !== "all";

  return (
    <>
      <PageHeader
        title="アカウント管理"
        description="営業・顧客の利用停止と解除、ログインの復旧（パスワード再設定の案内）をまとめて行います。"
      />
      <Flash searchParams={sp} />

      <Section
        id="users"
        title="ユーザー"
        description="利用停止にすると、ログインと既存のセッションでの操作ができなくなります。運営アカウントは対象外です。"
      >
        <form
          method="get"
          action="/ops/accounts"
          key={here}
          className="mb-4 grid grid-cols-2 items-end gap-3 rounded-xl border bg-card p-4 sm:flex sm:flex-wrap"
          aria-label="ユーザーの絞り込み"
        >
          {query.history ? <input type="hidden" name="history" value="1" /> : null}
          <Field htmlFor="accounts-role" label="役割" className="min-w-0 sm:flex-1">
            <NativeSelect id="accounts-role" name="role" defaultValue={query.role}>
              {Object.entries(ACCOUNT_ROLE).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field htmlFor="accounts-status" label="状態" className="min-w-0 sm:flex-1">
            <NativeSelect id="accounts-status" name="status" defaultValue={query.status}>
              {Object.entries(ACCOUNT_STATUS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <button type="submit" className={`${buttonVariants({ size: "sm" })} justify-self-start`}>
            絞り込む
          </button>
          {filtered ? (
            <Link href={accountsHref({ history: query.history })} className="text-primary text-sm underline">
              すべて表示
            </Link>
          ) : null}
        </form>
        <p className="mb-2 text-muted-foreground text-sm">{users.value.length}件</p>
        {users.value.length === 0 ? (
          <EmptyState>条件に合うユーザーはいません。</EmptyState>
        ) : (
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
                    <Badge variant={u.role === "ops" ? "info" : "outline"}>{ACCOUNT_ROLE[u.role]}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={u.status === "suspended" ? "destructive" : "success"}>
                      {ACCOUNT_STATUS[u.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="tabular-nums">{u.activeAssignments}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums">{fmtDate(u.createdAt)}</TableCell>
                  <TableCell className="min-w-64">
                    {u.role !== "ops" ? (
                      <form
                        action={u.status === "active" ? suspendUserAction : reactivateUserAction}
                        className={inlineFormClass}
                      >
                        <ReturnTo path={here} />
                        <input type="hidden" name="userId" value={u.id} />
                        <Input
                          name="reason"
                          placeholder="理由"
                          aria-label={`${u.displayName} の理由`}
                          className="h-8 w-auto flex-1 basis-32"
                        />
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
        )}
      </Section>

      <Section
        id="recovery"
        title="ログインの復旧"
        description="本人確認の後、営業・顧客のパスワード再設定をご案内します。"
      >
        <div className="mb-6 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-7">
          <strong>申請は本人確認前です。</strong>{" "}
          登録済みの連絡先や対面で本人を確認し、確認した本人だけに案内を渡してください。申請時に指定された新しい連絡先へ送らないでください。発行だけではパスワード・ログインは変わりません。
        </div>
        <div className="mb-5 flex gap-3 text-sm">
          <Link
            href={accountsHref({ ...userFilter, history: false }, "recovery")}
            aria-current={!query.history ? "page" : undefined}
            className={
              !query.history ? "rounded-lg bg-blue-600 px-4 py-2 text-white" : "rounded-lg border bg-white px-4 py-2"
            }
          >
            未完了
          </Link>
          <Link
            href={accountsHref({ ...userFilter, history: true }, "recovery")}
            aria-current={query.history ? "page" : undefined}
            className={
              query.history ? "rounded-lg bg-blue-600 px-4 py-2 text-white" : "rounded-lg border bg-white px-4 py-2"
            }
          >
            対応済み
          </Link>
        </div>
        <RecoveryManager
          key={`${query.history}:${query.page}`}
          initial={recoveries}
          history={query.history}
          userFilter={userFilter}
        />
        <p className="mt-6 text-xs leading-6 text-slate-500">
          案内は30分間有効です。再発行すると以前の案内は使えなくなります。メールの自動送信はありません。運営アカウントの復旧は対象外です。
        </p>
      </Section>
    </>
  );
}
