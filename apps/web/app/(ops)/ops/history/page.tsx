import Form from "next/form";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HistoryList } from "@/components/ops/history-list";
import { Forbidden } from "@/components/ops/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page";
import { NativeSelect } from "@/components/ui/select";
import { getDb } from "@/lib/db";
import { readAuditHistory } from "@/lib/ops/history";
import { HISTORY_ACTORS, HISTORY_VIEWS, parseHistoryQuery } from "@/lib/ops/history-query";
import { getCurrentActor } from "@/lib/session";

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = parseHistoryQuery(await searchParams);
  if (!query) notFound();
  const result = await readAuditHistory(getDb(), await getCurrentActor(), query);
  if (!result.ok) return <Forbidden />;
  const data = result.value;
  return (
    <>
      <PageHeader
        title="操作履歴"
        description="誰が、いつ、何をしたかを全記録から探せます。変更内容は必要な記録だけ開いて確認します。"
        actions={
          <Link href="/ops/settings" className="text-sm text-primary underline">
            運営設定へ
          </Link>
        }
      />
      <Form action="/ops/history" className="mb-6 space-y-4 rounded-xl border bg-white p-4" aria-label="操作履歴を検索">
        <fieldset key={JSON.stringify(data.query)} className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Label className="grid gap-1 md:col-span-2">
            操作・企業名・担当者・ID
            <Input
              name="q"
              maxLength={120}
              defaultValue={data.query.q}
              placeholder="例：提案を承認、企業名、担当者名"
            />
          </Label>
          <Label className="grid gap-1">
            表示する履歴
            <NativeSelect name="view" defaultValue={data.query.view}>
              {Object.entries(HISTORY_VIEWS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </Label>
          <Label className="grid gap-1">
            操作した人
            <NativeSelect name="actor" defaultValue={data.query.actor}>
              <option value="">すべて</option>
              {Object.entries(HISTORY_ACTORS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </Label>
          <div className="grid gap-3 sm:grid-cols-2 min-w-0 md:col-span-2">
            <Label className="grid min-w-0 gap-1">
              開始日
              <Input className="min-w-0" type="date" name="from" defaultValue={data.query.from} />
            </Label>
            <Label className="grid min-w-0 gap-1">
              終了日
              <Input className="min-w-0" type="date" name="to" defaultValue={data.query.to} />
            </Label>
          </div>
          <details
            className="rounded-lg border p-3 md:col-span-2"
            open={!!(data.query.targetType || data.query.targetId || data.query.action)}
          >
            <summary className="cursor-pointer text-sm font-medium">詳細条件（対象の種類・ID・操作コード）</summary>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <Label className="grid gap-1">
                対象の種類（任意）
                <Input
                  name="targetType"
                  maxLength={120}
                  defaultValue={data.query.targetType}
                  placeholder="例：company、settings"
                />
              </Label>
              <Label className="grid gap-1">
                対象ID（完全一致）
                <Input name="targetId" maxLength={300} defaultValue={data.query.targetId} />
              </Label>
              <Label className="grid gap-1">
                操作コード（前方一致）
                <Input name="action" maxLength={120} defaultValue={data.query.action} placeholder="例：discovery." />
              </Label>
            </div>
          </details>
        </fieldset>
        <p className="text-xs text-muted-foreground">
          案件・設定の操作にはログイン・ログアウトを含めません。「すべての操作」へ切り替えると全記録を探せます。日付は日本時間で終了日も含みます。変更本文は検索しません。
        </p>
        <div className="flex flex-wrap gap-4 items-center">
          <Button type="submit">検索する</Button>
          <Link href="/ops/history" className="text-sm text-primary underline">
            条件をクリア
          </Link>
        </div>
      </Form>
      <HistoryList data={data} />
    </>
  );
}
