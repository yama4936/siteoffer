import Link from "next/link";
import { notFound } from "next/navigation";
import { Forbidden } from "@/components/ops/ui";
import { DescriptionList, PageHeader } from "@/components/ui/page";
import { getDb } from "@/lib/db";
import { fmtDate } from "@/lib/ops/format";
import { readAuditHistoryEvent } from "@/lib/ops/history";
import { HISTORY_TARGETS, historyActionLabel, historyTargetLink } from "@/lib/ops/history-presentation";
import { HISTORY_ACTORS, historyHref, parseHistoryQuery } from "@/lib/ops/history-query";
import { getCurrentActor } from "@/lib/session";

function Value({ value }: { value: unknown }) {
  return (
    <pre className="whitespace-pre-wrap break-all font-sans text-sm leading-6">
      {value === null ? "（値なし）" : typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}
export default async function HistoryEventPage({
  params,
  searchParams,
}: {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ eventId }, sp] = await Promise.all([params, searchParams]);
  const query = parseHistoryQuery(sp);
  if (!query) notFound();
  const result = await readAuditHistoryEvent(getDb(), await getCurrentActor(), eventId);
  if (!result.ok) {
    if (result.error === "forbidden") return <Forbidden />;
    notFound();
  }
  const event = result.value,
    kind = Object.hasOwn(HISTORY_ACTORS, event.actorKind) ? HISTORY_ACTORS[event.actorKind] : "不明な主体",
    target = Object.hasOwn(HISTORY_TARGETS, event.targetType) ? HISTORY_TARGETS[event.targetType] : "対象の記録";
  const recordHref = historyTargetLink(event.targetType, event.targetId, event.companyName);
  return (
    <>
      <Link href={historyHref(query)} className="mb-4 inline-block text-sm text-primary underline">
        ← 検索条件を保って操作履歴へ戻る
      </Link>
      <PageHeader
        title={historyActionLabel(event.action)}
        description="保存された操作記録です。現在の状態は対象の画面で確認してください。"
        actions={
          recordHref && (
            <Link href={recordHref} className="text-primary underline text-sm">
              対象を開く
            </Link>
          )
        }
      />
      <DescriptionList className="mb-6 rounded-xl border bg-white p-4">
        <dt>日時</dt>
        <dd>{fmtDate(event.createdAt)}（日本時間）</dd>
        <dt>操作した人</dt>
        <dd>
          {kind}
          {event.actorName ? ` · ${event.actorName}` : ""}
        </dd>
        <dt>対象</dt>
        <dd>
          {target}
          {event.companyName ? ` · ${event.companyName}` : ""}
        </dd>
        <dt>操作コード</dt>
        <dd className="break-all">{event.action}</dd>
      </DescriptionList>
      {(event.beforeOmitted || event.afterOmitted) && (
        <p role="status" className="mb-4 rounded-lg border bg-amber-50 p-3 text-sm">
          {event.beforeOmitted ? "変更前" : ""}
          {event.beforeOmitted && event.afterOmitted ? "・" : ""}
          {event.afterOmitted ? "変更後" : ""}の記録が64KiBを超えるため、本文の表示を省略しています。
        </p>
      )}
      <h2 className="mb-2 font-semibold">保存された主な項目</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        最大30項目を表示します。長い値・深い階層・一部の機密項目は省略します。完全な差分表示ではありません。元の操作記録は変更しません。
      </p>
      {!event.fields.items.length && (
        <p className="rounded-lg border bg-white p-4 text-sm">
          {event.beforeOmitted || event.afterOmitted
            ? "本文は表示上限を超えたため省略しています。元の操作記録は残っています。"
            : "変更前後の本文は記録されていません。操作コードと対象の情報を確認してください。"}
        </p>
      )}
      <ol className="space-y-3">
        {event.fields.items.map((field) => (
          <li key={field.key} className="min-w-0 rounded-xl border bg-white p-4">
            <h3 className="mb-3 break-all font-medium">{field.label}</h3>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="min-w-0 rounded-lg bg-slate-50 p-3">
                <p className="mb-2 text-xs text-muted-foreground">変更前</p>
                {event.beforeOmitted ? <p className="text-sm">表示を省略</p> : <Value value={field.before} />}
              </div>
              <div className="min-w-0 rounded-lg bg-blue-50/50 p-3">
                <p className="mb-2 text-xs text-muted-foreground">変更後</p>
                {event.afterOmitted ? <p className="text-sm">表示を省略</p> : <Value value={field.after} />}
              </div>
            </div>
          </li>
        ))}
      </ol>
      {!!event.fields.omitted && <p className="mt-3 text-sm">ほか{event.fields.omitted}項目の表示を省略しています。</p>}
      <details className="my-6 rounded-xl border p-4 text-sm">
        <summary className="cursor-pointer">記録の識別情報</summary>
        <dl className="mt-3 space-y-2 break-all">
          <dt>記録ID</dt>
          <dd>{event.id}</dd>
          <dt>対象の種類・ID</dt>
          <dd>
            {event.targetType} / {event.targetId}
            {event.targetTruncated ? "…（表示を省略）" : ""}
          </dd>
        </dl>
        {!event.targetTruncated && (
          <Link
            href={historyHref({
              ...query,
              view: "all",
              page: 1,
              q: "",
              action: "",
              actor: "",
              from: "",
              to: "",
              targetType: event.targetType,
              targetId: event.targetId,
            })}
            className="mt-3 inline-block text-primary underline"
          >
            この対象の操作をすべて探す
          </Link>
        )}
      </details>
    </>
  );
}
