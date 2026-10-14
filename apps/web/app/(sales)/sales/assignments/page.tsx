import Link from "next/link";
import { getDb } from "@/lib/db";
import { ASSIGNMENT_STATUS_LABELS, CONTRACT_STATUS_LABELS, formatDateTime } from "@/lib/sales/labels";
import { listMyAssignments } from "@/lib/sales/queries";
import { requireUser } from "@/lib/session";

export const metadata = { title: "担当案件 | SiteOffer" };

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/** 担当案件の一覧（自分の担当だけ） */
export default async function AssignmentsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser("sales");
  const includeEnded = (await searchParams).all === "1";
  const r = await listMyAssignments(getDb(), user.actor, { includeEnded });

  return (
    <main>
      <h1>担当案件</h1>
      <p>
        {includeEnded ? (
          <Link href="/sales/assignments">対応中の担当だけを表示</Link>
        ) : (
          <Link href="/sales/assignments?all=1">終了した担当も表示</Link>
        )}
      </p>
      {!r.ok ? (
        <p role="alert">担当案件を表示できませんでした。</p>
      ) : r.value.length === 0 ? (
        <p>
          担当中の案件はありません。<Link href="/sales/companies">企業一覧</Link>から担当を確保できます。
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>企業</th>
                <th>状態</th>
                <th>次回対応日</th>
                <th>担当の期限</th>
                <th>契約確認</th>
              </tr>
            </thead>
            <tbody>
              {r.value.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link href={`/sales/assignments/${a.id}`}>{a.companyName}</Link>
                    <div className="sub">{[a.prefecture, a.city].filter(Boolean).join(" ")}</div>
                  </td>
                  <td>{ASSIGNMENT_STATUS_LABELS[a.status as keyof typeof ASSIGNMENT_STATUS_LABELS] ?? a.status}</td>
                  <td>{formatDateTime(a.nextActionAt)}</td>
                  <td>{formatDateTime(a.expiresAt)}</td>
                  <td>{a.contractStatus ? (CONTRACT_STATUS_LABELS[a.contractStatus] ?? a.contractStatus) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
