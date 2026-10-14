// 営業画面の表示部品（サーバーコンポーネント）。状態の判定はしない
import type { CallScript, ProposalText } from "@siteoffer/schemas";
import type { ReactNode } from "react";
import { FINDING_STATUS_LABELS, formatYen, SUPPRESSION_LABELS } from "@/lib/sales/labels";
import type { FindingView, SharedAssignmentState, TermsView } from "@/lib/sales/queries";

export function SharedStateBadges({
  assignment,
  suppression,
}: {
  assignment: SharedAssignmentState;
  suppression: string;
}) {
  return (
    <span className="badges">
      {assignment === "mine" && <span className="badge badge-mine">自分が担当中</span>}
      {assignment === "other" && <span className="badge badge-other">他の営業が担当中</span>}
      {assignment === "none" && suppression === "none" && <span className="badge badge-free">担当者なし</span>}
      {suppression !== "none" && (
        <span className="badge badge-stop">{SUPPRESSION_LABELS[suppression] ?? suppression}</span>
      )}
    </span>
  );
}

/** 外部サイトへのリンク。http(s) 以外は文字列として表示する */
export function ExternalLink({ href, children }: { href: string; children?: ReactNode }) {
  if (!/^https?:\/\//i.test(href)) return <span>{children ?? href}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children ?? href}
    </a>
  );
}

export function FindingsList({ findings }: { findings: FindingView[] }) {
  if (findings.length === 0) return <p>診断項目の結果はまだありません。</p>;
  return (
    <ul className="findings">
      {findings.map((f) => (
        <li key={f.itemCode} className={f.critical ? "critical" : undefined}>
          <div className="finding-head">
            <strong>{f.itemCode}</strong> <span>{FINDING_STATUS_LABELS[f.status] ?? f.status}</span>
            {f.score !== null && <span>レベル {f.score}/3</span>}
            {f.critical && <span className="badge badge-stop">重要</span>}
            {f.inference ? (
              <span className="badge badge-guess">推測を含む</span>
            ) : (
              <span className="badge badge-fact">観測事実に基づく</span>
            )}
          </div>
          {f.reason && <p>{f.reason}</p>}
          {f.observations.length > 0 && (
            <div>
              <p className="sub">観測した事実</p>
              <ul>
                {f.observations.map((o) => (
                  <li key={`${o.fact}-${o.url ?? ""}-${o.evidence ?? ""}`}>
                    {o.fact}
                    {o.evidence && <span className="sub">（{o.evidence}）</span>}
                    {o.url && (
                      <>
                        {" "}
                        <ExternalLink href={o.url}>確認したページ</ExternalLink>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {f.improvementHint && (
            <p>
              <span className="sub">改善の方向（提案）：</span>
              {f.improvementHint}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ProposalSummary({ text }: { text: ProposalText }) {
  return (
    <div className="stack">
      <p>{text.summary}</p>
      <ol>
        {text.measures.map((m) => (
          <li key={m.title}>
            <strong>{m.title}</strong>
            <p>
              <span className="sub">現状：</span>
              {m.current}
            </p>
            <p>
              <span className="sub">改善案：</span>
              {m.improvement}
            </p>
            <p className="sub">根拠：{m.evidenceRefs.join("、")}</p>
          </li>
        ))}
      </ol>
      {text.limitations.length > 0 && (
        <div>
          <p className="sub">未確認事項・提案の限界</p>
          <ul>
            {text.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function CallScriptView({ script }: { script: CallScript }) {
  return (
    <div className="stack script">
      <p>
        <span className="sub">名乗りと用件：</span>
        {script.opening}
      </p>
      {script.sections.map((s) => (
        <div key={s.title}>
          <p className="sub">{s.title}</p>
          <ul>
            {s.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      ))}
      <p>
        <span className="sub">断られた場合：</span>
        {script.onDecline}
      </p>
      <p>
        <span className="sub">締め：</span>
        {script.closing}
      </p>
      {script.doNotSay.length > 0 && (
        <div className="warn">
          <p>言ってはいけないこと</p>
          <ul>
            {script.doNotSay.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function rewardText(t: TermsView): string {
  if (!t.reward) return "未設定";
  if (t.reward.type === "fixed") return `契約1件につき ${formatYen(t.reward.amount)}`;
  return `販売価格の ${(t.reward.basisPoints / 100).toLocaleString("ja-JP")}%`;
}

export function TermsTable({ terms }: { terms: TermsView[] }) {
  if (terms.length === 0) return <p className="warn">販売条件・報酬条件：未設定</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>商品</th>
            <th>販売価格</th>
            <th>継続費用（月額）</th>
            <th>報酬条件</th>
          </tr>
        </thead>
        <tbody>
          {terms.map((t) => (
            <tr key={t.id}>
              <td>
                {t.name}
                <span className="sub">（版 {t.version}）</span>
                {!t.ready && <span className="badge badge-stop">条件未設定</span>}
              </td>
              <td>{formatYen(t.price)}</td>
              <td>{t.monthlyFee === null ? "なし・未設定" : formatYen(t.monthlyFee)}</td>
              <td>{rewardText(t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="sub">
        報酬は運営が契約資料を確認して契約完了にした時点で発生します。価格・報酬条件は運営が設定します。
      </p>
    </div>
  );
}
