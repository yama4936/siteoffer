import { companies, contentImports, users } from "@siteoffer/db";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArticleImport } from "@/components/ops/article-import";
import { PageHeader, Section } from "@/components/ui/page";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
import { fmtDate } from "@/lib/ops/format";
import { requireUser } from "@/lib/session";
export default async function ArticleImportPage({ params }: { params: Promise<{ companyId: string }> }) {
  await requireUser("ops");
  const { companyId } = await params;
  if (!isUuid(companyId)) notFound();
  const db = getDb();
  const [company] = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId));
  if (!company) notFound();
  const history = await db
    .select({ batch: contentImports, name: users.displayName })
    .from(contentImports)
    .innerJoin(users, eq(users.id, contentImports.createdBy))
    .where(eq(contentImports.companyId, companyId))
    .orderBy(desc(contentImports.createdAt))
    .limit(10);
  return (
    <>
      <PageHeader
        title="既存の記事を取り込む"
        description={`${company.name}のお知らせ・ブログを下書きにまとめて登録します。`}
      />
      <p className="mb-5 text-sm">
        <Link href={`/ops/content?company=${companyId}`} className="text-primary underline">
          記事管理へ戻る
        </Link>
      </p>
      <ArticleImport companyId={companyId} companyName={company.name} />
      <Section title="取り込み履歴" description="直近10回の受付です。既存の記事や掲載設定は変更していません。">
        {!history.length ? (
          <p className="text-sm text-muted-foreground">取り込みはまだありません。</p>
        ) : (
          <ol className="space-y-3">
            {history.map(({ batch: b, name }) => (
              <li key={b.id} className="rounded-xl border p-4 text-sm space-y-1">
                <p className="font-medium break-all">{b.fileName}</p>
                <p>
                  下書き {b.importedCount}件 · 既存のためスキップ {b.skippedCount}件
                </p>
                <p className="text-muted-foreground">
                  {fmtDate(b.createdAt)} · {name}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </>
  );
}
