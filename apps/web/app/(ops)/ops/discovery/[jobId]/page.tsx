import Link from "next/link";
import { notFound } from "next/navigation";
import { Forbidden, Json } from "@/components/ops/ui";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
import { fmtDate, JOB_STATUS_LABEL, label } from "@/lib/ops/format";
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
    <main>
      <p>
        <Link href="/ops/discovery">← 収集・候補へ戻る</Link>
      </p>
      <h1>収集ジョブ {job.id}</h1>
      {job.status === "queued" || job.status === "running" ? (
        <p className="warn">
          ワーカーが処理します（数秒〜）。<a href={`/ops/discovery/${job.id}`}>再読み込み</a>
          すると状態と件数が最新になります。
        </p>
      ) : null}
      <table>
        <tbody>
          <tr>
            <th>取得元</th>
            <td>{job.provider}</td>
          </tr>
          <tr>
            <th>状態</th>
            <td>{label(JOB_STATUS_LABEL, job.status)}</td>
          </tr>
          <tr>
            <th>条件</th>
            <td>
              <Json value={job.criteria} />
            </td>
          </tr>
          <tr>
            <th>件数</th>
            <td>
              取得 {job.foundCount} / 新規 {job.createdCount} / 更新 {job.updatedCount} / スキップ {job.skippedCount} /
              失敗 {job.failedCount}（上限 {job.maxResults ?? "—"}）
            </td>
          </tr>
          <tr>
            <th>試行回数</th>
            <td>{job.attempts}</td>
          </tr>
          <tr>
            <th>ジョブの失敗理由</th>
            <td className={job.error ? "warn" : undefined}>{job.error ?? "—"}</td>
          </tr>
          <tr>
            <th>登録・開始・終了</th>
            <td>
              {fmtDate(job.createdAt)} / {fmtDate(job.startedAt)} / {fmtDate(job.finishedAt)}
            </td>
          </tr>
        </tbody>
      </table>

      <h2>候補ごとの失敗・スキップ（{failures.length}件）</h2>
      <table>
        <thead>
          <tr>
            <th>外部ID</th>
            <th>段階</th>
            <th>理由</th>
          </tr>
        </thead>
        <tbody>
          {failures.map((f, i) => (
            // 同じ外部IDが複数の段階で記録されることがあるため添字も使う
            // biome-ignore lint/suspicious/noArrayIndexKey: 表示専用の静的な一覧
            <tr key={i}>
              <td>{f.externalId ?? "—"}</td>
              <td>{f.stage ?? "—"}</td>
              <td>{f.reason ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>出典（{sources.length}件）</h2>
      <table>
        <thead>
          <tr>
            <th>企業</th>
            <th>役割</th>
            <th>外部ID</th>
            <th>出典URL</th>
            <th>取得日時</th>
          </tr>
        </thead>
        <tbody>
          {sources.map(({ source, companyName }) => (
            <tr key={source.id}>
              <td>
                {source.companyId ? (
                  <Link href={`/ops/companies/${source.companyId}`}>{companyName ?? source.companyId}</Link>
                ) : (
                  "—"
                )}
              </td>
              <td>{source.role === "site" ? "公式サイト候補" : "企業候補"}</td>
              <td>{source.externalId}</td>
              <td>{source.sourceUrl ?? "—"}</td>
              <td>{fmtDate(source.fetchedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
