import Link from "next/link";
import { makeSellableAction } from "@/app/(ops)/ops/actions";
import { Forbidden, ReturnTo } from "@/components/ops/ui";
import { inlineFormClass, StatusBadge } from "@/components/ops/ui-parts-1";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Muted, Section } from "@/components/ui/page";
import { NativeSelect } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { sellableIssueText } from "@/lib/ops/commands";
import { label, PIPELINE_LABEL, PROPOSAL_STATUS_LABEL, rewardRuleText, yen } from "@/lib/ops/format";
import { listReviewQueue } from "@/lib/ops/queries";
import { sellableIssues } from "@/lib/ops/sellable";
import { getCurrentActor } from "@/lib/session";

export async function ReadyCandidates() {
  const r = await listReviewQueue(getDb(), await getCurrentActor());
  if (!r.ok) return <Forbidden />;
  const { readyCandidates, activeTerms } = r.value;
  const here = "/ops/review";
  return (
    <Section title="営業可能化を待つ候補（承認済みの版がある）">
      {activeTerms.length === 0 ? (
        <Alert variant="warning">
          <AlertDescription>
            <p>
              有効な販売条件・報酬条件の版がありません。<Link href="/ops/contracts">商品条件</Link>
              で作成してください。
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>企業</TableHead>
            <TableHead>準備段階</TableHead>
            <TableHead>最新の版</TableHead>
            <TableHead>営業可能にできない理由</TableHead>
            <TableHead>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {readyCandidates.map(({ company, latestVersion }) => {
            const issues = sellableIssues({ company, latestVersion, terms: null }).filter(
              (i) => i !== "terms_not_selected",
            );
            return (
              <TableRow key={company.id}>
                <TableCell className="min-w-40 font-medium">
                  <Link href={`/ops/companies/${company.id}?returnTo=${encodeURIComponent(here)}`}>{company.name}</Link>
                </TableCell>
                <TableCell>
                  <StatusBadge value={company.pipelineStatus} labels={PIPELINE_LABEL} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {latestVersion
                    ? `v${latestVersion.version}（${label(PROPOSAL_STATUS_LABEL, latestVersion.status)}）`
                    : "—"}
                </TableCell>
                <TableCell className={issues.length > 0 ? "min-w-40 text-warning-foreground" : "min-w-40"}>
                  {issues.map(sellableIssueText).join(" / ") || "—"}
                </TableCell>
                <TableCell className="min-w-72">
                  <form action={makeSellableAction} className={inlineFormClass}>
                    <ReturnTo path={here} />
                    <input type="hidden" name="companyId" value={company.id} />
                    <NativeSelect
                      name="productTermsId"
                      defaultValue=""
                      aria-label="条件の版"
                      className="h-8 w-auto max-w-full"
                    >
                      <option value="">条件の版を選ぶ</option>
                      {activeTerms.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.version}：{yen(t.price)} / {rewardRuleText(t.rewardRule)}
                        </option>
                      ))}
                    </NativeSelect>
                    <Button type="submit" size="sm">
                      営業可能にする
                    </Button>
                  </form>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p>
        <Muted>条件が未設定の版を選んだ場合や、最新の版が未承認の場合は、サーバー側で拒否されます。</Muted>
      </p>
    </Section>
  );
}
