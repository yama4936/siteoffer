import { Download, FileArchive, RefreshCw, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { BackupForm } from "@/components/ops/backup-form";
import { BackupRuntimePanel } from "@/components/ops/backup-runtime";
import { Forbidden, first } from "@/components/ops/ui";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader, Section } from "@/components/ui/page";
import { BackupAccessError, backupPage } from "@/lib/ops/backups";
import { fmtDate } from "@/lib/ops/format";

function bytes(n: number) {
  return `${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 }).format(n / 1024 / 1024)} MB`;
}
export default async function BackupsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams,
    raw = first(sp, "page") || "0";
  let data: Awaited<ReturnType<typeof backupPage>>;
  try {
    data = await backupPage(/^\d{1,6}$/.test(raw) ? Number(raw) : 0);
  } catch (e) {
    if (e instanceof BackupAccessError) return <Forbidden />;
    throw e;
  }
  return (
    <>
      <PageHeader
        title="バックアップ・復元確認"
        description="案件・記事・素材・生成サイトを暗号化して保存し、復元できることを確認します。"
        actions={
          <Link href={`/ops/backups?page=${data.page}`} className={buttonVariants({ variant: "outline" })}>
            <RefreshCw />
            一覧を更新
          </Link>
        }
      />
      <p className="mb-5 text-sm">
        <Link href="/ops/backups/storage" className="text-primary underline">
          保護指定・保存期間の条件で整理・容量の確認
        </Link>
      </p>
      {!data.enabled ? (
        <Section title="この環境のバックアップ接続が未設定です">
          <p className="text-sm">
            現在はローカルデモのDBに対応しています。通常のPostgreSQL・AWSのバックアップには、実行環境に合わせた接続と復元検証が必要です。
          </p>
        </Section>
      ) : (
        <BackupRuntimePanel
          initial={{
            available: data.available,
            busy: data.busy,
            phase: data.phase,
            operation: data.operation,
            startedAt: data.startedAt,
            files: data.files,
          }}
        >
          <div className="mb-6 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border bg-card p-4">
              <FileArchive className="mb-2 size-5 text-primary" />
              <p className="text-xs text-muted-foreground">保存済み</p>
              <strong className="text-2xl tabular-nums">
                {data.total}
                <span className="ml-1 text-sm font-normal">件</span>
              </strong>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <ShieldCheck className="mb-2 size-5 text-emerald-700" />
              <strong className="text-sm">保存後に自動で復元確認</strong>
              <p className="mt-1 text-xs text-muted-foreground">別フォルダーでDB・件数・ファイルを照合します。</p>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <Download className="mb-2 size-5 text-primary" />
              <strong className="text-sm">端末の外にも保管</strong>
              <p className="mt-1 text-xs text-muted-foreground">
                ダウンロードして別の安全な保存先にコピーしてください。
              </p>
            </div>
          </div>
          <Section
            title="新しいバックアップ"
            description="DBの取得中は更新処理が一時的に待機します。暗号化・復元確認の間は通常の操作を続けられます。"
          >
            <BackupForm />
          </Section>
          <Section
            title={`保存済みバックアップ（${data.total}件）`}
            description="確認日時は、その時点で実際に復元できた記録です。容量・更新日時が変わったファイルは再確認が必要です。定期的な再検証も行ってください。"
          >
            {!data.items.length && (
              <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                まだバックアップがありません。上のフォームから最初の1件を作成してください。
              </div>
            )}
            <div className="space-y-3">
              {data.items.map((item) => (
                <article key={item.id} className="rounded-xl border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <strong className="text-sm">{fmtDate(item.savedAt)}</strong>
                        <Badge variant={item.status === "verified" ? "success" : "outline"}>
                          {
                            {
                              verified: "復元確認済み",
                              unverified: "復元未確認",
                              changed: "ファイル変更あり・再確認",
                              incomplete: "保存未完了",
                            }[item.status]
                          }
                        </Badge>
                      </div>
                      <p className="break-all font-mono text-xs text-muted-foreground">{item.id}</p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {bytes(item.bytes)}
                        {item.verifiedAt && ` ／ 復元確認 ${fmtDate(item.verifiedAt)}`}
                        {item.tables !== null && ` ／ ${item.tables}テーブル・${item.files}ファイル`}
                      </p>
                    </div>
                    {item.status !== "incomplete" && (
                      <a
                        href={`/ops/backups/${item.id}/file`}
                        className={buttonVariants({ variant: "outline", size: "sm" })}
                      >
                        <Download />
                        ダウンロード
                      </a>
                    )}
                  </div>
                  {item.sha256 && (
                    <details className="mt-3 text-xs text-muted-foreground">
                      <summary className="cursor-pointer">照合用SHA-256</summary>
                      <code className="mt-2 block break-all">{item.sha256}</code>
                    </details>
                  )}
                  {item.status !== "incomplete" && (
                    <details className="mt-3 border-t pt-3">
                      <summary className="cursor-pointer text-sm font-medium text-primary">
                        パスフレーズを入力して再検証
                      </summary>
                      <div className="mt-4 max-w-lg">
                        <BackupForm backupId={item.id} />
                      </div>
                    </details>
                  )}
                </article>
              ))}
            </div>
            {data.pages > 1 && (
              <nav
                aria-label="バックアップ一覧のページ"
                className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm"
              >
                <span>
                  {data.page + 1} / {data.pages}ページ
                </span>
                <div className="flex gap-2">
                  {data.page > 0 && (
                    <Link
                      href={`/ops/backups?page=${data.page - 1}`}
                      className={buttonVariants({ variant: "outline" })}
                    >
                      前の20件
                    </Link>
                  )}
                  {data.page + 1 < data.pages && (
                    <Link
                      href={`/ops/backups?page=${data.page + 1}`}
                      className={buttonVariants({ variant: "outline" })}
                    >
                      次の20件
                    </Link>
                  )}
                </div>
              </nav>
            )}
          </Section>
          <Section title="復元するとき">
            <p className="text-sm leading-7">
              保存ファイルとパスフレーズを使い、ローカル端末の <code>pnpm demo:restore &lt;ファイル&gt;</code>{" "}
              で別フォルダーへ復元できます。現在のデータには上書きしません。確認した復元先は{" "}
              <code>pnpm demo:restored &lt;復元フォルダー&gt;</code> で起動できます。保存時と同じPGliteの版が必要です。
            </p>
            <p className="mt-3 text-xs text-muted-foreground">
              APIキーなどの環境設定は含まれません。外部サービスの再接続や本番環境への復旧は別途確認が必要です。
            </p>
          </Section>
        </BackupRuntimePanel>
      )}
    </>
  );
}
