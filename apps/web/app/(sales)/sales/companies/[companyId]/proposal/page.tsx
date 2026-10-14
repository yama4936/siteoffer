import Link from "next/link";
import { notFound } from "next/navigation";
import { MarkdownView } from "@/components/sales/markdown";
import { getDb } from "@/lib/db";
import { getImprovementAvailability, getImprovementSource, readProposalMarkdown } from "@/lib/sales/improvement";
import { formatDateTime } from "@/lib/sales/labels";
import { requireUser } from "@/lib/session";

export const metadata = { title: "改良資料 | SiteOffer" };

/** 改良資料：最新の評価済み診断の成果物ディレクトリにある proposal.md を表示する。権限は企業詳細と同じ */
export default async function CompanyProposalPage({ params }: { params: Promise<{ companyId: string }> }) {
  const user = await requireUser("sales");
  const { companyId } = await params;
  const r = await getImprovementSource(getDb(), user.actor, companyId);
  if (!r.ok) notFound();
  const { company, audit, artifactDir } = r.value;
  const [markdown, available] = await Promise.all([
    artifactDir ? readProposalMarkdown(artifactDir) : Promise.resolve(null),
    getImprovementAvailability(artifactDir),
  ]);

  return (
    <main>
      <p>
        <Link href={`/sales/companies/${company.id}`}>← 企業詳細へ</Link>
      </p>
      <h1>{company.name}：改良資料</h1>

      <section>
        <dl className="kv">
          <dt>総合点</dt>
          <dd>
            {!audit
              ? "診断結果はまだありません"
              : audit.totalScore === null
                ? "未確定（評価できない項目が多いため）"
                : `${audit.totalScore}${audit.scoreConfirmed === false ? "（未確定）" : ""}`}
          </dd>
          {audit && (
            <>
              <dt>診断日時</dt>
              <dd>{formatDateTime(audit.evaluatedAt)}</dd>
            </>
          )}
          <dt>改善後サイト</dt>
          <dd>
            {available.hasSite ? (
              <a href={`/sales/companies/${company.id}/site/index.html`} target="_blank" rel="noopener noreferrer">
                改善後サイトを開く（新しいタブ）
              </a>
            ) : (
              "準備中"
            )}
          </dd>
        </dl>
      </section>

      <section>
        {markdown === null ? (
          <p>改良資料はまだありません。</p>
        ) : (
          <>
            <p className="disclaimer">
              この資料は公開情報をもとに作成した非公式の改善提案です。「営業向けの要点」の章は企業に渡さないでください。成果や効果を約束する言い方はしないでください。
            </p>
            <MarkdownView source={markdown} />
          </>
        )}
      </section>
    </main>
  );
}
