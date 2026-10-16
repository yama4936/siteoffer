import {
  DELIVERY_STATUSES,
  type DeliveryDetail,
  EXISTING_DOMAIN_REVIEW_NOTICE,
  NEW_DOMAIN_AVAILABILITY_NOTICE,
  ok,
} from "@siteoffer/core";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CustomerReviewForm } from "@/components/ops/customer-review-form";
import { CustomerReviewLinks } from "@/components/ops/customer-review-links";
import { DeliveryBuildRetry } from "@/components/ops/delivery-build-retry";
import { DeliveryPreparation } from "@/components/ops/delivery-preparation";
import { DiscoveryRefresh } from "@/components/ops/discovery-refresh";
import { SubmitButton } from "@/components/ops/submit-button";
import { Flash, Forbidden, ReturnTo } from "@/components/ops/ui";
import {
  EmptyRow,
  inlineFormClass,
  StatusBadge,
  StepIndicator,
  SubHeading,
  statusTone,
} from "@/components/ops/ui-parts-2";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { DescriptionList, EmptyState, PageHeader, Section } from "@/components/ui/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { listContractsAwaitingDelivery, listDeliveryDetails } from "@/lib/ops/delivery";
import { type DeliveryPreparationData, getDeliveryPreparation } from "@/lib/ops/delivery-preparation";
import { isUuid } from "@/lib/ops/form";
import {
  DELIVERY_STATUS_LABEL,
  DOMAIN_INTENT_LABEL,
  DOMAIN_MANAGER_LABEL,
  fmtDate,
  label,
  TRI_LABEL,
} from "@/lib/ops/format";
import { listDomainPreferencesForOps } from "@/lib/ops/queries";
import { getCurrentActor } from "@/lib/session";
import {
  confirmDomainPreferenceAction,
  createDeliveryAction,
  recordPublicationAction,
  sendToCustomerReviewAction,
  transitionDeliveryAction,
} from "../actions";

export default async function DeliveryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const focus = typeof sp.focus === "string" ? sp.focus : undefined;
  const contract = typeof sp.contract === "string" ? sp.contract : undefined;
  const domain = typeof sp.domain === "string" ? sp.domain : undefined;
  for (const key of ["focus", "contract", "domain"]) {
    if (sp[key] !== undefined && (typeof sp[key] !== "string" || !isUuid(sp[key]))) notFound();
  }
  if ([focus, contract, domain].filter(Boolean).length > 1) notFound();
  const focused = !!(focus || contract || domain);
  const db = getDb();
  const actor = await getCurrentActor();
  const [prefs, awaiting, details] = await Promise.all([
    focus || contract ? Promise.resolve(ok([])) : listDomainPreferencesForOps(db, actor, { id: domain }),
    focus || domain ? Promise.resolve(ok([])) : listContractsAwaitingDelivery(db, actor, { id: contract }),
    domain ? Promise.resolve(ok([])) : listDeliveryDetails(db, actor, { id: focus, contractId: contract }),
  ]);
  if (!prefs.ok || !awaiting.ok || !details.ok) return <Forbidden />;
  // 古い「着手」リンクも、既に作成された納品へ案内する。
  if (contract && details.value[0]) redirect(`/ops/delivery?focus=${details.value[0].delivery.id}`);
  if ((focus && !details.value.length) || (contract && !awaiting.value.length) || (domain && !prefs.value.length))
    notFound();
  const preparation = focus ? await getDeliveryPreparation(db, actor, focus) : null;
  if (preparation && !preparation.ok) return <Forbidden />;
  const here = focus
    ? `/ops/delivery?focus=${focus}`
    : contract
      ? `/ops/delivery?contract=${contract}`
      : domain
        ? `/ops/delivery?domain=${domain}`
        : "/ops/delivery";

  return (
    <>
      <PageHeader title="制作・公開" description="制作の進行と顧客確認、公開までを管理します。" />
      {focused && (
        <p className="mb-4 text-sm">
          選んだ案件の作業を表示中です。{" "}
          <Link href="/ops/delivery" className="text-primary underline">
            一覧へ戻る
          </Link>
        </p>
      )}
      <Flash searchParams={sp} />
      {details.value.some((d) => d.delivery.status === "building") && <DiscoveryRefresh />}
      <nav className="mb-6 flex flex-wrap gap-3 text-sm" aria-label="制作・公開の作業">
        <Link className="text-primary underline" href="/ops">
          今日の仕事へ
        </Link>
        {!focused && (
          <>
            <a className="text-primary underline" href="#delivery-start">
              制作の着手
            </a>
            <a className="text-primary underline" href="#delivery-progress">
              制作中の案件
            </a>
            <a className="text-primary underline" href="#domain-preferences">
              ドメイン確認
            </a>
          </>
        )}
      </nav>

      {!focus && !domain && (
        <Section
          id="delivery-start"
          title="制作の着手"
          description="契約が完了した案件です。納品の管理を開始し、掲載情報・素材・ドメイン希望を確認してから制作へ進みます。"
        >
          <div className="grid gap-3">
            {awaiting.value.map((c) => (
              <article
                id={`contract-start-${c.contractId}`}
                key={c.contractId}
                className="flex scroll-mt-24 flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-5 shadow-sm"
              >
                <div className="min-w-0 space-y-2">
                  <Badge variant="warning">契約完了・制作未着手</Badge>
                  <h3 className="font-semibold">
                    <Link href={`/ops/companies/${c.companyId}`}>{c.companyName}</Link>
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    営業：{c.salesName} · 契約完了：{fmtDate(c.completedAt)}
                  </p>
                </div>
                <form action={createDeliveryAction}>
                  <ReturnTo path={here} />
                  <input type="hidden" name="contractId" value={c.contractId} />
                  <SubmitButton pendingLabel="準備しています…">納品の管理を開始する</SubmitButton>
                </form>
              </article>
            ))}
          </div>
          {awaiting.value.length === 0 && (
            <EmptyState>
              制作未着手の契約はありません。
              <Link href="/ops/contracts" className="text-primary underline">
                契約の確認へ
              </Link>
            </EmptyState>
          )}
          {!contract && awaiting.value.length >= 100 && (
            <p className="text-sm text-muted-foreground">
              古い契約から100件を表示しています。着手すると、続きの案件が表示されます。
            </p>
          )}
        </Section>
      )}

      {!contract && !domain && (
        <Section
          id="delivery-progress"
          title="制作・顧客確認・公開の記録・納品"
          description={
            <>
              流れ：{DELIVERY_STATUSES.map((st) => label(DELIVERY_STATUS_LABEL, st)).join(" → ")}。
              制作版はワーカーが作ります。制作中は状態を自動更新します。<a href={here}>手動で更新する</a>
              こともできます。
            </>
          }
        >
          {details.value.length === 0 ? <EmptyState>納品はまだありません</EmptyState> : null}
          <div className="grid gap-4">
            {details.value.map((d) => (
              <DeliveryCard
                key={d.delivery.id}
                d={d}
                here={here}
                preparation={preparation?.ok ? preparation.value : undefined}
              />
            ))}
          </div>
        </Section>
      )}

      {!focus && !contract && (
        <Section
          id="domain-preferences"
          title="ドメイン希望の確認"
          description="未確認の古い記録から表示します。確認後に営業が聞き取り内容を更新すると、再び未確認になります。"
        >
          <details className="rounded-lg border bg-muted/30 px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium">確認のポイント：管理権限・メール・取得の可否</summary>
            <div className="mt-3 space-y-2 text-muted-foreground">
              <p>{EXISTING_DOMAIN_REVIEW_NOTICE}</p>
              <p>{NEW_DOMAIN_AVAILABILITY_NOTICE}</p>
              <p>この画面では希望内容の確認を記録します。取得・移管・DNS変更は実行されません。</p>
            </div>
          </details>
          <div className="grid gap-4">
            {prefs.value.map(({ d, companyName, recordedByName }) => (
              <article
                id={`domain-${d.id}`}
                key={d.id}
                className="scroll-mt-24 overflow-hidden rounded-xl border bg-card shadow-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
                  <div className="min-w-0">
                    <h3 className="font-semibold">
                      <Link href={`/ops/companies/${d.companyId}`}>{companyName}</Link>
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      聞き取り：{recordedByName} · 更新 {fmtDate(d.updatedAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">{label(DOMAIN_INTENT_LABEL, d.intent)}</Badge>
                    <Badge variant={d.confirmedAt ? "success" : "warning"}>
                      {d.confirmedAt ? "確認済み" : "確認待ち"}
                    </Badge>
                  </div>
                </div>
                <div className="grid gap-5 p-5 lg:grid-cols-2">
                  <DescriptionList>
                    <dt>現在のURL</dt>
                    <dd className="break-all">{d.currentUrl ?? "未記入"}</dd>
                    <dt>現在のドメイン</dt>
                    <dd className="break-all">{d.currentDomain ?? "未記入"}</dd>
                    <dt>管理者</dt>
                    <dd>{label(DOMAIN_MANAGER_LABEL, d.currentManager)}</dd>
                    <dt>メールの利用</dt>
                    <dd>{label(TRI_LABEL, d.usesEmail)}</dd>
                  </DescriptionList>
                  <DescriptionList>
                    <dt>新規ドメイン候補</dt>
                    <dd className="break-all">
                      {d.newDomainCandidates.length ? d.newDomainCandidates.join(" / ") : "未記入"}
                    </dd>
                    <dt>企業の希望</dt>
                    <dd className="whitespace-pre-wrap">{d.customerWish ?? "未記入"}</dd>
                  </DescriptionList>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/30 px-5 py-4">
                  {d.confirmedAt ? (
                    <p className="text-sm text-success">確認済み：{fmtDate(d.confirmedAt)}</p>
                  ) : (
                    <>
                      <p className="max-w-xl text-sm text-muted-foreground">
                        希望内容・管理権限・メールへの影響を確認してから記録してください。ドメインの取得や設定は実行されません。
                      </p>
                      <form action={confirmDomainPreferenceAction}>
                        <ReturnTo path={here} />
                        <input type="hidden" name="id" value={d.id} />
                        <input type="hidden" name="revision" value={d.revision} />
                        <SubmitButton pendingLabel="記録しています…">この内容を確認済みにする</SubmitButton>
                      </form>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
          {prefs.value.length === 0 && <EmptyState>ドメイン希望の記録はありません</EmptyState>}
          {!domain && prefs.value.length >= 200 && (
            <p className="text-sm text-muted-foreground">
              未確認を優先して200件を表示しています。今日の仕事からは対象案件を直接開けます。
            </p>
          )}
        </Section>
      )}
    </>
  );
}

const DECISION_LABEL: Record<string, string> = { approved: "承認", changes_requested: "修正依頼" };

/** 状態を変えるだけのボタン（制作へ・運営確認へ・納品済みへ） */
function StepButton({
  deliveryId,
  to,
  here,
  variant = "default",
  children,
}: {
  deliveryId: string;
  to: "building" | "ops_review" | "delivered";
  here: string;
  variant?: "default" | "outline" | "success";
  children: string;
}) {
  return (
    <form action={transitionDeliveryAction} className={inlineFormClass}>
      <ReturnTo path={here} />
      <input type="hidden" name="deliveryId" value={deliveryId} />
      <input type="hidden" name="to" value={to} />
      <Button type="submit" size="sm" variant={variant}>
        {children}
      </Button>
    </form>
  );
}

function DeliveryCard({
  d,
  here,
  preparation,
}: {
  d: DeliveryDetail;
  here: string;
  preparation?: DeliveryPreparationData | undefined;
}) {
  const { delivery } = d;
  const status = delivery.status;
  const versionLabel = new Map(d.versions.map((v) => [v.id, `第${v.version}版`]));
  const reviewVersion = d.versions.find((v) => v.id === delivery.reviewVersionId);
  const rejectedVersion = Math.max(
    0,
    ...d.approvals
      .filter((a) => a.decision === "changes_requested")
      .map((a) => d.versions.find((v) => v.id === a.deliveryVersionId)?.version ?? 0),
  );
  const latestRequest = d.approvals.find(
    (a) =>
      a.decision === "changes_requested" &&
      d.versions.find((v) => v.id === a.deliveryVersionId)?.version === rejectedVersion,
  );
  const hasRevision = d.versions.some(
    (v) =>
      v.version > rejectedVersion &&
      !!v.artifactDir &&
      (!delivery.currentBuildId || v.buildId === delivery.currentBuildId),
  );
  const interrupted = d.build?.status === "running" && (!d.build.leaseUntil || d.build.leaseUntil <= new Date());
  const failed = d.build?.status === "failed" || interrupted;
  const reviewOptions =
    status === "customer_review"
      ? reviewVersion
        ? [{ id: reviewVersion.id, label: `第${reviewVersion.version}版（顧客確認中）` }]
        : []
      : d.versions
          .filter(
            (v) =>
              v.artifactDir &&
              v.version > rejectedVersion &&
              (!delivery.currentBuildId || v.buildId === delivery.currentBuildId),
          )
          .map((v) => ({ id: v.id, label: `第${v.version}版` }));
  const locked = delivery.lockedVersionId ? (versionLabel.get(delivery.lockedVersionId) ?? "固定済み") : "未固定";
  const steps = DELIVERY_STATUSES.map((st) => ({ key: st, label: label(DELIVERY_STATUS_LABEL, st) }));

  return (
    <details
      id={`delivery-${delivery.id}`}
      open={status !== "delivered"}
      className="group rounded-xl border bg-card shadow-sm"
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm">
        <strong className="font-semibold text-base">{d.companyName}</strong>
        <span className="inline-flex items-center gap-1.5">
          状態：
          <Badge variant={statusTone(status)}>{label(DELIVERY_STATUS_LABEL, status)}</Badge>
        </span>
        <span className="text-muted-foreground text-xs tabular-nums">
          版 {d.versions.length} 件・公開対象版 {locked}・更新 {fmtDate(delivery.updatedAt)}
        </span>
      </summary>

      <div className="space-y-4 border-t px-5 py-4">
        <StepIndicator steps={steps} current={status} />
        {preparation && <DeliveryPreparation data={preparation} />}
        {latestRequest && (
          <section
            aria-label="顧客からの修正依頼"
            className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4"
          >
            <h3 className="font-semibold text-sm">第{rejectedVersion}版への修正依頼</h3>
            <p className="text-xs text-muted-foreground">受付：{fmtDate(latestRequest.decidedAt)}</p>
            <p className="whitespace-pre-wrap break-words text-sm">{latestRequest.comment}</p>
            <p className="text-sm">
              {status === "building"
                ? "修正内容を制作処理へ引き継ぎます。新しい版ができたら、反映結果と事実関係を運営で確認してください。"
                : status === "customer_review"
                  ? "修正版は顧客の確認待ちです。この依頼に対する修正結果をご確認いただいています。"
                  : delivery.lockedVersionId
                    ? "修正後の版は顧客承認済みです。この依頼は過去の記録として表示しています。"
                    : "修正版を確認するときは、この依頼内容が反映されているかも確認してください。"}
            </p>
          </section>
        )}

        <div className="space-y-3 rounded-lg bg-muted/50 p-4">
          {status === "info_gathering" ? (
            <>
              <p className="text-muted-foreground text-sm">
                制作に進めると、新しい制作依頼を受け付けます。制作・検査が完了すると運営確認へ進みます。
              </p>
              {!preparation ? (
                <Link
                  href={`/ops/delivery?focus=${delivery.id}`}
                  className="inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                >
                  制作内容を確認する
                </Link>
              ) : preparation.blockers.length ? (
                <p className="text-sm text-amber-800">上の確認事項を解消してから、この画面を開き直してください。</p>
              ) : (
                <StepButton deliveryId={delivery.id} to="building" here={here}>
                  確認して制作に進める
                </StepButton>
              )}
            </>
          ) : null}
          {status === "building" && (
            <section aria-label="制作処理の状態" className="space-y-3">
              <p className="font-medium text-sm">
                {failed
                  ? "制作が停止しています"
                  : d.build?.status === "running"
                    ? "制作・検査を進めています"
                    : "制作の受付待ちです"}
              </p>
              {failed ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    {interrupted
                      ? "制作処理との接続が途切れました。ワーカーの稼働を確認してください。"
                      : d.build?.error}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    設定や入力内容を確認して再試行してください。新しい制作依頼として処理します。
                  </p>
                  <DeliveryBuildRetry key={d.build!.id} deliveryId={delivery.id} buildId={d.build!.id} />
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  完了すると新しい版が運営確認へ進みます。再登録は不要です。
                </p>
              )}
              <Link
                href={`/ops/processing?company=${d.companyId}#processing-deliveries`}
                className="text-sm text-primary underline"
              >
                ワーカーの状態を確認
              </Link>
              {hasRevision && d.build?.status !== "running" && (
                <StepButton deliveryId={delivery.id} to="ops_review" here={here}>
                  運営確認に回す
                </StepButton>
              )}
            </section>
          )}
          {status === "ops_review" || status === "customer_review" ? (
            <>
              <p className="text-muted-foreground text-sm">
                {status === "ops_review"
                  ? "運営が確認した版を顧客確認に回すと、顧客に渡す期限付きの共有リンクを発行します。発行履歴から再表示できます。"
                  : "顧客の判断（承認・修正依頼）を待っています。控え忘れたリンクは履歴から再表示できます。期限切れの場合は新しく発行してください。"}
              </p>
              {reviewOptions.length ? (
                <CustomerReviewForm
                  action={sendToCustomerReviewAction}
                  deliveryId={delivery.id}
                  versions={reviewOptions}
                  reissue={status === "customer_review"}
                />
              ) : (
                <p className="text-sm text-amber-800">
                  顧客へ確認を依頼できる修正版がありません。制作へ戻して新しい版を用意してください。
                </p>
              )}
              <StepButton deliveryId={delivery.id} to="building" here={here} variant="outline">
                {status === "ops_review" ? "制作に差し戻す" : "顧客確認を取り下げて制作に戻す"}
              </StepButton>
            </>
          ) : null}
          {status === "ready" ? (
            <>
              <p className="text-muted-foreground text-sm">
                顧客が承認した版（{locked}
                ）を公開対象として固定しました。公開は記録だけを残します。AWSへの公開・DNS変更・稼働確認は行いません（現時点の範囲外）。
              </p>
              <form action={recordPublicationAction} className="flex flex-wrap items-end gap-3">
                <ReturnTo path={here} />
                <input type="hidden" name="deliveryId" value={delivery.id} />
                <Field label="環境" htmlFor={`env-${delivery.id}`}>
                  <Input
                    id={`env-${delivery.id}`}
                    name="environment"
                    defaultValue="production"
                    size={12}
                    required
                    className="w-40"
                  />
                </Field>
                <Field label="公開URL（任意）" htmlFor={`url-${delivery.id}`}>
                  <Input
                    id={`url-${delivery.id}`}
                    name="url"
                    type="url"
                    size={30}
                    placeholder="https://"
                    className="w-72 max-w-full"
                  />
                </Field>
                <Button type="submit" size="sm">
                  公開を記録する
                </Button>
              </form>
            </>
          ) : null}
          {status === "published" ? (
            <StepButton deliveryId={delivery.id} to="delivered" here={here} variant="success">
              納品済みにする
            </StepButton>
          ) : null}
          {status === "delivered" ? <p className="text-muted-foreground text-sm">納品済みです。</p> : null}
        </div>

        <div className="grid gap-x-6 xl:grid-cols-2">
          <div className="min-w-0">
            <SubHeading>制作版</SubHeading>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>版</TableHead>
                  <TableHead>成果物</TableHead>
                  <TableHead>作成</TableHead>
                  <TableHead>扱い</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.versions.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell className="whitespace-nowrap font-medium">第{v.version}版</TableCell>
                    <TableCell>
                      {v.artifactDir ? (
                        <Link
                          href={`/ops/delivery/${delivery.id}/review?version=${v.id}`}
                          className="font-medium text-primary underline underline-offset-4"
                        >
                          制作版を確認
                        </Link>
                      ) : (
                        <Badge variant="warning">成果物なし</Badge>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{fmtDate(v.createdAt)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {v.id === delivery.lockedVersionId ? <Badge variant="success">公開対象（固定）</Badge> : null}
                        {v.version <= rejectedVersion ? <Badge variant="warning">修正前・再提出不可</Badge> : null}
                        {v.id === delivery.reviewVersionId ? <Badge variant="warning">顧客確認中</Badge> : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {d.versions.length === 0 ? <EmptyRow colSpan={4}>版はまだありません</EmptyRow> : null}
              </TableBody>
            </Table>
          </div>

          <div className="min-w-0">
            <SubHeading>顧客の判断</SubHeading>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日時</TableHead>
                  <TableHead>版</TableHead>
                  <TableHead>判断</TableHead>
                  <TableHead>コメント</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.approvals.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="whitespace-nowrap tabular-nums">{fmtDate(a.decidedAt)}</TableCell>
                    <TableCell className="whitespace-nowrap">{versionLabel.get(a.deliveryVersionId) ?? "—"}</TableCell>
                    <TableCell>
                      <StatusBadge map={DECISION_LABEL} status={a.decision} />
                    </TableCell>
                    <TableCell className="whitespace-pre-wrap">{a.comment ?? "—"}</TableCell>
                  </TableRow>
                ))}
                {d.approvals.length === 0 ? <EmptyRow colSpan={4}>顧客の判断はまだありません</EmptyRow> : null}
              </TableBody>
            </Table>
          </div>
        </div>

        <CustomerReviewLinks deliveryId={delivery.id} revision={delivery.updatedAt.toISOString()} />

        <div>
          <SubHeading>公開の記録</SubHeading>
          {d.deployments.length === 0 ? (
            <p className="text-muted-foreground text-sm">記録はありません</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日時</TableHead>
                  <TableHead>環境</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead>版</TableHead>
                  <TableHead>状態</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.deployments.map((x) => (
                  <TableRow key={x.id}>
                    <TableCell className="whitespace-nowrap tabular-nums">{fmtDate(x.createdAt)}</TableCell>
                    <TableCell>{x.environment}</TableCell>
                    <TableCell className="break-all">{x.url ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">{versionLabel.get(x.deliveryVersionId) ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{x.status === "recorded" ? "記録のみ（実公開なし）" : x.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </details>
  );
}
