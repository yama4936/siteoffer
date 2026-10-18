import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import type { CompanyJourney as Journey } from "@/lib/ops/company-journey";
import { fmtDate } from "@/lib/ops/format";

export function CompanyJourney({ data }: { data: Journey }) {
  return (
    <section
      id="company-journey"
      aria-label="案件の進行と次の操作"
      className="mb-8 space-y-4 rounded-2xl border bg-white p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-3xl space-y-2">
          <p className="text-xs font-medium text-primary">{data.next.waiting ? "現在の処理を確認" : "次にすること"}</p>
          <h2 className="text-lg font-semibold">{data.next.title}</h2>
          <p className="text-sm leading-7 text-muted-foreground">{data.next.description}</p>
        </div>
        <Link
          className={`${buttonVariants({ size: "sm" })} max-w-full whitespace-normal text-center`}
          href={data.next.href}
        >
          {data.next.action}
        </Link>
      </div>
      {data.notice && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">{data.notice}</p>}
      <ul aria-label="工程ごとの現在の記録" className="grid grid-cols-2 gap-2 xl:grid-cols-3">
        {data.cards.map((card) => (
          <li key={card.key} className="min-w-0 rounded-xl border bg-slate-50/50 p-3">
            <p className="mb-2 text-xs text-muted-foreground">{card.label}</p>
            {card.href ? (
              <Link
                href={card.href}
                className="break-words text-sm font-medium text-primary underline decoration-primary/30 underline-offset-4"
              >
                {card.value}
              </Link>
            ) : (
              <span className="text-sm">{card.value}</span>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3 border-t pt-4 text-sm">
        <Badge variant="outline">この案件の資料</Badge>
        {data.documents.design && (
          <a href={data.documents.design} className="text-primary underline">
            デザイン提案PDF
          </a>
        )}
        {data.documents.proposal && (
          <a href={data.documents.proposal} className="text-primary underline">
            承認済み提案PDF
          </a>
        )}
        {!data.documents.design && !data.documents.proposal && (
          <span className="text-muted-foreground">画像の保存・提案の承認後に、出力できる資料を表示します。</span>
        )}
        <Link href={`/ops/content?company=${data.companyId}`} className="text-primary underline">
          お知らせ・記事
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">
        確認時点：{fmtDate(data.checkedAt)}
        。記録のない工程は未確認です。
      </p>
    </section>
  );
}
