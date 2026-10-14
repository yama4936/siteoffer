import Link from "next/link";
import { notFound } from "next/navigation";
import { Forbidden, Json } from "@/components/ops/ui";
import { StatusBadge } from "@/components/ops/ui-parts-1";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { DescriptionList, PageHeader, Section } from "@/components/ui/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
import { fmtDate, JOB_STATUS_LABEL } from "@/lib/ops/format";
import { getDiscoveryJob } from "@/lib/ops/queries";
import { getCurrentActor } from "@/lib/session";

export default async function DiscoveryJobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!isUuid(jobId)) notFound();
  const r = await getDiscoveryJob(getDb(), await getCurrentActor(), jobId);
  if (!r.ok) return <Forbidden />;
  if (!r.value) notFound();
  const { job, sources } = r.value;
  const failures = Array.isArray(job.failures)
    ? (job.failures as { externalId?: string | null; stage?: string; reason?: string }[])
    : [];
  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/ops/discovery" className="text-muted-foreground hover:text-foreground">
            ← 収集・候補へ戻る
          </Link>
        }
        title={
          <>
            収集ジョブ <span className="break-all font-mono font-normal text-base text-muted-foreground">{job.id}</span>
          </>
        }
      />
      {job.status === "queued" || job.status === "running" ? (
        <Alert variant="warning" className="mb-6">
          <AlertDescription>
            <p>
              ワーカーが処理します（数秒〜）。<a href={`/ops/discovery/${job.id}`}>再読み込み</a>
              すると状態と件数が最新になります。
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      <Card className="mb-8">
        <CardContent>
          <DescriptionList>
            <dt>取得元</dt>
            <dd>{job.provider}</dd>
            <dt>状態</dt>
            <dd>
              <StatusBadge value={job.status} labels={JOB_STATUS_LABEL} />
            </dd>
            <dt>条件</dt>
            <dd>
              <Json value={job.criteria} />
            </dd>
            <dt>件数</dt>
            <dd className="tabular-nums">
              取得 {job.foundCount} / 新規 {job.createdCount} / 更新 {job.updatedCount} / スキップ {job.skippedCount} /
              失敗 {job.failedCount}（上限 {job.maxResults ?? "—"}）
            </dd>
            <dt>試行回数</dt>
            <dd className="tabular-nums">{job.attempts}</dd>
            <dt>ジョブの失敗理由</dt>
            <dd className={job.error ? "text-destructive" : undefined}>{job.error ?? "—"}</dd>
            <dt>登録・開始・終了</dt>
            <dd className="tabular-nums">
              {fmtDate(job.createdAt)} / {fmtDate(job.startedAt)} / {fmtDate(job.finishedAt)}
            </dd>
          </DescriptionList>
        </CardContent>
      </Card>

      <Section title={`候補ごとの失敗・スキップ（${failures.length}件）`}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>外部ID</TableHead>
              <TableHead>段階</TableHead>
              <TableHead>理由</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {failures.map((f, i) => (
              // 同じ外部IDが複数の段階で記録されることがあるため添字も使う
              // biome-ignore lint/suspicious/noArrayIndexKey: 表示専用の静的な一覧
              <TableRow key={i}>
                <TableCell className="font-mono text-xs">{f.externalId ?? "—"}</TableCell>
                <TableCell>{f.stage ?? "—"}</TableCell>
                <TableCell>{f.reason ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section title={`出典（${sources.length}件）`}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>企業</TableHead>
              <TableHead>役割</TableHead>
              <TableHead>外部ID</TableHead>
              <TableHead>出典URL</TableHead>
              <TableHead>取得日時</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sources.map(({ source, companyName }) => (
              <TableRow key={source.id}>
                <TableCell className="min-w-40">
                  {source.companyId ? (
                    <Link href={`/ops/companies/${source.companyId}`}>{companyName ?? source.companyId}</Link>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={source.role === "site" ? "info" : "secondary"}>
                    {source.role === "site" ? "公式サイト候補" : "企業候補"}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{source.externalId}</TableCell>
                <TableCell className="max-w-80 break-all text-xs">{source.sourceUrl ?? "—"}</TableCell>
                <TableCell className="whitespace-nowrap text-xs tabular-nums">{fmtDate(source.fetchedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>
    </>
  );
}
