import { systemClock } from "@siteoffer/core";
import { Filter } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HistoryList } from "@/components/ops/history-list";
import { ProductionSettings } from "@/components/ops/production-status";
import { Flash, Forbidden, first, ReturnTo } from "@/components/ops/ui";
import { inlineFormClass } from "@/components/ops/ui-parts-1";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader, Section } from "@/components/ui/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { fmtDate } from "@/lib/ops/format";
import { readAuditHistory } from "@/lib/ops/history";
import { historyHref, parseHistoryQuery } from "@/lib/ops/history-query";
import { getProductionStatusForOps, imageRequestReadiness } from "@/lib/ops/production-status";
import { getSettingsForOps } from "@/lib/ops/queries";
import { getCurrentActor } from "@/lib/session";
import { updateSettingAction } from "../actions";

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
  const historyQuery = parseHistoryQuery({
    targetType: filter.targetType,
    action: filter.actionPrefix,
    view: filter.actionPrefix?.startsWith("session.") ? "all" : undefined,
  });
  if (!historyQuery) notFound();
  const [settings, events, production] = await Promise.all([
    getSettingsForOps(db, actor),
    readAuditHistory(db, actor, historyQuery),
    getProductionStatusForOps(db, systemClock, actor),
  ]);
  if (!settings.ok || !events.ok || !production.ok) return <Forbidden />;
  const here = "/ops/settings";

  return (
    <>
      <PageHeader title="設定・操作履歴" description="運用ルールと変更の履歴を確認します。" />
      <Flash searchParams={sp} />
      <p className="mb-4 text-sm">
        <Link href="/ops/backups" className="text-primary underline">
          バックアップの作成・復元確認・ダウンロード
        </Link>
      </p>
      <p className="mb-4 text-sm">
        <Link href="/ops/accounts" className="text-primary underline">
          アカウント管理（利用停止・ログインの復旧）
        </Link>
      </p>
      <p className="mb-5 text-sm">
        <Link className="text-primary underline" href="/ops/processing">
          処理の状況・ワーカーの通知を確認
        </Link>
      </p>

      <ProductionSettings
        status={production.value}
        imageRequest={imageRequestReadiness(process.env.SITEOFFER_IMAGE_MODEL, production.value.image)}
      />

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
        title="操作履歴"
        description="通常は案件・設定の最近20件を表示します。ログイン・ログアウトを含む全記録は、履歴の検索画面で表示範囲を選べます。"
      >
        <form className={inlineFormClass} method="get" action="/ops/history">
          <input type="hidden" name="view" value="all" />
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
        <HistoryList data={events.value} compact />
        <Link href={historyHref(historyQuery)} className="inline-block text-primary underline text-sm">
          すべての操作履歴を検索する
        </Link>
      </Section>
    </>
  );
}
