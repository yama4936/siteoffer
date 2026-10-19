import { ExternalLink } from "lucide-react";
import { readObservations } from "@/lib/audit/observations";
import { fmtDate } from "@/lib/ops/format";

export function Observations({ value }: { value: unknown }) {
  const { entries, needsOriginal } = readObservations(value);
  if (entries.length === 0) return <p className="text-muted-foreground text-sm">観測事実は記録されていません。</p>;
  return (
    <div className="min-w-0 space-y-3 text-sm">
      <ol className="grid gap-3" aria-label="保存された観測事実">
        {entries.map((entry, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 順番を保持する保存済み記録。画面上で追加・並べ替えはしない。
          <li key={index} className="min-w-0 space-y-2 rounded-lg border bg-muted/20 p-3">
            {entries.length > 1 && <p className="font-medium text-muted-foreground text-xs">根拠 {index + 1}</p>}
            <dl className="grid gap-2 [&_dd]:break-words [&_dd]:whitespace-pre-wrap [&_dt]:mb-1 [&_dt]:font-medium [&_dt]:text-muted-foreground [&_dt]:text-xs">
              <div>
                <dt>観測した事実</dt>
                <dd>{entry.fact ?? "観測内容は未記録です。"}</dd>
              </div>
              <div>
                <dt>確認した箇所・根拠</dt>
                <dd>{entry.evidence ?? "確認箇所は未記録です。"}</dd>
              </div>
              <div>
                <dt>参照先</dt>
                <dd className="break-all">
                  {entry.href ? (
                    <a
                      href={entry.href}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      referrerPolicy="no-referrer"
                      className="text-primary underline underline-offset-4"
                    >
                      {entry.url}
                      <ExternalLink aria-hidden className="ml-1 inline size-3.5 align-text-bottom" />
                      <span className="sr-only">（別タブで開く）</span>
                    </a>
                  ) : entry.url ? (
                    <>
                      <span>{entry.url}</span>
                      <span className="mt-1 block text-muted-foreground text-xs">
                        この参照先はリンクとして開けません。
                      </span>
                    </>
                  ) : (
                    "参照先は未記録です。"
                  )}
                </dd>
              </div>
              {entry.fetchedAt && (
                <div>
                  <dt>観測記録の日時</dt>
                  <dd>{fmtDate(entry.fetchedAt) === "—" ? entry.fetchedAt : fmtDate(entry.fetchedAt)}</dd>
                </div>
              )}
            </dl>
          </li>
        ))}
      </ol>
      {needsOriginal && (
        <p className="text-amber-800 text-xs">
          通常と異なる形式や補足の記録があります。保存された原文も確認してください。
        </p>
      )}
      <details className="min-w-0">
        <summary className="cursor-pointer text-muted-foreground text-xs underline underline-offset-4">
          保存された観測記録（原文）
        </summary>
        <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">
          {JSON.stringify(value, null, 2)}
        </pre>
      </details>
    </div>
  );
}
