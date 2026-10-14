import { ChevronRight, CircleAlert, CircleCheck, CircleHelp, CircleMinus } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { type GroupableFinding, groupFindings } from "@/lib/audit/finding-groups";

/**
 * 診断の項目を「改善が必要」（開いて表示）と「軽微な課題」「問題なし」「評価できなかった・対象外」（閉じて表示）に分けて並べる。
 * 項目の見せ方（一覧・表）は呼び出し側の renderList に任せる。開閉は標準の details/summary で、スクリプトに依存しない。
 */
export function FindingSections<T extends GroupableFinding>({
  findings,
  renderList,
}: {
  findings: readonly T[];
  renderList: (items: T[]) => ReactNode;
}) {
  if (findings.length === 0) return <p className="text-muted-foreground text-sm">診断項目の結果はまだありません。</p>;
  const { needsWork, minor, ok, other } = groupFindings(findings);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 font-semibold text-sm">
        <CircleAlert className="size-4 text-destructive" aria-hidden />
        改善が必要な項目
        <Badge variant="destructive">{needsWork.length}件</Badge>
      </div>
      {needsWork.length > 0 ? (
        renderList(needsWork)
      ) : (
        <p className="text-muted-foreground text-sm">改善が必要と判定された項目はありません。</p>
      )}
      {minor.length > 0 && (
        <Collapsible
          icon={<CircleMinus className="size-4 text-warning-foreground" aria-hidden />}
          title="軽微な課題の項目（レベル2）"
          count={minor.length}
        >
          {renderList(minor)}
        </Collapsible>
      )}
      {ok.length > 0 && (
        <Collapsible
          icon={<CircleCheck className="size-4 text-success" aria-hidden />}
          title="問題なしの項目"
          count={ok.length}
        >
          {renderList(ok)}
        </Collapsible>
      )}
      {other.length > 0 && (
        <Collapsible
          icon={<CircleHelp className="size-4 text-muted-foreground" aria-hidden />}
          title="評価できなかった・対象外の項目"
          count={other.length}
        >
          <p className="text-muted-foreground text-sm">評価できなかった項目は低評価には含めていません。</p>
          {renderList(other)}
        </Collapsible>
      )}
    </div>
  );
}

function Collapsible({
  icon,
  title,
  count,
  children,
}: {
  icon: ReactNode;
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <details className="group rounded-lg border bg-muted/30">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 font-medium text-sm [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden />
        {icon}
        {title}
        <Badge variant="outline">{count}件</Badge>
        <span className="ml-auto text-muted-foreground text-xs group-open:hidden">クリックで表示</span>
      </summary>
      <div className="space-y-3 border-t px-4 py-3">{children}</div>
    </details>
  );
}
