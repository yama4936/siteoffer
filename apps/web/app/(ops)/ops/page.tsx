import Link from "next/link";
import { Flash, Forbidden } from "@/components/ops/ui";
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
    <main>
      <h1>運営の概要</h1>
      <Flash searchParams={await searchParams} />
      <table>
        <tbody>
          {rows.map(([label, n, href]) => (
            <tr key={label}>
              <th>{label}</th>
              <td>{n}件</td>
              <td>
                <Link href={href}>開く</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">この画面はローカル開発版です。外部への連絡・公開・課金は行いません。</p>
    </main>
  );
}
