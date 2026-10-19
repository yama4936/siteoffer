import type { findings as findingsTable, siteAudits } from "@siteoffer/db";
import { isReadableDiagnosticText } from "@siteoffer/schemas";
import { FindingSections } from "@/components/audit/finding-sections";
import { Observations } from "@/components/audit/observations";
import { Badge } from "@/components/ui/badge";
import { findingLabel } from "@/lib/audit/item-labels";
import { fmtDate } from "@/lib/ops/format";
import { Json } from "./ui";
import { StatusBadge } from "./ui-parts-1";

type Audit = Omit<typeof siteAudits.$inferSelect, "artifactDir" | "generationJobId">;
type Finding = typeof findingsTable.$inferSelect;

const AUDIT_STATUS: Record<string, string> = {
  queued: "待機",
  collecting: "取得中",
  scoring: "採点中",
  evaluated: "評価済み",
  unevaluable: "評価不能",
  failed: "失敗",
};

const DECISION: Record<string, string> = {
  create: "提案書を作る",
  skip: "作らない",
  hold: "判定保留",
};

const FINDING_STATUS: Record<string, string> = {
  scored: "採点済み",
  unevaluable: "評価不能",
  not_applicable: "対象外",
};

function pct(v: string | null): string {
  if (v === null) return "—";
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.round(n * 1000) / 10}%` : v;
}

/**
 * 診断結果（AC-05）：点数・カバー率・判定・致命項目・各項目の根拠。
 * 評価不能は低評価に置き換えず、評価不能として表示する（9章）。点数だけで営業先の良し悪しを断定しない。
 */
export function AuditView({ audit, findings }: { audit: Audit; findings: Finding[] }) {
  const flags = Array.isArray(audit.criticalFlags) ? (audit.criticalFlags as { id?: string; reason?: string }[]) : [];
  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-4 shadow-xs">
        <dl className="grid items-start gap-x-6 gap-y-3 text-sm sm:grid-cols-2 [&_dd]:break-words [&_dt]:text-muted-foreground [&_dt]:text-xs">
          <div className="grid gap-1">
            <dt>状態</dt>
            <dd>
              <StatusBadge value={audit.status} labels={AUDIT_STATUS} />
            </dd>
          </div>
          <div className="grid gap-1">
            <dt>対象URL</dt>
            <dd className="break-all">
              {audit.targetUrl}
              {audit.finalUrl && audit.finalUrl !== audit.targetUrl ? (
                <div className="text-muted-foreground">→ {audit.finalUrl}</div>
              ) : null}
            </dd>
          </div>
          <div className="grid gap-1">
            <dt>総合点</dt>
            <dd>
              <span className="font-semibold text-lg tabular-nums">{audit.totalScore ?? "—"}</span>
              {audit.scoreConfirmed === false ? (
                <span className="ml-1 text-warning-foreground">（カバー率不足のため未確定）</span>
              ) : null}
            </dd>
          </div>
          <div className="grid gap-1">
            <dt>カバー率</dt>
            <dd className="font-semibold text-lg tabular-nums">{pct(audit.coverage)}</dd>
          </div>
          <div className="grid gap-1">
            <dt>提案書の判定</dt>
            <dd>
              {audit.decision ? (
                <StatusBadge
                  value={audit.decision}
                  labels={DECISION}
                  tone={audit.decision === "create" ? "success" : audit.decision === "hold" ? "warning" : "secondary"}
                />
              ) : (
                "—"
              )}
              {audit.decisionReason ? (
                isReadableDiagnosticText(audit.decisionReason) ? (
                  <div className="mt-1 whitespace-pre-wrap text-muted-foreground">{audit.decisionReason}</div>
                ) : (
                  <section
                    aria-label="判定理由の記録を確認"
                    className="mt-2 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"
                  >
                    <p className="font-medium">判定理由の文字を正しく読み取れません。</p>
                    <p>保存時の原資料を確認してください。保存済みの文章はそのまま保持しています。</p>
                    <details>
                      <summary className="cursor-pointer underline">保存されている原文を表示</summary>
                      <p className="mt-2 break-all whitespace-pre-wrap text-xs">{audit.decisionReason}</p>
                    </details>
                  </section>
                )
              ) : null}
            </dd>
          </div>
          <div className="grid gap-1">
            <dt>評価基準の版</dt>
            <dd>{audit.rubricVersion ?? "—"}</dd>
          </div>
          <div className="grid gap-1">
            <dt>取得・評価日時</dt>
            <dd className="tabular-nums">
              {fmtDate(audit.fetchedAt)} / {fmtDate(audit.evaluatedAt)}
            </dd>
          </div>
          <div className="grid gap-1">
            <dt>採点のモデル</dt>
            <dd>{audit.evaluatorModel ?? "未記録"}</dd>
          </div>
          {audit.unevaluableReason || audit.failureReason ? (
            <div className="grid gap-1 sm:col-span-2">
              <dt>評価不能・失敗の理由</dt>
              <dd className="text-warning-foreground">{audit.unevaluableReason ?? audit.failureReason}</dd>
            </div>
          ) : null}
          <div className="grid gap-1 sm:col-span-2">
            <dt>致命項目</dt>
            <dd>
              {flags.length === 0 ? (
                "なし"
              ) : (
                <ul className="grid gap-1">
                  {flags.map((f, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 表示専用の静的な一覧
                    <li key={i} className="text-destructive">
                      {f.id ?? "?"}
                      {f.reason ? `：${f.reason}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        </dl>
      </div>
      <details className="rounded-lg border bg-card px-4 py-3 [&[open]>summary]:mb-3">
        <summary className="cursor-pointer font-medium text-sm">診断集計の詳細</summary>
        <Json value={audit.summary} />
      </details>
      <h3 className="pt-2 font-semibold text-base">項目ごとの根拠（{findings.length}件）</h3>
      <FindingSections
        findings={findings}
        renderList={(items) => <FindingCards findings={items} rubricVersion={audit.rubricVersion} />}
      />
    </div>
  );
}

function FindingCards({ findings, rubricVersion }: { findings: Finding[]; rubricVersion: string | null }) {
  return (
    <div className="grid gap-3">
      {findings.map((f) => (
        <article
          key={f.id}
          aria-label={`${f.itemCode}の診断結果`}
          className={`min-w-0 overflow-hidden rounded-xl border bg-card text-sm shadow-xs ${f.critical ? "border-l-4 border-l-destructive" : ""}`}
        >
          <header className="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-4 py-3">
            <h4 className="font-semibold">{findingLabel(f.itemCode, rubricVersion) ?? f.itemCode}</h4>
            {findingLabel(f.itemCode, rubricVersion) && (
              <span className="font-mono text-muted-foreground text-xs">{f.itemCode}</span>
            )}
            {f.critical && <Badge variant="destructive">致命項目</Badge>}
            <span className="font-medium tabular-nums">レベル {f.score ?? "未記録"}</span>
            <StatusBadge
              value={f.status}
              labels={FINDING_STATUS}
              tone={f.status === "scored" ? "secondary" : f.status === "unevaluable" ? "warning" : "outline"}
            />
            <Badge variant={f.inference ? "warning" : "outline"}>{f.inference ? "推測を含む" : "観測"}</Badge>
          </header>
          <div className="grid min-w-0 gap-4 p-4 lg:grid-cols-2 lg:gap-6">
            <dl className="min-w-0 space-y-4 [&_dd]:break-words [&_dd]:whitespace-pre-wrap [&_dd]:leading-relaxed [&_dt]:mb-1 [&_dt]:font-medium [&_dt]:text-muted-foreground [&_dt]:text-xs">
              <div>
                <dt>判定理由</dt>
                <dd>{f.reason ?? "判定理由は未記録です。"}</dd>
              </div>
              {f.improvementHint && (
                <div className="rounded-lg border border-blue-100 bg-blue-50/50 p-3">
                  <dt>改善案</dt>
                  <dd>{f.improvementHint}</dd>
                </div>
              )}
            </dl>
            <div className="min-w-0 space-y-2">
              <h5 className="font-medium text-muted-foreground text-xs">確認した根拠</h5>
              <Observations value={f.observations} />
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
