import Link from "next/link";
import type { DiscoveryIndex } from "@/lib/ops/discovery-index";
import { discoveryConditionText, discoveryIndexHref } from "@/lib/ops/discovery-index-query";
import {
  fmtDate,
  JOB_STATUS_LABEL,
  OFFICIAL_SITE_LABEL,
  PIPELINE_LABEL,
  SUPPRESSION_LABEL,
  shortId,
} from "@/lib/ops/format";
import { StatusBadge } from "./ui-parts-1";

export function DiscoveryJobCards({ data }: { data: DiscoveryIndex }) {
  const here = discoveryIndexHref(data.query);
  return (
    <ul className="space-y-3 sm:hidden" aria-label="収集ジョブのカード">
      {data.jobs.items.map((job) => (
        <li key={job.id} className="min-w-0 rounded-xl border bg-white p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong>
              {job.provider === "fixture"
                ? "架空企業の動作確認"
                : job.provider === "nta-corporate-number"
                  ? "国税庁法人番号API"
                  : job.provider}
            </strong>
            <StatusBadge value={job.status} labels={JOB_STATUS_LABEL} />
          </div>
          <p className="mt-3 break-words">{discoveryConditionText(job.condition)}</p>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
            {[
              ["取得", job.foundCount],
              ["新規", job.createdCount],
              ["更新", job.updatedCount],
              ["スキップ", job.skippedCount],
              ["失敗", job.failedCount],
              ["試行", job.attempts],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="mt-1 font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          {(job.hasError || job.failureCount > 0) && (
            <p className="mt-3 text-amber-900">
              {job.hasError ? "エラーあり。詳細で確認できます。" : `候補の失敗・スキップ ${job.failureCount}件`}
            </p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            登録 {fmtDate(job.createdAt)} · {shortId(job.id)}
          </p>
          <div className="mt-3 flex flex-wrap gap-4 text-primary underline">
            <Link href={`/ops/discovery/${job.id}?returnTo=${encodeURIComponent(`${here}#jobs`)}`}>詳細を確認</Link>
            <Link
              href={`${discoveryIndexHref({ ...data.query, sourceJob: job.id, companyPage: 1 })}#companies`}
              scroll={false}
            >
              関連する企業を見る
            </Link>
          </div>
        </li>
      ))}
      {!data.jobs.items.length && (
        <li className="rounded-xl border bg-white p-4 text-sm">条件に合う収集ジョブはありません</li>
      )}
    </ul>
  );
}
export function DiscoveryCompanyCards({ data }: { data: DiscoveryIndex }) {
  const here = discoveryIndexHref(data.query);
  return (
    <ul className="space-y-3 sm:hidden" aria-label="企業候補のカード">
      {data.companies.items.map((company) => (
        <li key={company.id} className="min-w-0 rounded-xl border bg-white p-4 text-sm">
          <Link
            className="break-words font-semibold text-primary"
            href={`/ops/companies/${company.id}?returnTo=${encodeURIComponent(`${here}#companies`)}`}
          >
            {company.name}
          </Link>
          <p className="mt-2">
            {[company.prefecture, company.city].filter(Boolean).join(" ") || "所在地不明"} /{" "}
            {company.industry || "業種不明"}
          </p>
          {!company.addressHasSource && company.prefecture && (
            <p className="mt-1 text-xs text-muted-foreground">住所の出典なし</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <span>
              サイト <StatusBadge value={company.officialSiteStatus} labels={OFFICIAL_SITE_LABEL} />
            </span>
            <StatusBadge value={company.pipelineStatus} labels={PIPELINE_LABEL} />
            {company.suppression !== "none" && (
              <StatusBadge value={company.suppression} labels={SUPPRESSION_LABEL} tone="warning" />
            )}
          </div>
          <p className="mt-3 break-all text-xs text-muted-foreground">
            法人番号 {company.corporateNumber || "不明"} · 更新 {fmtDate(company.updatedAt)}
          </p>
        </li>
      ))}
      {!data.companies.items.length && (
        <li className="rounded-xl border bg-white p-4 text-sm">該当する候補はありません</li>
      )}
    </ul>
  );
}
