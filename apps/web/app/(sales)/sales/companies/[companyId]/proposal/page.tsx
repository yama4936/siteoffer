import { Globe, TriangleAlert } from "lucide-react";
import { notFound } from "next/navigation";
import { MarkdownView } from "@/components/sales/markdown";
import { BackLink } from "@/components/sales/section-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, PageHeader, Stat } from "@/components/ui/page";
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
    <>
      <BackLink href={`/sales/companies/${company.id}`}>企業詳細へ</BackLink>
      <PageHeader
        eyebrow="改良資料"
        title={company.name}
        actions={
          available.hasSite ? (
            <a
              href={`/sales/companies/${company.id}/site/index.html`}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline" })}
            >
              <Globe />
              改善後サイトを開く（新しいタブ）
            </a>
          ) : null
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat
          label="総合点"
          value={
            !audit
              ? "—"
              : audit.totalScore === null
                ? "未確定"
                : `${audit.totalScore}${audit.scoreConfirmed === false ? "（未確定）" : ""}`
          }
          hint={
            !audit ? "診断結果はまだありません" : audit.totalScore === null ? "評価できない項目が多いため" : undefined
          }
        />
        {audit && (
          <Stat label="診断日時" value={<span className="text-base">{formatDateTime(audit.evaluatedAt)}</span>} />
        )}
        <Stat label="改善後サイト" value={<span className="text-base">{available.hasSite ? "あり" : "準備中"}</span>} />
      </div>

      {markdown === null ? (
        <EmptyState>改良資料はまだありません。</EmptyState>
      ) : (
        <div className="space-y-4">
          <Alert variant="warning">
            <TriangleAlert />
            <AlertDescription>
              この資料は公開情報をもとに作成した非公式の改善提案です。「営業向けの要点」の章は企業に渡さないでください。成果や効果を約束する言い方はしないでください。
            </AlertDescription>
          </Alert>
          <Card>
            <CardContent className="px-5 sm:px-8">
              <MarkdownView source={markdown} />
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
