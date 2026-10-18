import Form from "next/form";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import {
  DISCOVERY_JOB_PROVIDERS,
  DISCOVERY_JOB_STATES,
  type DiscoveryIndexQuery,
  discoveryIndexHref,
  discoveryIndexParams,
} from "@/lib/ops/discovery-index-query";
import { JOB_STATUS_LABEL, OFFICIAL_SITE_LABEL, PIPELINE_LABEL } from "@/lib/ops/format";

const companyKeys = ["q", "prefecture", "city", "official", "pipeline", "suppressed", "sourceJob", "companyPage"];
const jobKeys = ["jobQuery", "jobStatus", "jobProvider", "jobsPage"];
function Preserve({ query, except }: { query: DiscoveryIndexQuery; except: string[] }) {
  return Array.from(discoveryIndexParams(query))
    .filter(([key]) => !except.includes(key))
    .map(([key, value]) => <input type="hidden" key={key} name={key} value={value} />);
}
export function DiscoveryCompanyFilters({ query }: { query: DiscoveryIndexQuery }) {
  const cleared = {
    ...query,
    q: "",
    prefecture: "",
    city: "",
    official: "",
    pipeline: "",
    suppressed: "" as const,
    sourceJob: "",
    companyPage: 1,
  };
  return (
    <Form action="/ops/discovery" scroll={false}>
      <Preserve query={query} except={companyKeys} />
      {query.sourceJob && <input type="hidden" name="sourceJob" value={query.sourceJob} />}
      <fieldset
        key={JSON.stringify(companyKeys.map((key) => query[key as keyof DiscoveryIndexQuery]))}
        className="flex flex-wrap items-end gap-3"
      >
        <Label className="grid w-full gap-1 text-sm sm:w-64">
          企業名・法人番号・地域・業種
          <Input name="q" maxLength={120} defaultValue={query.q} />
        </Label>
        <Label className="grid w-full gap-1 text-sm sm:w-36">
          都道府県
          <Input name="prefecture" maxLength={120} defaultValue={query.prefecture} placeholder="愛知県" />
        </Label>
        <Label className="grid w-full gap-1 text-sm sm:w-44">
          市区町村（前方一致）
          <Input name="city" maxLength={120} defaultValue={query.city} placeholder="名古屋市" />
        </Label>
        <Label className="grid gap-1 text-sm">
          公式サイト
          <NativeSelect name="official" defaultValue={query.official}>
            <option value="">すべて</option>
            {Object.entries(OFFICIAL_SITE_LABEL).map(([key, value]) => (
              <option key={key} value={key}>
                {value}
              </option>
            ))}
          </NativeSelect>
        </Label>
        <Label className="grid gap-1 text-sm">
          準備段階
          <NativeSelect name="pipeline" defaultValue={query.pipeline}>
            <option value="">すべて</option>
            {Object.entries(PIPELINE_LABEL).map(([key, value]) => (
              <option key={key} value={key}>
                {value}
              </option>
            ))}
          </NativeSelect>
        </Label>
        <Label className="grid gap-1 text-sm">
          営業抑止
          <NativeSelect name="suppressed" defaultValue={query.suppressed}>
            <option value="">すべて</option>
            <option value="no">抑止なし</option>
            <option value="yes">抑止あり</option>
          </NativeSelect>
        </Label>
        <Button type="submit" variant="secondary">
          企業を検索
        </Button>
        <Link
          href={`${discoveryIndexHref(cleared)}#companies`}
          scroll={false}
          className="py-2 text-sm text-primary underline"
        >
          企業の条件を解除
        </Link>
      </fieldset>
    </Form>
  );
}
export function DiscoveryJobFilters({ query }: { query: DiscoveryIndexQuery }) {
  return (
    <Form action="/ops/discovery" scroll={false}>
      <Preserve query={query} except={jobKeys} />
      <fieldset
        key={JSON.stringify(jobKeys.map((key) => query[key as keyof DiscoveryIndexQuery]))}
        className="flex flex-wrap items-end gap-3"
      >
        <Label className="grid w-full gap-1 text-sm sm:w-72">
          収集ID・地域・業種・企業名の条件
          <Input name="jobQuery" maxLength={120} defaultValue={query.jobQuery} />
        </Label>
        <Label className="grid gap-1 text-sm">
          ジョブの状態
          <NativeSelect name="jobStatus" defaultValue={query.jobStatus}>
            <option value="">すべて</option>
            {DISCOVERY_JOB_STATES.map((key) => (
              <option key={key} value={key}>
                {JOB_STATUS_LABEL[key]}
              </option>
            ))}
          </NativeSelect>
        </Label>
        <Label className="grid gap-1 text-sm">
          取得元
          <NativeSelect name="jobProvider" defaultValue={query.jobProvider}>
            <option value="">すべて</option>
            {DISCOVERY_JOB_PROVIDERS.map((key) => (
              <option key={key} value={key}>
                {key === "fixture" ? "架空企業（開発用）" : "国税庁法人番号API"}
              </option>
            ))}
          </NativeSelect>
        </Label>
        <Button type="submit" variant="secondary">
          収集ジョブを検索
        </Button>
        <Link
          href={`${discoveryIndexHref({ ...query, jobQuery: "", jobStatus: "", jobProvider: "", jobsPage: 1 })}#jobs`}
          scroll={false}
          className="py-2 text-sm text-primary underline"
        >
          収集ジョブの条件を解除
        </Link>
      </fieldset>
    </Form>
  );
}
export function DiscoveryIndexPagination({
  query,
  kind,
  page,
  pages,
  total,
}: {
  query: DiscoveryIndexQuery;
  kind: "companies" | "jobs";
  page: number;
  pages: number;
  total: number;
}) {
  const key = kind === "companies" ? "companyPage" : "jobsPage";
  return (
    <nav
      aria-label={kind === "companies" ? "企業候補のページ" : "収集ジョブのページ"}
      className="flex flex-wrap items-center gap-4 text-sm"
    >
      <span>
        {total}件 · {page} / {pages}ページ（20件ずつ）
      </span>
      {page > 1 && (
        <Link
          href={`${discoveryIndexHref({ ...query, [key]: page - 1 })}#${kind}`}
          scroll={false}
          className="text-primary underline"
        >
          前の20件
        </Link>
      )}
      {page < pages && (
        <Link
          href={`${discoveryIndexHref({ ...query, [key]: page + 1 })}#${kind}`}
          scroll={false}
          className="text-primary underline"
        >
          次の20件
        </Link>
      )}
    </nav>
  );
}
