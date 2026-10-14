import type { findings as findingsTable, siteAudits } from "@siteoffer/db";
import { fmtDate } from "@/lib/ops/format";
import { Json } from "./ui";

type Audit = typeof siteAudits.$inferSelect;
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
    <div>
      <table>
        <tbody>
          <tr>
            <th>状態</th>
            <td>{AUDIT_STATUS[audit.status] ?? audit.status}</td>
            <th>対象URL</th>
            <td>
              {audit.targetUrl}
              {audit.finalUrl && audit.finalUrl !== audit.targetUrl ? <div>→ {audit.finalUrl}</div> : null}
            </td>
          </tr>
          <tr>
            <th>総合点</th>
            <td>
              {audit.totalScore ?? "—"}
              {audit.scoreConfirmed === false ? <span className="warn">（カバー率不足のため未確定）</span> : null}
            </td>
            <th>カバー率</th>
            <td>{pct(audit.coverage)}</td>
          </tr>
          <tr>
            <th>提案書の判定</th>
            <td>
              {audit.decision ? (DECISION[audit.decision] ?? audit.decision) : "—"}
              {audit.decisionReason ? <div className="muted">{audit.decisionReason}</div> : null}
            </td>
            <th>評価基準の版</th>
            <td>{audit.rubricVersion ?? "—"}</td>
          </tr>
          <tr>
            <th>取得・評価日時</th>
            <td>
              {fmtDate(audit.fetchedAt)} / {fmtDate(audit.evaluatedAt)}
            </td>
            <th>採点のモデル</th>
            <td>{audit.evaluatorModel ?? "未記録"}</td>
          </tr>
          {audit.unevaluableReason || audit.failureReason ? (
            <tr>
              <th>評価不能・失敗の理由</th>
              <td colSpan={3} className="warn">
                {audit.unevaluableReason ?? audit.failureReason}
              </td>
            </tr>
          ) : null}
          <tr>
            <th>致命項目</th>
            <td colSpan={3}>
              {flags.length === 0
                ? "なし"
                : flags.map((f, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 表示専用の静的な一覧
                    <div key={i} className="warn">
                      {f.id ?? "?"}
                      {f.reason ? `：${f.reason}` : ""}
                    </div>
                  ))}
            </td>
          </tr>
        </tbody>
      </table>
      <details>
        <summary>集計（score.py の summary）</summary>
        <Json value={audit.summary} />
      </details>
      <h3>項目ごとの根拠（{findings.length}件）</h3>
      <table>
        <thead>
          <tr>
            <th>項目</th>
            <th>結果</th>
            <th>レベル</th>
            <th>理由</th>
            <th>観測事実（URL・日時・根拠）</th>
            <th>改善案</th>
            <th>推測</th>
          </tr>
        </thead>
        <tbody>
          {findings.map((f) => (
            <tr key={f.id}>
              <td>
                {f.itemCode}
                {f.critical ? <span className="warn">（致命）</span> : null}
              </td>
              <td>{FINDING_STATUS[f.status] ?? f.status}</td>
              <td>{f.score ?? "—"}</td>
              <td>{f.reason ?? "—"}</td>
              <td>
                <Json value={f.observations} />
              </td>
              <td>{f.improvementHint ?? "—"}</td>
              <td>{f.inference ? "推測" : "観測"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
