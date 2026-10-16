import {
  DELIVERY_STATUSES,
  type DeliveryDetail,
  EXISTING_DOMAIN_REVIEW_NOTICE,
  NEW_DOMAIN_AVAILABILITY_NOTICE,
} from "@siteoffer/core";
import Link from "next/link";
import { CustomerReviewForm } from "@/components/ops/customer-review-form";
import { Flash, Forbidden, ReturnTo } from "@/components/ops/ui";
import {
  EmptyRow,
  inlineFormClass,
  StatusBadge,
  StepIndicator,
  SubHeading,
  statusTone,
} from "@/components/ops/ui-parts-2";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { EmptyState, PageHeader, Section } from "@/components/ui/page";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { listContractsAwaitingDelivery, listDeliveryDetails } from "@/lib/ops/delivery";
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
  const db = getDb();
  const actor = await getCurrentActor();
  const [prefs, awaiting, details] = await Promise.all([
    listDomainPreferencesForOps(db, actor),
    listContractsAwaitingDelivery(db, actor),
    listDeliveryDetails(db, actor),
  ]);
  if (!prefs.ok || !awaiting.ok || !details.ok) return <Forbidden />;
  const here = "/ops/delivery";

  return (
    <>
      <PageHeader title="制作・公開" description="制作の進行と顧客確認、公開までを管理します。" />
      <Flash searchParams={await searchParams} />

      <Section
        title="契約完了で納品がまだない契約"
        description="契約確認が完了（契約完了）した契約ごとに納品を1件作ります。作成すると「情報確認」から始まります。"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>企業</TableHead>
              <TableHead>営業</TableHead>
              <TableHead>契約完了</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {awaiting.value.map((c) => (
              <TableRow key={c.contractId}>
                <TableCell className="font-medium">
                  <Link href={`/ops/companies/${c.companyId}`}>{c.companyName}</Link>
                </TableCell>
                <TableCell>{c.salesName}</TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">{fmtDate(c.completedAt)}</TableCell>
                <TableCell>
                  <form action={createDeliveryAction} className={inlineFormClass}>
                    <ReturnTo path={here} />
                    <input type="hidden" name="contractId" value={c.contractId} />
                    <Button type="submit" size="xs">
                      納品を作成する
                    </Button>
                  </form>
                </TableCell>
              </TableRow>
            ))}
            {awaiting.value.length === 0 ? (
              <EmptyRow colSpan={4}>
                納品を作成できる契約はありません（契約の確認は「4. 商品条件・契約・入金・報酬」で行います）
              </EmptyRow>
            ) : null}
          </TableBody>
        </Table>
      </Section>

      <Section
        title="制作・顧客確認・公開の記録・納品"
        description={
          <>
            流れ：{DELIVERY_STATUSES.map((st) => label(DELIVERY_STATUS_LABEL, st)).join(" → ")}。
            制作版はワーカーが作ります。状態はこの画面を<a href={here}>再読み込み</a>すると最新になります。
          </>
        }
      >
        {details.value.length === 0 ? <EmptyState>納品はまだありません</EmptyState> : null}
        <div className="grid gap-4">
          {details.value.map((d) => (
            <DeliveryCard key={d.delivery.id} d={d} here={here} />
          ))}
        </div>
      </Section>

      <Section title="ドメイン希望（未確認を先に表示）">
        <Alert variant="info">
          <AlertDescription>
            <p>{EXISTING_DOMAIN_REVIEW_NOTICE}</p>
            <p>{NEW_DOMAIN_AVAILABILITY_NOTICE}</p>
            <p>実設定・移管・DNS変更はこの画面では行いません（AWSの実環境構築は範囲外）。</p>
          </AlertDescription>
        </Alert>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>企業</TableHead>
              <TableHead>希望</TableHead>
              <TableHead>現在のURL・ドメイン</TableHead>
              <TableHead>新規候補</TableHead>
              <TableHead>管理者・メール</TableHead>
              <TableHead>企業の希望</TableHead>
              <TableHead>記録</TableHead>
              <TableHead>運営確認</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {prefs.value.map(({ d, companyName, recordedByName }) => (
              <TableRow key={d.id}>
                <TableCell className="font-medium">
                  <Link href={`/ops/companies/${d.companyId}`}>{companyName}</Link>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{label(DOMAIN_INTENT_LABEL, d.intent)}</Badge>
                </TableCell>
                <TableCell className="break-all">
                  {d.currentUrl ?? "—"}
                  <div className="text-muted-foreground text-xs">{d.currentDomain ?? ""}</div>
                </TableCell>
                <TableCell className="break-all">
                  {d.newDomainCandidates.length ? d.newDomainCandidates.join(", ") : "—"}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  管理：{label(DOMAIN_MANAGER_LABEL, d.currentManager)}
                  <br />
                  メール：{label(TRI_LABEL, d.usesEmail)}
                </TableCell>
                <TableCell className="min-w-40">{d.customerWish ?? "—"}</TableCell>
                <TableCell>
                  {recordedByName}
                  <div className="whitespace-nowrap text-muted-foreground text-xs tabular-nums">
                    {fmtDate(d.updatedAt)}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col items-start gap-1.5">
                    {d.needsOpsReview ? <Badge variant="warning">要確認</Badge> : null}
                    {d.confirmedAt ? (
                      <span className="whitespace-nowrap text-success text-xs tabular-nums">
                        確認済み {fmtDate(d.confirmedAt)}
                      </span>
                    ) : (
                      <form action={confirmDomainPreferenceAction} className={inlineFormClass}>
                        <ReturnTo path={here} />
                        <input type="hidden" name="id" value={d.id} />
                        <Button type="submit" size="xs" variant="outline">
                          確認済みにする
                        </Button>
                      </form>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {prefs.value.length === 0 ? <EmptyRow colSpan={8}>ドメイン希望の記録はありません</EmptyRow> : null}
          </TableBody>
        </Table>
      </Section>
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

function DeliveryCard({ d, here }: { d: DeliveryDetail; here: string }) {
  const { delivery } = d;
  const status = delivery.status;
  const versionLabel = new Map(d.versions.map((v) => [v.id, `第${v.version}版`]));
  const reviewVersion = d.versions.find((v) => v.id === delivery.reviewVersionId);
  const reviewOptions =
    status === "customer_review"
      ? reviewVersion
        ? [{ id: reviewVersion.id, label: `第${reviewVersion.version}版（顧客確認中）` }]
        : []
      : d.versions.filter((v) => v.artifactDir).map((v) => ({ id: v.id, label: `第${v.version}版` }));
  const locked = delivery.lockedVersionId ? (versionLabel.get(delivery.lockedVersionId) ?? "固定済み") : "未固定";
  const steps = DELIVERY_STATUSES.map((st) => ({ key: st, label: label(DELIVERY_STATUS_LABEL, st) }));

  return (
    <details open={status !== "delivered"} className="group rounded-xl border bg-card shadow-sm">
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

        <div className="space-y-3 rounded-lg bg-muted/50 p-4">
          {status === "info_gathering" ? (
            <>
              <p className="text-muted-foreground text-sm">
                制作に進めると、ワーカーが制作版を作ります（制作中で版のない納品を拾って処理します。数秒〜）。
              </p>
              <StepButton deliveryId={delivery.id} to="building" here={here}>
                制作に進める
              </StepButton>
            </>
          ) : null}
          {status === "building" ? (
            d.versions.length === 0 ? (
              <Alert variant="warning">
                <AlertDescription>
                  <p>
                    ワーカーが制作版を作っています（数秒〜）。<a href={here}>再読み込み</a>すると版が表示されます。
                  </p>
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <p className="text-muted-foreground text-sm">
                  制作版があります。内容を確認するため運営確認に回してください。
                  差し戻し後に新しい版が要る場合、ワーカーが新しい版を作るかはワーカーの処理条件によります。
                </p>
                <StepButton deliveryId={delivery.id} to="ops_review" here={here}>
                  運営確認に回す
                </StepButton>
              </>
            )
          ) : null}
          {status === "ops_review" || status === "customer_review" ? (
            <>
              <p className="text-muted-foreground text-sm">
                {status === "ops_review"
                  ? "運営が確認した版を顧客確認に回すと、顧客に渡すURL（期限付きの共有リンク）をこの場で一度だけ表示します。"
                  : "顧客の判断（承認・修正依頼）を待っています。リンクを控え忘れた・期限が切れた場合は再発行できます。"}
              </p>
              <CustomerReviewForm
                action={sendToCustomerReviewAction}
                deliveryId={delivery.id}
                versions={reviewOptions}
                reissue={status === "customer_review"}
              />
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
                        <code className="break-all text-xs">{v.artifactDir}</code>
                      ) : (
                        <Badge variant="warning">成果物なし</Badge>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{fmtDate(v.createdAt)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {v.id === delivery.lockedVersionId ? <Badge variant="success">公開対象（固定）</Badge> : null}
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
