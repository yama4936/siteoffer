import { systemClock } from "@siteoffer/core";
import { readSkillPage, SCHEDULE_INTERVAL_HOURS, SKILL_LABEL, type SkillPage } from "@siteoffer/worker/skills";
import { Play, RefreshCw, RotateCcw, Save, X } from "lucide-react";
import Link from "next/link";
import { Flash, ReturnTo } from "@/components/ops/ui";
import { StatusBadge } from "@/components/ops/ui-parts-1";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader, Section } from "@/components/ui/page";
import { NativeSelect } from "@/components/ui/select";
import { getDb } from "@/lib/db";
import { fmtDate, JOB_STATUS_LABEL, shortId } from "@/lib/ops/format";
import { requireUser } from "@/lib/session";
import {
  cancelSkillRunAction,
  requestSkillRunAction,
  retrySkillRunAction,
  saveSkillScheduleAction,
} from "../actions";

const HERE = "/ops/skills";
const OUTCOME_LABEL: Record<string, string> = {
  completed: "作成",
  skipped: "対象外・作成なし",
  blocked: "材料不足で停止",
};
const TRIGGER_LABEL: Record<string, string> = { manual: "運営", schedule: "定期", chain: "連鎖" };

type Run = SkillPage["runs"][number];

function score(v: string | null) {
  return v === null ? "点数なし" : `${Number(v)}点`;
}

function ChainCheckbox({ label, defaultChecked = true }: { label: string; defaultChecked?: boolean }) {
  return (
    <Label className="flex min-h-11 items-center gap-2 font-normal">
      <input type="checkbox" name="chain" defaultChecked={defaultChecked} className="size-4" />
      {label}
    </Label>
  );
}

function RunCard({ run }: { run: Run }) {
  const result = run.result ?? {};
  const imported = (result.imported ?? null) as Record<string, unknown> | null;
  return (
    <li className="rounded-lg border bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge value={run.status} labels={JOB_STATUS_LABEL} />
        <span className="font-medium">{SKILL_LABEL[run.skill]}</span>
        {run.companyId ? (
          <Link className="text-primary underline" href={`/ops/companies/${run.companyId}`}>
            {run.companyName ?? "企業"}
          </Link>
        ) : null}
        <span className="text-muted-foreground text-xs">
          {TRIGGER_LABEL[run.trigger] ?? run.trigger}・{shortId(run.id)}・登録 {fmtDate(run.createdAt)}
          {run.finishedAt ? `・終了 ${fmtDate(run.finishedAt)}` : run.startedAt ? `・開始 ${fmtDate(run.startedAt)}` : ""}
        </span>
      </div>
      {result.outcome ? (
        <p className="mt-2 text-sm">結果：{OUTCOME_LABEL[result.outcome] ?? result.outcome}</p>
      ) : null}
      {result.summary ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-muted-foreground text-sm">{result.summary}</p>
      ) : null}
      {run.error ? <p className="mt-2 break-words text-destructive text-sm">{run.error}</p> : null}
      {imported ? (
        <p className="mt-2 text-xs">
          {"discoveryJobId" in imported
            ? `収集ジョブ ${shortId(String(imported.discoveryJobId))}：候補${imported.found}件（新規${imported.created}・更新${imported.updated}・スキップ${imported.skipped}・失敗${imported.failed}）`
            : "auditId" in imported
              ? `評価を取り込み：${imported.totalScore ?? "点数なし"}点・判定 ${imported.decision ?? "—"}`
              : "proposalVersionId" in imported
                ? `提案版 v${imported.version}（${imported.status === "in_review" ? "運営確認待ち" : String(imported.status)}）`
                : "proposal" in imported
                  ? imported.proposal
                    ? "提案書を作成"
                    : "提案書なし"
                  : null}
        </p>
      ) : null}
      {result.chainedRunIds?.length ? (
        <p className="mt-1 text-xs">続けて {result.chainedRunIds.length}件の実行を登録しました</p>
      ) : null}
      <p className="mt-1 text-muted-foreground text-xs">
        {result.outputDir ? `成果物：reports/${result.outputDir}` : null}
        {run.status !== "queued" && run.status !== "running"
          ? `${result.outputDir ? "・" : ""}要求モデル：${result.requestedModel ?? "既定（SDK・CLI）"}`
          : null}
      </p>
      {run.status === "queued" || run.status === "failed" || run.status === "cancelled" ? (
        <form
          action={run.status === "queued" ? cancelSkillRunAction : retrySkillRunAction}
          className="mt-3"
        >
          <ReturnTo path={HERE} />
          <input type="hidden" name="runId" value={run.id} />
          <Button type="submit" variant="outline" size="sm">
            {run.status === "queued" ? <X /> : <RotateCcw />}
            {run.status === "queued" ? "取り消す" : "同じ条件で再実行"}
          </Button>
        </form>
      ) : null}
    </li>
  );
}

export default async function SkillsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser("ops");
  const sp = await searchParams;
  const page = await readSkillPage(getDb(), systemClock);
  const { candidates } = page;
  const active = page.runs.filter((r) => r.status === "queued" || r.status === "running").length;

  return (
    <>
      <PageHeader
        title="スキルの実行"
        description="企業候補の探索・サイトの評価・改善提案書・改善後サイトの作成を、ワーカーの隔離コンテナで Codex SDK に実行させます。結果はDBへ取り込み、提案版は運営確認待ちになります。"
        actions={
          <a href={HERE} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <RefreshCw />
            最新の状態を表示
          </a>
        }
      />
      <Flash searchParams={sp} />
      <div
        className={`mb-6 rounded-lg border p-4 text-sm ${page.availability.ready ? "bg-white" : "border-amber-300 bg-amber-50"}`}
      >
        <p className="font-medium">{page.availability.ready ? "実行できます" : "実行するワーカーがありません"}</p>
        <p className="mt-1 text-muted-foreground">{page.availability.reason}</p>
        <p className="mt-1 text-muted-foreground">
          実行のたびにCodexの利用量がかかります。企業への連絡・公開はしません。スキルが材料不足や対象外と判断した場合は、作らずに理由を残します。
        </p>
      </div>

      <Section title="実行する" id="run">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>{SKILL_LABEL["company-discovery"]}</h2>
              </CardTitle>
              <CardDescription>
                公開Webで企業候補を探し、出典付きで収集ジョブとして取り込みます。空欄の条件はスキルが選び、理由を残します（エージェントの調査による手動取り込み扱い）。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form action={requestSkillRunAction} className="grid gap-3 sm:grid-cols-2">
                <ReturnTo path={HERE} />
                <input type="hidden" name="skill" value="company-discovery" />
                <Label className="grid gap-1.5">
                  都道府県（任意）
                  <Input name="prefecture" placeholder="愛知県" className="font-normal" />
                </Label>
                <Label className="grid gap-1.5">
                  市区町村（任意）
                  <Input name="city" placeholder="名古屋市" className="font-normal" />
                </Label>
                <Label className="grid gap-1.5">
                  業種（任意）
                  <Input name="industry" placeholder="工務店" className="font-normal" />
                </Label>
                <Label className="grid gap-1.5">
                  件数（1〜30）
                  <Input name="count" type="number" min={1} max={30} defaultValue={10} className="font-normal" />
                </Label>
                <div className="sm:col-span-2">
                  <ChainCheckbox label="見つけた企業を続けて評価する（評価の判定が作成対象なら提案書・サイト作成まで）" />
                </div>
                <div className="sm:col-span-2">
                  <Button type="submit">
                    <Play />
                    探索を実行
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <h2>{SKILL_LABEL["site-evaluation"]}</h2>
              </CardTitle>
              <CardDescription>
                まだ評価のない企業（公式サイト確認済み・候補）の公式サイトを評価し、評価結果を取り込みます。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form action={requestSkillRunAction} className="grid gap-3">
                <ReturnTo path={HERE} />
                <input type="hidden" name="skill" value="site-evaluation" />
                <Label className="grid gap-1.5">
                  企業
                  <NativeSelect name="companyId" required defaultValue="" className="font-normal">
                    <option value="" disabled>
                      {candidates.evaluation.length ? "評価する企業を選択" : "評価できる企業がありません"}
                    </option>
                    {candidates.evaluation.map((c) => (
                      <option key={c.companyId} value={c.companyId} disabled={!!c.busy}>
                        {c.name}
                        {c.prefecture ? `（${[c.prefecture, c.city].filter(Boolean).join(" ")}）` : ""}
                        {c.busy ? "・実行中" : ""}
                      </option>
                    ))}
                  </NativeSelect>
                </Label>
                <ChainCheckbox label="判定が作成対象なら、続けて提案書・サイト作成まで行う" />
                <div>
                  <Button type="submit" disabled={!candidates.evaluation.length}>
                    <Play />
                    評価を実行
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <h2>{SKILL_LABEL["site-proposal"]}</h2>
              </CardTitle>
              <CardDescription>
                判定が作成対象（閾値未満・致命項目あり）で提案書のない評価から、改善提案書を作ります。点数の低い順です。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form action={requestSkillRunAction} className="grid gap-3">
                <ReturnTo path={HERE} />
                <input type="hidden" name="skill" value="site-proposal" />
                <Label className="grid gap-1.5">
                  評価
                  <NativeSelect name="auditId" required defaultValue="" className="font-normal">
                    <option value="" disabled>
                      {candidates.proposal.length ? "提案書を作る評価を選択" : "対象の評価がありません"}
                    </option>
                    {candidates.proposal.map((a) => (
                      <option key={a.auditId} value={a.auditId} disabled={!!a.busy}>
                        {a.name}（{score(a.totalScore)}）{a.busy ? "・実行中" : ""}
                      </option>
                    ))}
                  </NativeSelect>
                </Label>
                <ChainCheckbox label="続けて改善後サイトを作る" />
                <div>
                  <Button type="submit" disabled={!candidates.proposal.length}>
                    <Play />
                    提案書を作成
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <h2>{SKILL_LABEL["site-rebuild"]}</h2>
              </CardTitle>
              <CardDescription>
                提案書があり改善後サイトのない評価から、改善デモを作り、運営確認待ちの提案版として取り込みます。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form action={requestSkillRunAction} className="grid gap-3">
                <ReturnTo path={HERE} />
                <input type="hidden" name="skill" value="site-rebuild" />
                <Label className="grid gap-1.5">
                  評価
                  <NativeSelect name="auditId" required defaultValue="" className="font-normal">
                    <option value="" disabled>
                      {candidates.rebuild.length ? "サイトを作る評価を選択" : "対象の評価がありません"}
                    </option>
                    {candidates.rebuild.map((a) => (
                      <option key={a.auditId} value={a.auditId} disabled={!!a.busy}>
                        {a.name}（{score(a.totalScore)}）{a.busy ? "・実行中" : ""}
                      </option>
                    ))}
                  </NativeSelect>
                </Label>
                <div>
                  <Button type="submit" disabled={!candidates.rebuild.length}>
                    <Play />
                    サイトを作成
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section
        title="実行の履歴"
        id="runs"
        description={`最近の60件。${active ? `受付待ち・実行中が${active}件あります。` : ""}受付待ちは取り消せます。失敗・取り消しは同じ条件で再実行できます。`}
      >
        {page.runs.length ? (
          <ul className="grid gap-3">
            {page.runs.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">まだ実行はありません。</p>
        )}
      </Section>

      <Section
        title="定期実行"
        id="schedules"
        description="既定は無効です。有効にすると、保存した時点から間隔をおいて実行を登録します。評価・提案書・サイト作成は、1回あたりの件数だけ対象を選んで登録します（対象がなければ何もしません）。頻度・件数の上限は未決のため、費用を確認しながら設定してください。"
      >
        <div className="grid gap-4 lg:grid-cols-2">
          {page.schedules.map((s) => (
            <Card key={s.skill}>
              <CardHeader>
                <CardTitle>
                  <h3>{SKILL_LABEL[s.skill]}</h3>
                </CardTitle>
                <CardDescription>
                  {s.enabled ? `有効・次回 ${fmtDate(s.nextRunAt)}` : "無効"}
                  {s.lastRunAt ? `・前回 ${fmtDate(s.lastRunAt)}` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form action={saveSkillScheduleAction} className="grid gap-3 sm:grid-cols-2">
                  <ReturnTo path={`${HERE}#schedules`} />
                  <input type="hidden" name="skill" value={s.skill} />
                  <Label className="flex min-h-11 items-center gap-2 font-normal sm:col-span-2">
                    <input type="checkbox" name="enabled" defaultChecked={s.enabled} className="size-4" />
                    定期実行を有効にする
                  </Label>
                  <Label className="grid gap-1.5">
                    間隔（時間）
                    <Input
                      name="intervalHours"
                      type="number"
                      min={SCHEDULE_INTERVAL_HOURS.min}
                      max={SCHEDULE_INTERVAL_HOURS.max}
                      defaultValue={s.intervalHours}
                      className="font-normal"
                    />
                  </Label>
                  {s.skill === "company-discovery" ? (
                    <>
                      <Label className="grid gap-1.5">
                        件数（1〜30）
                        <Input
                          name="count"
                          type="number"
                          min={1}
                          max={30}
                          defaultValue={Number(s.params.count ?? 10)}
                          className="font-normal"
                        />
                      </Label>
                      <Label className="grid gap-1.5">
                        都道府県（任意）
                        <Input name="prefecture" defaultValue={String(s.params.prefecture ?? "")} className="font-normal" />
                      </Label>
                      <Label className="grid gap-1.5">
                        市区町村（任意）
                        <Input name="city" defaultValue={String(s.params.city ?? "")} className="font-normal" />
                      </Label>
                      <Label className="grid gap-1.5 sm:col-span-2">
                        業種（任意）
                        <Input name="industry" defaultValue={String(s.params.industry ?? "")} className="font-normal" />
                      </Label>
                    </>
                  ) : (
                    <Label className="grid gap-1.5">
                      1回の件数
                      <Input
                        name="limit"
                        type="number"
                        min={1}
                        max={s.skill === "site-rebuild" ? 10 : 20}
                        defaultValue={Number(s.params.limit ?? 1)}
                        className="font-normal"
                      />
                    </Label>
                  )}
                  {s.skill !== "site-rebuild" ? (
                    <div className="sm:col-span-2">
                      <ChainCheckbox
                        label={s.skill === "site-proposal" ? "続けて改善後サイトを作る" : "続けて次の工程まで行う"}
                        defaultChecked={s.params.chain === true}
                      />
                    </div>
                  ) : null}
                  <div className="sm:col-span-2">
                    <Button type="submit" variant="outline">
                      <Save />
                      保存
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          ))}
        </div>
      </Section>
    </>
  );
}
