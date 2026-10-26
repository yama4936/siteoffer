import Link from "next/link";
import { notFound } from "next/navigation";
import { ActivityHistory } from "@/components/activity-history";
import { PageHeader, Section } from "@/components/ui/page";
import { ActivityHistoryError, readActivityHistory } from "@/lib/activity-history";
import { parseActivityHistoryQuery } from "@/lib/activity-history-types";
import { getDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ assignmentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("ops"),
    { assignmentId } = await params,
    filters = parseActivityHistoryQuery(await searchParams);
  if (!filters) notFound();
  try {
    const initial = await readActivityHistory(getDb(), user.actor, assignmentId, filters);
    return (
      <>
        <Link
          href={`/ops/assignments?all=1&focus=${assignmentId}`}
          className="mb-4 inline-flex min-h-11 items-center text-primary underline"
        >
          ← 担当・引き継ぎへ
        </Link>
        <PageHeader
          title={initial.assignment.companyName}
          description={`活動履歴 / 担当：${initial.assignment.salesName}`}
        />
        <Section
          title="営業の活動履歴"
          description="担当者が記録した内容を検索できます。個人の入力中メモは含みません。"
        >
          <ActivityHistory key={initial.assignment.id} initial={initial} audience="ops" />
        </Section>
      </>
    );
  } catch (error) {
    if (error instanceof ActivityHistoryError) notFound();
    throw error;
  }
}
