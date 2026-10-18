import { randomUUID } from "node:crypto";
import { isTermsReadyForSales, systemClock } from "@siteoffer/core";
import { getCompanyAuditRequest } from "@siteoffer/worker/audit-request";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AuditRequest } from "@/components/ops/audit-request";
import { AuditView } from "@/components/ops/audit-view";
import { CompanyJourney } from "@/components/ops/company-journey";
import { GenerationHistory } from "@/components/ops/generation-history";
import { ImageAssetUpload } from "@/components/ops/image-asset-upload";
import { Flash, Forbidden, first, Json, ReturnTo } from "@/components/ops/ui";
import {
  detailsClass,
  EmptyRow,
  inlineFormClass,
  StatusBadge,
  SubHeading,
  stackFormClass,
  summaryClass,
} from "@/components/ops/ui-parts-2";
import { WebsiteCandidate, WebsiteReview } from "@/components/ops/website-candidate";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { DescriptionList, EmptyState, PageHeader, Section } from "@/components/ui/page";
import { NativeSelect } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { sellableIssueText } from "@/lib/ops/commands";
import { getCompanyJourney } from "@/lib/ops/company-journey";
import { isUuid, safeReturnTo } from "@/lib/ops/form";
import {
  ASSIGNMENT_STATUS_LABEL,
  fmtDate,
  label,
  OFFICIAL_SITE_LABEL,
  PIPELINE_LABEL,
  PROPOSAL_STATUS_LABEL,
  rewardRuleText,
  SUPPRESSION_LABEL,
  yen,
} from "@/lib/ops/format";
import { getCompanyDetail, listAuditEventsForOps, listProductTerms } from "@/lib/ops/queries";
import { sellableIssues, termsIssueText } from "@/lib/ops/sellable";
import {
  listSiteSearchCandidates,
  listWebsiteCandidateEvidence,
  websiteReviewFingerprint,
} from "@/lib/ops/website-candidate";
import { getCurrentActor } from "@/lib/session";
import {
  createImageAssetAction,
  excludeCandidateAction,
  makeSellableAction,
  reviewProposalAction,
  updateCandidateAction,
  updateImageAssetPolicyAction,
  withdrawSellableAction,
} from "../../actions";

const IMAGE_SOURCE_LABEL: Record<string, string> = {
  original_site: "元サイト",
  customer_upload: "顧客提供",
  generated: "生成画像",
  operator_upload: "運営登録",
};

const IMAGE_RIGHTS_LABEL: Record<string, string> = {
  unknown: "未確認（評価参照のみ）",
  customer_claimed: "顧客が権利を申告",
  license_verified: "ライセンス確認済み",
  use_approved: "利用許諾確認済み",
};

export default async function CompanyPage({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { companyId } = await params;
  const sp = await searchParams;
  if (!isUuid(companyId)) notFound();
  const db = getDb();
  const actor = await getCurrentActor();
  const r = await getCompanyDetail(db, actor, companyId);
  if (!r.ok) return <Forbidden />;
  if (!r.value) notFound();
  const terms = await listProductTerms(db, actor);
  const events = await listAuditEventsForOps(db, actor, { targetType: "company", targetId: companyId, limit: 50 });
  if (!terms.ok || !events.ok) return <Forbidden />;

  const auditRequest = await getCompanyAuditRequest(db, actor, companyId);
  if (!auditRequest.ok) return <Forbidden />;
  const journey = await getCompanyJourney(db, systemClock, actor, companyId);
  if (!journey.ok) return journey.error === "forbidden" ? <Forbidden /> : notFound();
  const d = r.value;
  const c = d.company;
  const websiteProps = {
    companyId: c.id,
    fingerprint: websiteReviewFingerprint(c),
    requestId: randomUUID(),
    status: c.officialSiteStatus,
    sites: d.websites
      .filter((site) => site.kind === "current")
      .map((site) => ({
        id: site.id,
        url: site.url,
        primary: site.isPrimary,
        fingerprint: websiteReviewFingerprint(c, site),
      })),
  };
  const evidence = await listWebsiteCandidateEvidence(db, actor, c.id);
  if (!evidence.ok) return <Forbidden />;
  const searchCandidates = await listSiteSearchCandidates(db, actor, c.id);
  if (!searchCandidates.ok) return <Forbidden />;
  const here = `/ops/companies/${c.id}`;
  const back = safeReturnTo(first(sp, "returnTo") ?? null, "/ops/discovery");
  const latest = d.proposalVersions[0] ?? null;
  // 条件の版を選ぶ前の段階の理由（版の可否は選択肢に表示する）
  const baseIssues = sellableIssues({ company: c, latestVersion: latest, terms: null }).filter(
    (i) => i !== "terms_not_selected",
  );
  const readyTerms = terms.value.filter((t) => isTermsReadyForSales(t));

  return (
    <>
      <PageHeaderBlock
        back={back}
        name={c.name}
        pipelineStatus={c.pipelineStatus}
        officialSiteStatus={c.officialSiteStatus}
        suppression={c.suppression}
      />
      <Flash searchParams={sp} />
      <CompanyJourney data={journey.value} />

      <div className="mb-8 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>
              <h2>基本情報</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <DescriptionList>
              <dt>法人番号</dt>
              <dd>{c.corporateNumber ?? "不明"}</dd>
              <dt>準備段階</dt>
              <dd>
                <StatusBadge map={PIPELINE_LABEL} status={c.pipelineStatus} />
              </dd>
              <dt>所在地</dt>
              <dd>
                {[c.prefecture, c.city, c.address].filter(Boolean).join(" ") || "不明"}
                <br />
                <span className="break-all text-muted-foreground text-xs">出典：{c.addressSourceUrl ?? "なし"}</span>
              </dd>
              <dt>公式サイト</dt>
              <dd>
                <StatusBadge map={OFFICIAL_SITE_LABEL} status={c.officialSiteStatus} />
              </dd>
              <dt>業種</dt>
              <dd>{c.industry ?? "不明"}</dd>
              <dt id="company-policy" className="scroll-mt-24">
                営業抑止
              </dt>
              <dd>
                {label(SUPPRESSION_LABEL, c.suppression)}
                {c.suppressionReason ? `（${c.suppressionReason}）` : ""}
              </dd>
              <dt>代表窓口</dt>
              <dd>{c.representativePhone ?? "不明"}</dd>
              <dt>更新</dt>
              <dd className="tabular-nums">{fmtDate(c.updatedAt)}</dd>
            </DescriptionList>

            <div className="space-y-2">
              <details className={detailsClass}>
                <summary id="company-information" className={summaryClass}>
                  候補を修正する
                </summary>
                <form action={updateCandidateAction} className={stackFormClass}>
                  <ReturnTo path={here} />
                  <input type="hidden" name="companyId" value={c.id} />
                  <Field label="企業名" htmlFor="cand-name">
                    <Input id="cand-name" name="name" defaultValue={c.name} required />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="都道府県" htmlFor="cand-prefecture">
                      <Input id="cand-prefecture" name="prefecture" defaultValue={c.prefecture ?? ""} />
                    </Field>
                    <Field label="市区町村" htmlFor="cand-city">
                      <Input id="cand-city" name="city" defaultValue={c.city ?? ""} />
                    </Field>
                  </div>
                  <Field label="住所" htmlFor="cand-address">
                    <Input id="cand-address" name="address" defaultValue={c.address ?? ""} />
                  </Field>
                  <Field label="住所の出典URL" htmlFor="cand-address-source">
                    <Input
                      id="cand-address-source"
                      name="addressSourceUrl"
                      type="url"
                      defaultValue={c.addressSourceUrl ?? ""}
                    />
                  </Field>
                  <Field label="業種" htmlFor="cand-industry">
                    <Input id="cand-industry" name="industry" defaultValue={c.industry ?? ""} />
                  </Field>
                  <Field label="代表窓口（電話）" htmlFor="cand-phone">
                    <Input id="cand-phone" name="representativePhone" defaultValue={c.representativePhone ?? ""} />
                  </Field>
                  <div>
                    <Button type="submit" size="sm">
                      修正を保存
                    </Button>
                  </div>
                </form>
              </details>

              <details className={detailsClass}>
                <summary className={summaryClass}>
                  候補を除外する（企業共通の抑止。再収集でも営業可能に戻りません）
                </summary>
                <form action={excludeCandidateAction} className={stackFormClass}>
                  <ReturnTo path={here} />
                  <input type="hidden" name="companyId" value={c.id} />
                  <Field label="種類" htmlFor="exclude-kind">
                    <NativeSelect id="exclude-kind" name="kind" defaultValue="excluded">
                      <option value="excluded">対象外（除外）</option>
                      <option value="existing_customer">既存顧客</option>
                    </NativeSelect>
                  </Field>
                  <Field label="理由" htmlFor="exclude-reason">
                    <Input id="exclude-reason" name="reason" required />
                  </Field>
                  <div>
                    <Button type="submit" size="sm" variant="destructive">
                      除外する
                    </Button>
                  </div>
                </form>
              </details>
            </div>
          </CardContent>
        </Card>

        <Card id="company-sales">
          <CardHeader>
            <CardTitle>
              <h2>営業可能化</h2>
            </CardTitle>
            <CardDescription>
              運営確認（最新の提案版の承認）が済み、販売条件・報酬条件が設定された版を選んだ候補だけを営業可能にできます。判定はサーバー側で行います。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {c.pipelineStatus === "sellable" ? (
              <form action={withdrawSellableAction} className="grid gap-2">
                <ReturnTo path={here} />
                <input type="hidden" name="companyId" value={c.id} />
                <Input name="reason" placeholder="取り下げの理由（必須）" required aria-label="取り下げの理由" />
                <div>
                  <Button type="submit" size="sm" variant="destructive">
                    営業可能を取り下げる
                  </Button>
                </div>
              </form>
            ) : (
              <>
                {baseIssues.length > 0 ? (
                  <Alert variant="warning">
                    <AlertDescription>
                      <ul className="list-disc space-y-0.5 pl-4">
                        {baseIssues.map((i) => (
                          <li key={i}>{sellableIssueText(i)}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                ) : null}
                {readyTerms.length === 0 ? (
                  <Alert variant="warning">
                    <AlertDescription>
                      <p>
                        販売条件・報酬条件が設定された有効な版がありません。<Link href="/ops/contracts">商品条件</Link>
                        で版を作成してください。
                      </p>
                    </AlertDescription>
                  </Alert>
                ) : null}
                <form action={makeSellableAction} className="grid gap-2">
                  <ReturnTo path={here} />
                  <input type="hidden" name="companyId" value={c.id} />
                  <input type="hidden" name="proposalVersionId" value={latest?.id ?? ""} />
                  <NativeSelect name="productTermsId" defaultValue="" aria-label="販売条件・報酬条件の版" required>
                    <option value="">販売条件・報酬条件の版を選ぶ</option>
                    {terms.value.map((t) => {
                      const ready = isTermsReadyForSales(t);
                      return (
                        <option key={t.id} value={t.id} disabled={!ready}>
                          {t.version} {t.name}：{yen(t.price)} / {rewardRuleText(t.rewardRule)}
                          {ready ? "" : `（使えません：${termsIssueText(t)}）`}
                        </option>
                      );
                    })}
                  </NativeSelect>
                  <div>
                    <Button
                      type="submit"
                      size="sm"
                      variant="success"
                      disabled={baseIssues.length > 0 || readyTerms.length === 0}
                    >
                      営業可能にする
                    </Button>
                  </div>
                </form>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Section title="サイトと公式サイトの確認" id="company-site">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>URL</TableHead>
              <TableHead>種類</TableHead>
              <TableHead>主サイト</TableHead>
              <TableHead>登録</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.websites.map((w) => (
              <TableRow key={w.id}>
                <TableCell className="break-all">{w.url}</TableCell>
                <TableCell>{w.kind === "current" ? "現サイト" : "提案"}</TableCell>
                <TableCell>{w.isPrimary ? <Badge variant="info">主</Badge> : ""}</TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">{fmtDate(w.createdAt)}</TableCell>
              </TableRow>
            ))}
            {d.websites.length === 0 ? <EmptyRow colSpan={4}>サイトは見つかっていません</EmptyRow> : null}
          </TableBody>
        </Table>
        <WebsiteCandidate {...websiteProps} searchCandidates={searchCandidates.value} />
        <WebsiteReview {...websiteProps} />
        {!!evidence.value.length && (
          <details className="my-4 rounded-xl border p-4">
            <summary className="cursor-pointer font-medium">運営が追加した候補の確認根拠（最近20件）</summary>
            <ul className="mt-3 space-y-3">
              {evidence.value.map((row) => {
                const proof = row.data as { url?: string; sourceUrl?: string; note?: string };
                return (
                  <li key={row.id} className="rounded-lg bg-slate-50 p-3 text-sm">
                    <p className="break-all">候補：{proof.url}</p>
                    <p className="mt-1 break-all">出典：{proof.sourceUrl}</p>
                    <p className="mt-2 break-words">{proof.note}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {fmtDate(row.at)} · {row.by ?? "運営"}
                    </p>
                  </li>
                );
              })}
            </ul>
          </details>
        )}

        <SubHeading>出典</SubHeading>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>取得元</TableHead>
              <TableHead>役割</TableHead>
              <TableHead>出典URL</TableHead>
              <TableHead>取得日時</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.sources.map((s) => (
              <TableRow key={s.id}>
                <TableCell>{s.provider}</TableCell>
                <TableCell>{s.role === "site" ? "公式サイト候補" : "企業候補"}</TableCell>
                <TableCell className="break-all">{s.sourceUrl ?? "—"}</TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">{fmtDate(s.fetchedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section id="image-assets" title="画像素材と利用許諾">
        <p className="mb-4 text-sm">
          <Link href={`/ops/materials?company=${companyId}&all=1`} className="underline">
            この会社の顧客提出素材を確認
          </Link>
        </p>
        <Alert>
          <AlertDescription>
            元サイトの画像は登録しただけでは営業デモや納品サイトに使えません。権利状態と利用範囲を画像ごとに確認してください。外部画像の直リンクは行いません。
            デモに掲載する写真・ロゴは、ファイル・営業デモの許可・配置先を登録すると次回の提案制作に反映されます。デザイン画像はレイアウトの参照に使います。
          </AlertDescription>
        </Alert>
        <details className={detailsClass}>
          <summary className={summaryClass}>画像素材の出所を登録する</summary>
          <form action={createImageAssetAction} className={stackFormClass}>
            <ReturnTo path={here} />
            <input type="hidden" name="companyId" value={c.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="素材名" htmlFor="image-asset-label">
                <Input id="image-asset-label" name="label" placeholder="例：トップページの店舗外観" required />
              </Field>
              <Field label="出所" htmlFor="image-asset-source">
                <NativeSelect id="image-asset-source" name="sourceType" defaultValue="original_site">
                  {Object.entries(IMAGE_SOURCE_LABEL).map(([value, text]) => (
                    <option key={value} value={value}>
                      {text}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            <Field label="出典URL（元サイト由来は必須）" htmlFor="image-asset-url">
              <Input id="image-asset-url" name="sourceUrl" type="url" />
            </Field>
            <Field label="メモ" htmlFor="image-asset-note">
              <Input id="image-asset-note" name="note" />
            </Field>
            <div>
              <Button type="submit" size="sm">
                評価参照のみで登録
              </Button>
            </div>
          </form>
        </details>
        <div className="grid gap-4">
          {d.imageAssets.map(({ asset, confirmerName, file }) => (
            <article
              key={asset.id}
              aria-label={`素材：${asset.label}`}
              className="grid gap-4 rounded-xl border bg-background p-4 lg:grid-cols-[240px_1fr]"
            >
              <div className="min-w-0">
                <div className="font-medium">{asset.label}</div>
                <ImageAssetUpload
                  companyId={c.id}
                  assetId={asset.id}
                  label={asset.label}
                  file={file?.assetId ? file : null}
                />
                <div className="text-muted-foreground text-xs">{label(IMAGE_SOURCE_LABEL, asset.sourceType)}</div>
                {asset.sourceUrl ? (
                  <div className="break-all text-muted-foreground text-xs">{asset.sourceUrl}</div>
                ) : null}
              </div>
              <div className="min-w-0 space-y-3">
                <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">権利：</span>
                    {label(IMAGE_RIGHTS_LABEL, asset.rightsStatus)}
                  </div>
                  <div>
                    <div>評価参照：可</div>
                    <div>営業デモ：{asset.allowSalesDemo ? "可" : "不可"}</div>
                    <div>本番：{asset.allowProduction ? "可" : "不可"}</div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {asset.confirmedAt ? (
                      <>
                        <div>{confirmerName ?? "運営ユーザー"}</div>
                        <div className="whitespace-nowrap tabular-nums">{fmtDate(asset.confirmedAt)}</div>
                      </>
                    ) : (
                      "未確認"
                    )}
                  </div>
                </div>
                <div className="min-w-0">
                  <form key={asset.policyRevision} action={updateImageAssetPolicyAction} className="grid gap-2">
                    <ReturnTo path={here} />
                    <input type="hidden" name="companyId" value={c.id} />
                    <input type="hidden" name="imageAssetId" value={asset.id} />
                    <input type="hidden" name="expectedRevision" value={asset.policyRevision} />
                    <label htmlFor={`placement-${asset.id}`} className="text-sm">
                      提案デモ・納品サイトの配置先
                    </label>
                    <NativeSelect id={`placement-${asset.id}`} name="placement" defaultValue={asset.placement}>
                      <option value="reference">自動配置しない</option>
                      <option value="hero">メイン画像</option>
                      <option value="logo">ロゴ</option>
                    </NativeSelect>
                    <p className="max-w-72 text-xs text-muted-foreground">
                      画像ファイルを登録し、下で許可した用途の次回制作に配置します。各配置先に1点。営業デモの許可だけでは納品サイトに使いません。
                    </p>
                    <p className="max-w-72 text-xs text-muted-foreground">
                      許諾や配置の保存内容が変わると、この素材を使う既存の提案共有は停止します。変更後の素材で新しい提案を制作してください。
                    </p>
                    <NativeSelect
                      name="rightsStatus"
                      defaultValue={asset.rightsStatus}
                      aria-label={`${asset.label}の権利状態`}
                    >
                      {Object.entries(IMAGE_RIGHTS_LABEL).map(([value, text]) => (
                        <option key={value} value={value}>
                          {text}
                        </option>
                      ))}
                    </NativeSelect>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="allowSalesDemo" defaultChecked={asset.allowSalesDemo} />
                      営業デモで使用可
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="allowProduction" defaultChecked={asset.allowProduction} />
                      納品サイトで使用可
                    </label>
                    <Input
                      name="note"
                      defaultValue={asset.note ?? ""}
                      placeholder="確認根拠・条件"
                      aria-label={`${asset.label}の確認メモ`}
                    />
                    <div>
                      <Button type="submit" size="sm">
                        利用方針を更新
                      </Button>
                    </div>
                  </form>
                </div>
              </div>
            </article>
          ))}
        </div>
        {d.imageAssets.length === 0 && (
          <EmptyState>画像素材を登録すると、画像の取込・許諾確認・配置先の指定ができます。</EmptyState>
        )}
      </Section>

      <Section
        title="診断結果"
        id="company-audit"
        actions={
          <Link className="text-sm text-primary underline" href={`/ops/processing?company=${companyId}#audit-recovery`}>
            処理状況・再開を確認
          </Link>
        }
      >
        <AuditRequest companyId={companyId} data={auditRequest.value} />
        {d.latestAudit ? (
          <AuditView audit={d.latestAudit} findings={d.findings} />
        ) : (
          <EmptyState>診断はまだありません。</EmptyState>
        )}
        {d.audits.length > 1 ? (
          <p className="text-muted-foreground text-sm">過去の診断 {d.audits.length - 1}件（最新のみ表示）</p>
        ) : null}
      </Section>

      <Section title="提案版とレビュー（運営確認）">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>版</TableHead>
              <TableHead>状態</TableHead>
              <TableHead>内容</TableHead>
              <TableHead>デモ</TableHead>
              <TableHead>レビュー</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.proposalVersions.map((v) => (
              <TableRow key={v.id}>
                <TableCell className="font-medium tabular-nums">v{v.version}</TableCell>
                <TableCell>
                  <StatusBadge map={PROPOSAL_STATUS_LABEL} status={v.status} />
                </TableCell>
                <TableCell className="min-w-56">
                  <details>
                    <summary className={summaryClass}>改善提案・電話台本など</summary>
                    <div className="mt-2">
                      <Json value={v.content} />
                    </div>
                  </details>
                </TableCell>
                <TableCell>
                  {v.demoArtifactDir ? <code className="break-all text-xs">{v.demoArtifactDir}</code> : "—"}
                </TableCell>
                <TableCell>
                  <span className="whitespace-nowrap tabular-nums">{fmtDate(v.reviewedAt)}</span>
                  {v.reviewNote ? <div className="text-muted-foreground text-xs">{v.reviewNote}</div> : null}
                </TableCell>
                <TableCell>
                  {v.status === "in_review" ? (
                    <div className="grid min-w-64 gap-2">
                      <form action={reviewProposalAction} className={inlineFormClass}>
                        <ReturnTo path={here} />
                        <input type="hidden" name="proposalVersionId" value={v.id} />
                        <input type="hidden" name="decision" value="approved" />
                        <Input
                          name="note"
                          placeholder="確認メモ（任意）"
                          aria-label="確認メモ"
                          className="h-8 flex-1"
                        />
                        <Button type="submit" size="sm" variant="success">
                          承認
                        </Button>
                      </form>
                      <form action={reviewProposalAction} className={inlineFormClass}>
                        <ReturnTo path={here} />
                        <input type="hidden" name="proposalVersionId" value={v.id} />
                        <input type="hidden" name="decision" value="rejected" />
                        <Input
                          name="note"
                          placeholder="差し戻しの理由（必須）"
                          required
                          aria-label="差し戻しの理由"
                          className="h-8 flex-1"
                        />
                        <Button type="submit" size="sm" variant="outline">
                          差し戻し
                        </Button>
                      </form>
                    </div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
            {d.proposalVersions.length === 0 ? <EmptyRow colSpan={6}>提案版はまだありません</EmptyRow> : null}
          </TableBody>
        </Table>

        <GenerationHistory jobs={d.generationJobs} companyId={c.id} now={new Date()} />
      </Section>

      <Section
        title="担当の履歴"
        actions={
          <Link href="/ops/assignments" className={buttonVariants({ variant: "outline", size: "sm" })}>
            担当状況の画面で付け替え・延長・解除
          </Link>
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>営業ユーザー</TableHead>
              <TableHead>状態</TableHead>
              <TableHead>確保</TableHead>
              <TableHead>期限</TableHead>
              <TableHead>解除理由</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.assignments.map(({ a, userName }) => (
              <TableRow key={a.id}>
                <TableCell>{userName}</TableCell>
                <TableCell>
                  <StatusBadge map={ASSIGNMENT_STATUS_LABEL} status={a.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">{fmtDate(a.claimedAt)}</TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">{fmtDate(a.expiresAt)}</TableCell>
                <TableCell>{a.releaseReason ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section title="この企業の操作履歴（最新50件）">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>日時</TableHead>
              <TableHead>主体</TableHead>
              <TableHead>操作</TableHead>
              <TableHead>変更前</TableHead>
              <TableHead>変更後</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.value.map(({ e, actorName }) => (
              <TableRow key={e.id}>
                <TableCell className="whitespace-nowrap tabular-nums">{fmtDate(e.createdAt)}</TableCell>
                <TableCell>
                  {e.actorKind}
                  {actorName ? `：${actorName}` : ""}
                </TableCell>
                <TableCell>
                  <code className="text-xs">{e.action}</code>
                </TableCell>
                <TableCell className="min-w-48">
                  <Json value={e.before} />
                </TableCell>
                <TableCell className="min-w-48">
                  <Json value={e.after} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>
    </>
  );
}

/** ページ見出し（企業名・状態・一覧へ戻る） */
function PageHeaderBlock({
  back,
  name,
  pipelineStatus,
  officialSiteStatus,
  suppression,
}: {
  back: string;
  name: string;
  pipelineStatus: string;
  officialSiteStatus: string;
  suppression: string;
}) {
  return (
    <PageHeader
      title={name}
      description={
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge map={PIPELINE_LABEL} status={pipelineStatus} />
          <Badge variant="outline">公式サイト：{label(OFFICIAL_SITE_LABEL, officialSiteStatus)}</Badge>
          {suppression !== "none" ? (
            <Badge variant="destructive">営業抑止：{label(SUPPRESSION_LABEL, suppression)}</Badge>
          ) : null}
        </div>
      }
      actions={
        <Link href={back} className={buttonVariants({ variant: "outline", size: "sm" })}>
          <ArrowLeft aria-hidden="true" />
          一覧へ戻る
        </Link>
      }
    />
  );
}
