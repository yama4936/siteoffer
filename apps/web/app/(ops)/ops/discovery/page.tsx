import { systemClock } from "@siteoffer/core";
import { discoveryAvailability } from "@siteoffer/discovery";
import { Plus, RefreshCw, Sparkles } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DiscoveryCompanyCards, DiscoveryJobCards } from "@/components/ops/discovery-index-cards";
import {
  DiscoveryCompanyFilters,
  DiscoveryIndexPagination,
  DiscoveryJobFilters,
} from "@/components/ops/discovery-index-navigation";
import { DiscoveryRefresh } from "@/components/ops/discovery-refresh";
import { DiscoveryStatus } from "@/components/ops/discovery-status";
import { Flash, Forbidden, ReturnTo } from "@/components/ops/ui";
import { StatusBadge } from "@/components/ops/ui-parts-1";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader, Section } from "@/components/ui/page";
import { NativeSelect } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { DISCOVERY_PROVIDERS } from "@/lib/ops/commands";
import { readDiscoveryIndex } from "@/lib/ops/discovery-index";
import { discoveryConditionText, discoveryIndexHref, parseDiscoveryIndexQuery } from "@/lib/ops/discovery-index-query";
import {
  fmtDate,
  JOB_STATUS_LABEL,
  label,
  OFFICIAL_SITE_LABEL,
  PIPELINE_LABEL,
  SUPPRESSION_LABEL,
  shortId,
} from "@/lib/ops/format";
import { getCurrentActor } from "@/lib/session";
import { createDiscoveryJobAction } from "../actions";

export default async function DiscoveryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  const db = getDb();
  const parsed = parseDiscoveryIndexQuery(sp);
  if (!parsed) notFound();
  const index = await readDiscoveryIndex(db, actor, parsed);
  if (!index.ok) return index.error === "forbidden" ? <Forbidden /> : notFound();
  const { jobs, companies: candidates, sourceJob, query } = index.value;
  const here = discoveryIndexHref(query);

  const capabilities = await discoveryAvailability(getDb(), systemClock);
  return (
    <>
      <PageHeader
        title="企業・案件"
        description="候補の収集と企業情報を管理します。"
        actions={
          <Link href="/ops/skills" className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Sparkles />
            スキルで探索・評価・提案を実行
          </Link>
        }
      />
      <Flash searchParams={sp} />
      <DiscoveryRefresh />
      <DiscoveryStatus capabilities={capabilities} />

      <details className="mb-8">
        <summary className="cursor-pointer rounded-lg border bg-white px-4 py-3 font-medium">新しい収集を登録</summary>
        <Card className="mt-4 max-w-3xl">
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
              <ReturnTo path={here} />
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
      </details>

      <Section
        title="収集ジョブ"
        id="jobs"
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
          {jobs.items.some((j) => j.status === "queued" || j.status === "running") ? (
            <strong className="font-medium text-warning-foreground"> このページに処理中のジョブがあります。</strong>
          ) : null}
        </p>
        <Link
          href="/sources"
          className="inline-flex min-h-11 items-center text-primary text-sm underline underline-offset-4"
        >
          企業情報の出典を確認
        </Link>
        <DiscoveryJobFilters query={query} />
        <DiscoveryIndexPagination query={query} kind="jobs" {...jobs} />
        <DiscoveryJobCards data={index.value} />
        <div className="hidden sm:block">
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
              {jobs.items.map((j) => (
                <TableRow key={j.id}>
                  <TableCell className="min-w-40 font-mono text-xs">
                    <Link href={`/ops/discovery/${j.id}?returnTo=${encodeURIComponent(`${here}#jobs`)}`}>
                      {shortId(j.id)}
                    </Link>
                    <Link
                      className="mt-2 block font-sans text-primary underline"
                      href={`${discoveryIndexHref({ ...query, sourceJob: j.id, companyPage: 1 })}#companies`}
                      scroll={false}
                    >
                      関連する企業を見る
                    </Link>
                  </TableCell>
                  <TableCell className="min-w-36">
                    {j.provider === "fixture"
                      ? "架空企業（開発用）"
                      : j.provider === "nta-corporate-number"
                        ? "国税庁法人番号API"
                        : j.provider}
                  </TableCell>
                  <TableCell className="min-w-48 max-w-80">
                    <p className="break-words text-sm">{discoveryConditionText(j.condition)}</p>
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={j.status} labels={JOB_STATUS_LABEL} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {j.foundCount}/{j.createdCount}/{j.updatedCount}/{j.skippedCount}/{j.failedCount}
                  </TableCell>
                  <TableCell className="tabular-nums">{j.attempts}</TableCell>
                  <TableCell className="min-w-40">
                    {j.hasError ? <span className="text-destructive">エラーあり。詳細で確認できます。</span> : null}
                    {j.failureCount > 0 ? (
                      <span className="text-muted-foreground"> 候補の失敗・スキップ {j.failureCount}件</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums">
                    {fmtDate(j.createdAt)}
                    <br />
                    {fmtDate(j.finishedAt)}
                  </TableCell>
                </TableRow>
              ))}
              {jobs.items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                    条件に合う収集ジョブはありません
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
        <DiscoveryIndexPagination query={query} kind="jobs" {...jobs} />
      </Section>

      <Section title="企業候補" id="companies">
        {sourceJob && (
          <div className="rounded-lg border bg-blue-50 p-4 text-sm">
            <p>
              収集 {shortId(sourceJob.id)}（{fmtDate(sourceJob.createdAt)}）に関連する企業を表示しています。
            </p>
            <p className="mt-1 text-muted-foreground">
              出典に現在紐づいている企業です。後の再収集で紐づきが変わる場合があり、収集時点の件数とは一致しないことがあります。
            </p>
            <Link
              className="mt-2 inline-block text-primary underline"
              href={`${discoveryIndexHref({ ...query, sourceJob: "", companyPage: 1 })}#companies`}
              scroll={false}
            >
              すべての収集の企業へ戻る
            </Link>
          </div>
        )}
        <DiscoveryCompanyFilters query={query} />
        <DiscoveryIndexPagination query={query} kind="companies" {...candidates} />
        <DiscoveryCompanyCards data={index.value} />
        <div className="hidden sm:block">
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
              {candidates.items.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="min-w-40 font-medium">
                    <Link href={`/ops/companies/${c.id}?returnTo=${encodeURIComponent(`${here}#companies`)}`}>
                      {c.name}
                    </Link>
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{c.corporateNumber ?? "不明"}</TableCell>
                  <TableCell className="min-w-32">
                    {[c.prefecture, c.city].filter(Boolean).join(" ") || "不明"}
                    {c.addressHasSource ? null : c.prefecture ? (
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
              {candidates.items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                    該当する候補はありません
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
        <DiscoveryIndexPagination query={query} kind="companies" {...candidates} />
      </Section>
    </>
  );
}
