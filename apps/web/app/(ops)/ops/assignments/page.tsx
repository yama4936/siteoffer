import Link from "next/link";
import { notFound } from "next/navigation";
import { Flash, Forbidden, first, ReturnTo } from "@/components/ops/ui";
import { inlineFormClass, StatusBadge } from "@/components/ops/ui-parts-1";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader, Section } from "@/components/ui/page";
import { NativeSelect } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
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
  const focus = first(sp, "focus");
  if (focus && !isUuid(focus)) notFound();
  const includeClosed = first(sp, "all") === "1";
  const db = getDb();
  const actor = await getCurrentActor();
  const [list, salesUsers, suppressed, consultations] = await Promise.all([
    listAssignmentsOverview(db, actor, { includeClosed, id: focus }),
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
    <>
      <PageHeader title="担当・引き継ぎ" description="営業の担当状況と運営への相談を確認します。" />
      {focus && (
        <p className="mb-4 text-sm">
          今日の仕事から選んだ案件を表示中です。{" "}
          <Link href="/ops/assignments" className="text-primary underline">
            全件を表示
          </Link>
        </p>
      )}
      <Flash searchParams={sp} />

      <Section
        title={`担当の一覧${includeClosed ? "（終了を含む）" : "（有効な担当）"}`}
        description="運営確認待ち（商談中の期限超過など）は即座に別の営業ユーザーへ渡さず、延長・付け替え・解除を運営が判断します（12.2）。"
        actions={
          includeClosed ? (
            <Link href="/ops/assignments" className={buttonVariants({ variant: "outline", size: "sm" })}>
              有効な担当だけ表示
            </Link>
          ) : (
            <Link href="/ops/assignments?all=1" className={buttonVariants({ variant: "outline", size: "sm" })}>
              終了した担当も表示
            </Link>
          )
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>企業</TableHead>
              <TableHead>営業ユーザー</TableHead>
              <TableHead>状態</TableHead>
              <TableHead>確保・期限・次回対応</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ a, companyName, suppression, userName, userStatus }) => {
              const active = !["completed", "released", "lost"].includes(a.status);
              return (
                <TableRow
                  id={`assignment-${a.id}`}
                  key={a.id}
                  className={a.status === "awaiting_ops" ? "bg-warning/5" : undefined}
                >
                  <TableCell className="min-w-40">
                    <Link href={`/ops/companies/${a.companyId}`} className="font-medium">
                      {companyName}
                    </Link>
                    {suppression !== "none" ? (
                      <div className="mt-1">
                        <Badge variant="warning">抑止：{label(SUPPRESSION_LABEL, suppression)}</Badge>
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="min-w-28">
                    {userName}
                    {userStatus === "suspended" ? (
                      <Badge variant="destructive" className="ml-1">
                        （利用停止中）
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="min-w-32">
                    <StatusBadge value={a.status} labels={ASSIGNMENT_STATUS_LABEL} />
                    {a.releaseReason ? (
                      <div className="mt-1 text-muted-foreground text-xs">{a.releaseReason}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums">
                    確保 {fmtDate(a.claimedAt)}
                    <br />
                    期限 {fmtDate(a.expiresAt)}
                    <br />
                    次回 {fmtDate(a.nextActionAt)}
                  </TableCell>
                  <TableCell className="min-w-96">
                    {active ? (
                      <div className="grid gap-2">
                        <form action={extendAssignmentAction} className={inlineFormClass}>
                          <ReturnTo path={here} />
                          <input type="hidden" name="assignmentId" value={a.id} />
                          <Input
                            type="datetime-local"
                            name="expiresAt"
                            required
                            aria-label="新しい期限（日本時間）"
                            className="h-8 w-auto"
                          />
                          <NativeSelect name="resumeStatus" defaultValue="" className="h-8 w-auto">
                            <option value="">
                              {a.status === "awaiting_ops" ? "状態：商談中に戻す（既定）" : "状態：変えない"}
                            </option>
                            <option value="claimed">確保（未着手）</option>
                            <option value="working">営業中</option>
                            <option value="negotiating">商談中</option>
                          </NativeSelect>
                          <Input name="reason" placeholder="理由（任意）" className="h-8 w-auto flex-1 basis-32" />
                          <Button type="submit" size="xs">
                            延長
                          </Button>
                        </form>
                        <form action={reassignAssignmentAction} className={inlineFormClass}>
                          <ReturnTo path={here} />
                          <input type="hidden" name="assignmentId" value={a.id} />
                          <NativeSelect name="toUserId" required defaultValue="" className="h-8 w-auto">
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
                          </NativeSelect>
                          <Input
                            name="reason"
                            placeholder="理由（必須）"
                            required
                            className="h-8 w-auto flex-1 basis-32"
                          />
                          <Button type="submit" variant="secondary" size="xs">
                            付け替え
                          </Button>
                        </form>
                        <form action={releaseAssignmentAction} className={inlineFormClass}>
                          <ReturnTo path={here} />
                          <input type="hidden" name="assignmentId" value={a.id} />
                          <Input
                            name="reason"
                            placeholder="解除の理由（必須）"
                            required
                            className="h-8 w-auto flex-1 basis-32"
                          />
                          <Button type="submit" variant="destructive" size="xs">
                            解除
                          </Button>
                        </form>
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                  担当はありません
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </Section>

      <Section
        title={`運営への相談（${consultations.value.length}件）`}
        description="対応済みの管理は未実装です（core・スキーマに列がありません）。"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>日時</TableHead>
              <TableHead>企業</TableHead>
              <TableHead>営業ユーザー</TableHead>
              <TableHead>活動</TableHead>
              <TableHead>メモ</TableHead>
              <TableHead>次回対応</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {consultations.value.map(({ activity, companyName, userName }) => (
              <TableRow key={activity.id}>
                <TableCell className="whitespace-nowrap text-xs tabular-nums">{fmtDate(activity.occurredAt)}</TableCell>
                <TableCell className="min-w-40">
                  <Link href={`/ops/companies/${activity.companyId}`}>{companyName}</Link>
                </TableCell>
                <TableCell>{userName}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{label(ACTIVITY_LABEL, activity.kind)}</Badge>
                </TableCell>
                <TableCell className="min-w-48">{activity.note ?? "—"}</TableCell>
                <TableCell className="whitespace-nowrap text-xs tabular-nums">
                  {fmtDate(activity.nextActionAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section
        title={`営業抑止のある企業（${suppressed.value.length}件）`}
        description="抑止は企業共通で、担当解除や再収集では消えません。「今は不要」の再連絡目安を過ぎても自動では解除しません。"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>企業</TableHead>
              <TableHead>抑止</TableHead>
              <TableHead>理由</TableHead>
              <TableHead>再連絡の目安</TableHead>
              <TableHead>記録日時</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {suppressed.value.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="min-w-40 font-medium">
                  <Link href={`/ops/companies/${c.id}`}>{c.name}</Link>
                </TableCell>
                <TableCell>
                  <StatusBadge
                    value={c.suppression}
                    labels={SUPPRESSION_LABEL}
                    tone={c.suppression === "do_not_contact" ? "destructive" : "warning"}
                  />
                </TableCell>
                <TableCell className="min-w-40">{c.suppressionReason ?? "—"}</TableCell>
                <TableCell className="whitespace-nowrap text-xs tabular-nums">{fmtDate(c.recontactAfter)}</TableCell>
                <TableCell className="whitespace-nowrap text-xs tabular-nums">
                  {fmtDate(c.suppressionUpdatedAt)}
                </TableCell>
                <TableCell className="min-w-72">
                  <form action={liftSuppressionAction} className={inlineFormClass}>
                    <ReturnTo path={here} />
                    <input type="hidden" name="companyId" value={c.id} />
                    <Input
                      name="reason"
                      placeholder="解除の理由（必須）"
                      required
                      className="h-8 w-auto flex-1 basis-40"
                    />
                    <Button type="submit" variant="outline" size="xs">
                      抑止を解除
                    </Button>
                  </form>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>
    </>
  );
}
