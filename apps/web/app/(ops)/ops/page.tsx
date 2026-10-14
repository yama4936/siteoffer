import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Flash, Forbidden } from "@/components/ops/ui";
import { Muted, PageHeader, Stat } from "@/components/ui/page";
import { getDb } from "@/lib/db";
import { getOpsDashboard } from "@/lib/ops/queries";
import { getCurrentActor } from "@/lib/session";

export default async function OpsHome({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const r = await getOpsDashboard(getDb(), await getCurrentActor());
  if (!r.ok) return <Forbidden />;
  const d = r.value;
  const rows: [string, number, string][] = [
    ["失敗した収集ジョブ", d.failedJobs, "/ops/discovery"],
    ["公式サイトの確認待ち", d.officialSiteNeedsReview, "/ops/discovery?official=needs_review"],
    ["運営確認待ちの提案版", d.proposalsInReview, "/ops/review"],
    ["運営確認待ちの担当（期限超過など）", d.assignmentsAwaitingOps, "/ops/assignments"],
    ["未確認の成約報告", d.contractsOpen, "/ops/contracts"],
    ["未確認のドメイン希望", d.domainPreferencesUnconfirmed, "/ops/delivery"],
    ["営業可能な候補", d.sellableCompanies, "/ops/discovery?pipeline=sellable"],
  ];
  return (
    <>
      <PageHeader title="運営の概要" description="対応が必要な件数と、各画面への入り口です。" />
      <Flash searchParams={await searchParams} />
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map(([label, n, href]) => (
          <li key={label}>
            <Link
              href={href}
              className="group block h-full rounded-xl no-underline outline-none hover:no-underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <Stat
                label={label}
                value={
                  <span className={n > 0 ? undefined : "text-muted-foreground"}>
                    {n}
                    <span className="ml-1 font-normal text-base">件</span>
                  </span>
                }
                hint={
                  <span className="inline-flex items-center gap-1 text-primary group-hover:underline">
                    開く
                    <ArrowRight aria-hidden="true" className="size-3" />
                  </span>
                }
                className="h-full transition-colors group-hover:border-primary/40 group-hover:bg-accent/40"
              />
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-6">
        <Muted>この画面はローカル開発版です。外部への連絡・公開・課金は行いません。</Muted>
      </p>
    </>
  );
}
