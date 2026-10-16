// 営業画面の表示部品（サーバーコンポーネント）。状態の判定はしない
import type { CallScript, ProposalText } from "@siteoffer/schemas";
import { ExternalLink as ExternalLinkIcon, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { FindingSections } from "@/components/audit/finding-sections";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { FINDING_STATUS_LABELS, formatYen, SUPPRESSION_LABELS } from "@/lib/sales/labels";
import type { FindingView, SharedAssignmentState, TermsView } from "@/lib/sales/queries";
import { cn } from "@/lib/utils";

/** 小見出し（項目名）の小さな文字 */
function SubLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-medium text-muted-foreground text-xs", className)}>{children}</span>;
}

export function SharedStateBadges({
  assignment,
  suppression,
}: {
  assignment: SharedAssignmentState;
  suppression: string;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 align-middle">
      {assignment === "mine" && <Badge variant="info">自分が担当中</Badge>}
      {assignment === "other" && <Badge variant="secondary">他の営業が担当中</Badge>}
      {assignment === "none" && suppression === "none" && <Badge variant="success">担当者なし</Badge>}
      {suppression !== "none" && <Badge variant="destructive">{SUPPRESSION_LABELS[suppression] ?? suppression}</Badge>}
    </span>
  );
}

/** 外部サイトへのリンク。http(s) 以外は文字列として表示する */
export function ExternalLink({ href, children }: { href: string; children?: ReactNode }) {
  if (!/^https?:\/\//i.test(href)) return <span className="break-all">{children ?? href}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="inline-flex items-center gap-1 break-all text-primary underline-offset-4 hover:underline"
    >
      {children ?? href}
      <ExternalLinkIcon aria-hidden="true" className="size-3.5 shrink-0" />
    </a>
  );
}

/** 診断の項目。改善が必要なものだけを開いて見せ、問題なし・評価できずは閉じておく */
export function FindingsList({ findings }: { findings: FindingView[] }) {
  return <FindingSections findings={findings} renderList={(items) => <FindingItems findings={items} />} />;
}

function FindingItems({ findings }: { findings: FindingView[] }) {
  return (
    <ul className="grid gap-3">
      {findings.map((f) => (
        <li
          key={f.itemCode}
          className={cn(
            "space-y-2 rounded-lg border bg-card p-4 text-sm shadow-xs",
            f.critical && "border-l-4 border-l-destructive",
          )}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <strong className="font-semibold">{f.itemCode}</strong>{" "}
            <span>{FINDING_STATUS_LABELS[f.status] ?? f.status}</span>
            {f.score !== null && <span className="text-muted-foreground tabular-nums">レベル {f.score}/3</span>}
            {f.critical && <Badge variant="destructive">重要</Badge>}
            {f.inference ? (
              <Badge variant="warning">推測を含む</Badge>
            ) : (
              <Badge variant="success">観測事実に基づく</Badge>
            )}
          </div>
          {f.reason && <p className="leading-relaxed">{f.reason}</p>}
          {f.observations.length > 0 && (
            <div className="space-y-1">
              <p>
                <SubLabel>観測した事実</SubLabel>
              </p>
              <ul className="list-disc space-y-1 pl-5">
                {f.observations.map((o) => (
                  <li key={`${o.fact}-${o.url ?? ""}-${o.evidence ?? ""}`}>
                    {o.fact}
                    {o.evidence && <span className="text-muted-foreground">（{o.evidence}）</span>}
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
            <p className="leading-relaxed">
              <SubLabel>改善の方向（提案）：</SubLabel>
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
    <div className="space-y-4 text-sm">
      <p className="leading-relaxed">{text.summary}</p>
      <ol className="grid list-decimal gap-3 pl-5">
        {text.measures.map((m) => (
          <li key={m.title} className="space-y-1">
            <strong className="font-semibold">{m.title}</strong>
            <p className="leading-relaxed">
              <SubLabel>現状：</SubLabel>
              {m.current}
            </p>
            <p className="leading-relaxed">
              <SubLabel>改善案：</SubLabel>
              {m.improvement}
            </p>
            <p className="text-muted-foreground text-xs">根拠：{m.evidenceRefs.join("、")}</p>
          </li>
        ))}
      </ol>
      {text.limitations.length > 0 && (
        <div className="space-y-1">
          <p>
            <SubLabel>未確認事項・提案の限界</SubLabel>
          </p>
          <ul className="list-disc space-y-1 pl-5">
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
    <div className="space-y-4 text-sm">
      <p className="leading-relaxed">
        <SubLabel>名乗りと用件：</SubLabel>
        {script.opening}
      </p>
      {script.sections.map((s) => (
        <div key={s.title} className="space-y-1">
          <p>
            <SubLabel>{s.title}</SubLabel>
          </p>
          <ul className="list-disc space-y-1 pl-5">
            {s.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      ))}
      <p className="leading-relaxed">
        <SubLabel>断られた場合：</SubLabel>
        {script.onDecline}
      </p>
      <p className="leading-relaxed">
        <SubLabel>締め：</SubLabel>
        {script.closing}
      </p>
      {script.doNotSay.length > 0 && (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertTitle>言ってはいけないこと</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-5">
              {script.doNotSay.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
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
  if (terms.length === 0)
    return (
      <Alert variant="warning">
        <TriangleAlert />
        <AlertDescription>販売条件・報酬条件：未設定</AlertDescription>
      </Alert>
    );
  return (
    <div className="space-y-2">
      {terms.map((t) => (
        <section
          key={t.id}
          aria-label="販売条件の詳細"
          className="min-w-0 space-y-4 rounded-xl border bg-background p-4"
        >
          <div className="min-w-0 space-y-1">
            <p className="break-words font-semibold">{t.name}</p>
            <p className="break-all text-muted-foreground text-xs">版 {t.version}</p>
            {!t.ready && <Badge variant="destructive">条件未設定</Badge>}
          </div>
          <dl className="grid gap-4 rounded-lg bg-muted/50 p-3 sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground text-xs">販売価格</dt>
              <dd className="mt-1 font-semibold text-lg tabular-nums">{formatYen(t.price)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">継続費用（月額）</dt>
              <dd className="mt-1 font-semibold text-lg tabular-nums">
                {t.monthlyFee === null ? "なし・未設定" : formatYen(t.monthlyFee)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">報酬条件</dt>
              <dd className="mt-1 font-medium text-sm tabular-nums">{rewardText(t)}</dd>
            </div>
          </dl>
          {t.scope && (
            <div className="space-y-1">
              <p className="text-muted-foreground text-xs">提供範囲</p>
              <p className="whitespace-pre-wrap break-words text-sm">{t.scope}</p>
            </div>
          )}
        </section>
      ))}
      <p className="text-muted-foreground text-xs">
        報酬は運営が契約資料を確認して契約完了にした時点で発生します。価格・報酬条件は運営が設定します。
      </p>
    </div>
  );
}
