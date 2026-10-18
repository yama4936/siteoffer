import { ArchiveRestore, HardDrive, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PurgeRetention, RetentionForm, RetentionPlanner, StorageRefresh } from "@/components/ops/backup-retention";
import { BackupRuntimePanel } from "@/components/ops/backup-runtime";
import { Forbidden } from "@/components/ops/ui";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Section } from "@/components/ui/page";
import { readBackupStorage } from "@/lib/ops/backup-retention";
import { BackupAccessError } from "@/lib/ops/backups";
import { fmtDate } from "@/lib/ops/format";
import { backupBytes } from "../../../../../../../demo/backup/retention-protocol.ts";
import { parseRetentionRequest } from "../../../../../../../demo/backup/retention-request.ts";

export default async function StoragePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  function numeric(key: string) {
    const value = sp[key];
    if (value === undefined) return 0;
    if (typeof value !== "string" || !/^\d{1,6}$/.test(value)) notFound();
    return Number(value);
  }
  let request: ReturnType<typeof parseRetentionRequest>;
  try {
    request = parseRetentionRequest({
      operation: "storage",
      page: numeric("page"),
      trashPage: numeric("trashPage"),
      ...(sp.batch !== undefined ? { batch: sp.batch } : {}),
    });
  } catch {
    notFound();
  }
  if (request.operation !== "storage") notFound();
  let view: Awaited<ReturnType<typeof readBackupStorage>>;
  try {
    view = await readBackupStorage(request);
  } catch (error) {
    if (error instanceof BackupAccessError) return <Forbidden />;
    throw error;
  }
  const data = view.data;
  function href(page = data?.active.page ?? 0, trashPage = data?.trash.page ?? 0, batch?: string) {
    const query = new URLSearchParams({ page: String(page), trashPage: String(trashPage) });
    if (batch) query.set("batch", batch);
    return `/ops/backups/storage?${query}`;
  }
  return (
    <>
      <Link href="/ops/backups" className="mb-4 inline-block text-sm text-primary underline">
        バックアップの作成・ダウンロードへ
      </Link>
      <PageHeader
        title="バックアップの保管・容量"
        description="保護する保存を残し、整理候補の確認から退避・復元・完全削除まで進められます。"
        actions={
          <StorageRefresh href={href(undefined, undefined, typeof sp.batch === "string" ? sp.batch : undefined)} />
        }
      />
      {!view.configured ? (
        <Section title="この環境のバックアップ接続が未設定です">
          <p className="text-sm leading-7">
            データを保持してローカルデモを正常に再起動すると、この環境の保存先を確認できます。通常のPostgreSQL・AWSは実行環境に合わせた保管運用が必要です。
          </p>
        </Section>
      ) : (
        <BackupRuntimePanel initial={view.runtime}>
          {view.error && (
            <p role="alert" className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
              {view.error} 一覧を更新して結果を再確認してください。
            </p>
          )}
          {data ? (
            <>
              <div className="mb-6 grid gap-3 sm:grid-cols-3">
                {[
                  { label: "保管中の保存ファイル", value: backupBytes(data.activeBytes), icon: ShieldCheck },
                  { label: "退避先で使っている容量", value: backupBytes(data.trashBytes), icon: ArchiveRestore },
                  {
                    label: "保存先ディスクの空き容量",
                    value: data.freeBytes === null ? "取得できません" : backupBytes(data.freeBytes),
                    icon: HardDrive,
                  },
                ].map((item) => (
                  <div key={item.label} className="rounded-xl border bg-card p-4">
                    <item.icon className="mb-2 size-5 text-primary" />
                    <p className="text-xs text-muted-foreground">{item.label}</p>
                    <strong className="text-2xl tabular-nums">{item.value}</strong>
                  </div>
                ))}
              </div>
              <p className="mb-5 break-all rounded-lg border bg-card p-3 font-mono text-xs">
                整理する保存先：{data.root}
              </p>
              {data.blocked > 0 && (
                <p role="alert" className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
                  リンク・共有ファイル・不明な構成などで、{data.blocked}
                  件の保管を通常の整理対象にできません。表示容量に未計測の部分がある可能性があります。完全削除せず、保存先を確認してください。
                </p>
              )}
            </>
          ) : (
            <p className="mb-5 text-sm">
              保管一覧はまだ取得できていません。現在の処理が終了してから一覧を更新してください。
            </p>
          )}
          <Section
            title="保存条件と整理候補"
            description="ここで整理するのは、表示した保存先にあるバックアップのコピーです。まず退避し、必要に応じて元へ戻せます。"
          >
            <RetentionPlanner />
          </Section>
          {data && (
            <>
              <Section
                title={`保管中のバックアップ（${data.active.total}件）`}
                description="保護した保存は整理候補から外れます。状態が変わった場合は候補を確認し直してください。"
              >
                {!data.active.items.length && (
                  <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                    保管中のバックアップはありません。
                  </p>
                )}
                <div className="space-y-3">
                  {data.active.items.map((item) => (
                    <article
                      key={item.id}
                      className="flex flex-wrap items-start justify-between gap-4 rounded-xl border p-4"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                          <strong>{fmtDate(item.savedAt)}</strong>
                          {item.pinned && <Badge variant="success">保護中</Badge>}
                          {item.verified && <Badge variant="success">復元確認済み</Badge>}
                          {item.blocked && <Badge variant="outline">構成の確認が必要</Badge>}
                        </p>
                        <code className="break-all text-xs">{item.id}</code>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {backupBytes(item.bytes)}・{item.files}ファイル
                        </p>
                        <details className="mt-2 text-xs text-muted-foreground">
                          <summary>保存先</summary>
                          <code className="break-all">{item.path}</code>
                        </details>
                      </div>
                      <RetentionForm
                        request={{ operation: "pin", id: item.id, pinned: !item.pinned }}
                        label={item.pinned ? "保護を解除" : "整理から保護"}
                        disabled={item.blocked}
                      />
                    </article>
                  ))}
                </div>
                <nav aria-label="保管中のページ" className="mt-4 flex items-center justify-between gap-3 text-sm">
                  <span>
                    {data.active.page + 1} / {data.active.pages}ページ
                  </span>
                  <div className="flex gap-3">
                    {data.active.page > 0 && (
                      <Link href={href(data.active.page - 1)} className="text-primary underline">
                        前の20件
                      </Link>
                    )}
                    {data.active.page + 1 < data.active.pages && (
                      <Link href={href(data.active.page + 1)} className="text-primary underline">
                        次の20件
                      </Link>
                    )}
                  </div>
                </nav>
              </Section>
              <Section
                title={`退避した整理操作（${data.trash.total}件）`}
                description="退避だけではディスクの空きは増えません。完全削除を開始するまでは元の保存一覧へ戻せます。"
              >
                {!data.trash.items.length && (
                  <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                    退避した保存はありません。
                  </p>
                )}
                <div className="space-y-3">
                  {data.trash.items.map((batch) => (
                    <article key={batch.id} className="space-y-3 rounded-xl border p-4">
                      <p className="flex flex-wrap gap-2 text-sm">
                        <strong>{fmtDate(batch.createdAt)}</strong>
                        <Badge variant="outline">
                          {
                            {
                              moved: "退避済み",
                              partial: "途中の操作あり",
                              restored: "元に戻しました",
                              purged: "完全削除済み",
                              closed: "退避先の操作完了",
                            }[batch.state]
                          }
                        </Badge>
                      </p>
                      <code className="block break-all text-xs">{batch.id}</code>
                      <p className="text-sm">
                        退避先に{batch.moved}件・{backupBytes(batch.bytes)}
                        {batch.failed ? ` ／ 未処理${batch.failed}件` : ""}
                      </p>
                      <Link
                        href={href(undefined, undefined, batch.id)}
                        className="inline-block text-sm text-primary underline"
                      >
                        内訳と操作を確認
                      </Link>
                    </article>
                  ))}
                </div>
                <nav aria-label="退避操作のページ" className="mt-4 flex items-center justify-between gap-3 text-sm">
                  <span>
                    {data.trash.page + 1} / {data.trash.pages}ページ
                  </span>
                  <div className="flex gap-3">
                    {data.trash.page > 0 && (
                      <Link href={href(undefined, data.trash.page - 1)} className="text-primary underline">
                        前の20件
                      </Link>
                    )}
                    {data.trash.page + 1 < data.trash.pages && (
                      <Link href={href(undefined, data.trash.page + 1)} className="text-primary underline">
                        次の20件
                      </Link>
                    )}
                  </div>
                </nav>
              </Section>
              {data.detail && (
                <Section
                  title="選んだ整理操作の内訳"
                  description="完全削除の前に、対象の保管場所と容量を確認してください。"
                >
                  <div className="space-y-4">
                    <code className="block break-all text-xs">{data.detail.path}</code>
                    <p className="text-sm">
                      退避先のファイル容量：{backupBytes(data.detail.bytes)}
                      。リンク／共有ファイルを含む場合や記録と内容が変わった場合は削除を止めます。
                    </p>
                    <ul className="max-h-80 space-y-2 overflow-auto">
                      {data.detail.items.map((item) => (
                        <li key={item.id} className="rounded-lg bg-muted/40 p-3 text-xs">
                          <code className="block break-all">{item.path}</code>
                          <p>
                            {backupBytes(item.bytes)} ／{" "}
                            {{
                              pending: "移動前",
                              moved: "退避済み",
                              failed: "未処理",
                              restored: "元に戻しました",
                              purged: "完全削除済み",
                            }[item.state] ?? item.state}
                          </p>
                        </li>
                      ))}
                    </ul>
                    {data.detail.moved > 0 && (
                      <>
                        <div className="border-t pt-4">
                          {data.detail.restorable ? (
                            <RetentionForm
                              key={`restore:${data.detail.id}`}
                              request={{ operation: "restore", id: data.detail.id }}
                              label="元の保存一覧へ戻す"
                            />
                          ) : (
                            <p className="text-sm text-amber-900">
                              完全削除を開始したため、元に戻す操作は利用できません。残っているファイルの完全削除を再開できます。
                            </p>
                          )}
                        </div>
                        <div className="rounded-xl border border-red-200 bg-red-50/30 p-4">
                          <h3 className="mb-3 font-semibold">退避データを完全削除する</h3>
                          <PurgeRetention key={`purge:${data.detail.id}`} batch={data.detail} keepers={data.keepers} />
                        </div>
                      </>
                    )}
                  </div>
                </Section>
              )}
              <p className="text-xs leading-6 text-muted-foreground">
                容量は記録済みの保存ファイルの合計です。ディスクの空きは同じ端末のほかの処理でも変わります。退避先の操作記録は、ファイルの完全削除後も残します。
              </p>
            </>
          )}
        </BackupRuntimePanel>
      )}
    </>
  );
}
