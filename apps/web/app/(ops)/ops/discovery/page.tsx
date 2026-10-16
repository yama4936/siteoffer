import { systemClock } from "@siteoffer/core";
import { discoveryAvailability } from "@siteoffer/discovery";
import { Filter, Plus, RefreshCw } from "lucide-react";
import Link from "next/link";
import { DiscoveryRefresh } from "@/components/ops/discovery-refresh";
import { DiscoveryStatus } from "@/components/ops/discovery-status";
import { Flash, Forbidden, first, ReturnTo } from "@/components/ops/ui";
import { StatusBadge } from "@/components/ops/ui-parts-1";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Muted, PageHeader, Section } from "@/components/ui/page";
import { NativeSelect } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { DISCOVERY_PROVIDERS } from "@/lib/ops/commands";
import {
  fmtDate,
  JOB_STATUS_LABEL,
  label,
  OFFICIAL_SITE_LABEL,
  PIPELINE_LABEL,
  SUPPRESSION_LABEL,
  shortId,
} from "@/lib/ops/format";
import { type CompanyFilter, listCompanies, listDiscoveryJobs } from "@/lib/ops/queries";
import { getCurrentActor } from "@/lib/session";
import { createDiscoveryJobAction } from "../actions";

function oneOf(map: Record<string, string>, v: string | undefined): string | undefined {
  return v && Object.hasOwn(map, v) ? v : undefined;
}

export default async function DiscoveryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  const db = getDb();
  const filter: CompanyFilter = {
    q: first(sp, "q") || undefined,
    prefecture: first(sp, "prefecture") || undefined,
    // 列挙値以外はDBに渡さない
    pipelineStatus: oneOf(PIPELINE_LABEL, first(sp, "pipeline")) as CompanyFilter["pipelineStatus"],
    officialSiteStatus: oneOf(OFFICIAL_SITE_LABEL, first(sp, "official")) as CompanyFilter["officialSiteStatus"],
    suppressed: first(sp, "suppressed") === "yes" ? true : first(sp, "suppressed") === "no" ? false : undefined,
  };
  const jobs = await listDiscoveryJobs(db, actor);
  const cs = await listCompanies(db, actor, filter);
  if (!jobs.ok || !cs.ok) return <Forbidden />;
  const qs = new URLSearchParams(
    Object.entries(sp).flatMap(([k, v]) => (typeof v === "string" && k !== "msg" && k !== "error" ? [[k, v]] : [])),
  ).toString();
  const here = `/ops/discovery${qs ? `?${qs}` : ""}`;

  const capabilities = await discoveryAvailability(getDb(), systemClock);
  return (
    <>
      <PageHeader title="企業・案件" description="候補の収集と企業情報を管理します。" />
      <Flash searchParams={sp} />
      <DiscoveryRefresh />
      <DiscoveryStatus capabilities={capabilities} />

      <Card className="mb-8 max-w-3xl">
        <CardHeader>
          <CardTitle>
            <h2>収集ジョブの登録</h2>
          </CardTitle>
          <CardDescription>
            条件を保存してジョブを登録します。実行はワーカーが行います。業種分類は未決のため自由記述です。
            所在地はキーワードではなく出典のある住所で判定されます。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={createDiscoveryJobAction} className="grid gap-4 sm:grid-cols-2">
            <ReturnTo path="/ops/discovery" />
            <Label className="grid gap-1.5 sm:col-span-2">
              取得元
              <NativeSelect
                name="provider"
                defaultValue={capabilities.find((p) => p.ready)?.provider ?? ""}
                className="font-normal"
              >
                <option value="" disabled>
                  利用できる取得元を選択
                </option>
                {DISCOVERY_PROVIDERS.map((p) => (
                  <option key={p} value={p} disabled={!capabilities.find((c) => c.provider === p)?.ready}>
                    {p === "fixture" ? "fixture（架空企業・開発用）" : `${p}（国税庁法人番号API）`}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            <Label className="grid gap-1.5">
              都道府県
              <Input name="prefecture" placeholder="愛知県" className="font-normal" />
            </Label>
            <Label className="grid gap-1.5 leading-snug">
              市区町村（前方一致。指定するときは都道府県も必須）
              <Input name="city" placeholder="名古屋市" className="font-normal" />
            </Label>
            <Label className="grid gap-1.5">
              市区町村コード（5桁・任意）
              <Input name="cityCode" inputMode="numeric" pattern="\d{5}" className="font-normal" />
            </Label>
            <Label className="grid gap-1.5">
              業種
              <Input name="industry" placeholder="建設" className="font-normal" />
            </Label>
            <Label className="grid gap-1.5 leading-snug sm:col-span-2">
              企業名に含まれる語（空白・読点区切り。所在地の判定には使いません）
              <Input name="keywords" className="font-normal" />
            </Label>
            <Label className="grid gap-1.5">
              上限件数（1〜1000、既定50）
              <Input name="limit" type="number" min={1} max={1000} className="font-normal" />
            </Label>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={!capabilities.some((p) => p.ready)}>
                <Plus />
                ジョブを登録
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Section
        title="収集ジョブ"
        actions={
          <a href={here} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <RefreshCw />
            再読み込みして最新の状態を表示
          </a>
        }
      >
        <p className="text-muted-foreground text-sm">
          収集結果と停止理由は自動更新されます。成功しても0件の場合があります。
          国税庁の収集結果は法人情報です。公式サイトの確認・診断・デザイン承認は、それぞれの段階で進めます。
          {jobs.value.some((j) => j.status === "queued" || j.status === "running") ? (
            <strong className="font-medium text-warning-foreground"> 処理中のジョブがあります。</strong>
          ) : null}
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>取得元</TableHead>
              <TableHead>条件</TableHead>
              <TableHead>状態</TableHead>
              <TableHead>件数（取得/新規/更新/スキップ/失敗）</TableHead>
              <TableHead>試行</TableHead>
              <TableHead>失敗理由</TableHead>
              <TableHead>登録・終了</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.value.map((j) => (
              <TableRow key={j.id}>
                <TableCell className="font-mono text-xs">
                  <Link href={`/ops/discovery/${j.id}`}>{shortId(j.id)}</Link>
                </TableCell>
                <TableCell>{j.provider}</TableCell>
                <TableCell className="min-w-48 max-w-80">
                  <code className="break-all rounded bg-muted px-1 py-0.5 text-xs">{JSON.stringify(j.criteria)}</code>
                </TableCell>
                <TableCell>
                  <StatusBadge value={j.status} labels={JOB_STATUS_LABEL} />
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {j.foundCount}/{j.createdCount}/{j.updatedCount}/{j.skippedCount}/{j.failedCount}
                </TableCell>
                <TableCell className="tabular-nums">{j.attempts}</TableCell>
                <TableCell className="min-w-40">
                  {j.error ? <span className="text-destructive">{j.error}</span> : null}
                  {Array.isArray(j.failures) && j.failures.length > 0 ? (
                    <span className="text-muted-foreground"> 候補の失敗・スキップ {j.failures.length}件</span>
                  ) : null}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs tabular-nums">
                  {fmtDate(j.createdAt)}
                  <br />
                  {fmtDate(j.finishedAt)}
                </TableCell>
              </TableRow>
            ))}
            {jobs.value.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                  ジョブはまだありません
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </Section>

      <Section title="企業候補">
        <form className="flex flex-wrap items-center gap-2" method="get" action="/ops/discovery">
          <Input
            name="q"
            placeholder="企業名・法人番号"
            defaultValue={filter.q ?? ""}
            aria-label="企業名・法人番号"
            className="w-full sm:w-56"
          />
          <Input
            name="prefecture"
            placeholder="都道府県"
            defaultValue={filter.prefecture ?? ""}
            aria-label="都道府県"
            className="w-full sm:w-36"
          />
          <NativeSelect
            name="official"
            defaultValue={filter.officialSiteStatus ?? ""}
            aria-label="公式サイト"
            className="w-auto"
          >
            <option value="">公式サイト：すべて</option>
            {Object.entries(OFFICIAL_SITE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect
            name="pipeline"
            defaultValue={filter.pipelineStatus ?? ""}
            aria-label="準備段階"
            className="w-auto"
          >
            <option value="">準備段階：すべて</option>
            {Object.entries(PIPELINE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect
            name="suppressed"
            defaultValue={first(sp, "suppressed") ?? ""}
            aria-label="抑止"
            className="w-auto"
          >
            <option value="">抑止：すべて</option>
            <option value="no">抑止なし</option>
            <option value="yes">抑止あり</option>
          </NativeSelect>
          <Button type="submit" variant="secondary">
            <Filter />
            絞り込み
          </Button>
        </form>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>企業名</TableHead>
              <TableHead>法人番号</TableHead>
              <TableHead>所在地</TableHead>
              <TableHead>業種</TableHead>
              <TableHead>公式サイト</TableHead>
              <TableHead>準備段階</TableHead>
              <TableHead>営業抑止</TableHead>
              <TableHead>更新</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cs.value.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="min-w-40 font-medium">
                  <Link href={`/ops/companies/${c.id}?returnTo=${encodeURIComponent(here)}`}>{c.name}</Link>
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">{c.corporateNumber ?? "不明"}</TableCell>
                <TableCell className="min-w-32">
                  {[c.prefecture, c.city].filter(Boolean).join(" ") || "不明"}
                  {c.addressSourceUrl ? null : c.prefecture ? (
                    <span className="text-muted-foreground text-xs">（出典なし）</span>
                  ) : null}
                </TableCell>
                <TableCell>{c.industry ?? "不明"}</TableCell>
                <TableCell>
                  <StatusBadge value={c.officialSiteStatus} labels={OFFICIAL_SITE_LABEL} />
                </TableCell>
                <TableCell>
                  <StatusBadge value={c.pipelineStatus} labels={PIPELINE_LABEL} />
                </TableCell>
                <TableCell>
                  {c.suppression === "none" ? (
                    <span className="text-muted-foreground">{label(SUPPRESSION_LABEL, c.suppression)}</span>
                  ) : (
                    <StatusBadge value={c.suppression} labels={SUPPRESSION_LABEL} tone="warning" />
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs tabular-nums">{fmtDate(c.updatedAt)}</TableCell>
              </TableRow>
            ))}
            {cs.value.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                  該当する候補はありません
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
        <p>
          <Muted>最大200件まで表示します。</Muted>
        </p>
      </Section>
    </>
  );
}
