import type { findings as findingsTable, siteAudits } from "@siteoffer/db";
import { FindingSections } from "@/components/audit/finding-sections";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
  scored: "採点",
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
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 [&_dd]:break-words [&_dt]:text-muted-foreground [&_dt]:text-xs">
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
              {audit.decisionReason ? <div className="mt-1 text-muted-foreground">{audit.decisionReason}</div> : null}
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
        <summary className="cursor-pointer font-medium text-sm">集計（score.py の summary）</summary>
        <Json value={audit.summary} />
      </details>
      <h3 className="pt-2 font-semibold text-base">項目ごとの根拠（{findings.length}件）</h3>
      <FindingSections findings={findings} renderList={(items) => <FindingTable findings={items} />} />
    </div>
  );
}

function FindingTable({ findings }: { findings: Finding[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>項目</TableHead>
          <TableHead>結果</TableHead>
          <TableHead>レベル</TableHead>
          <TableHead>理由</TableHead>
          <TableHead>観測事実（URL・日時・根拠）</TableHead>
          <TableHead>改善案</TableHead>
          <TableHead>推測</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {findings.map((f) => (
          <TableRow key={f.id}>
            <TableCell className="whitespace-nowrap font-mono text-xs">
              {f.itemCode}
              {f.critical ? <span className="font-sans text-destructive">（致命）</span> : null}
            </TableCell>
            <TableCell>
              <StatusBadge
                value={f.status}
                labels={FINDING_STATUS}
                tone={f.status === "scored" ? "secondary" : f.status === "unevaluable" ? "warning" : "outline"}
              />
            </TableCell>
            <TableCell className="tabular-nums">{f.score ?? "—"}</TableCell>
            <TableCell className="min-w-48">{f.reason ?? "—"}</TableCell>
            <TableCell className="min-w-56 max-w-96">
              <Json value={f.observations} />
            </TableCell>
            <TableCell className="min-w-48">{f.improvementHint ?? "—"}</TableCell>
            <TableCell>
              <Badge variant={f.inference ? "warning" : "outline"}>{f.inference ? "推測" : "観測"}</Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
