import { isTermsReadyForSales } from "@siteoffer/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import type * as React from "react";
import { Flash, Forbidden, Json, ReturnTo } from "@/components/ops/ui";
import { detailsClass, inlineFormClass, StatusBadge, stackFormClass, summaryClass } from "@/components/ops/ui-parts-2";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, Label } from "@/components/ui/label";
import { EmptyState, PageHeader, Section } from "@/components/ui/page";
import { NativeSelect } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/ops/form";
import {
  CONTRACT_STATUS_LABEL,
  fmtDate,
  PAYMENT_STATUS_LABEL,
  REWARD_STATUS_LABEL,
  rewardRuleText,
  yen,
} from "@/lib/ops/format";
import { listContractsOverview, listProductTerms } from "@/lib/ops/queries";
import { termsIssueText } from "@/lib/ops/sellable";
import { getCurrentActor } from "@/lib/session";
import {
  adjustRewardAction,
  cancelRewardAction,
  confirmContractAction,
  createProductTermsAction,
  markRewardPaidAction,
  recordPaymentAction,
  rejectContractAction,
  scheduleRewardAction,
  setProductTermsActiveAction,
  startContractReviewAction,
  updatePaymentStatusAction,
} from "../actions";

const here = "/ops/contracts";

export default async function ContractsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const focus = typeof sp.focus === "string" ? sp.focus : undefined;
  if (focus && !isUuid(focus)) notFound();
  const db = getDb();
  const actor = await getCurrentActor();
  const [terms, list] = await Promise.all([
    listProductTerms(db, actor),
    listContractsOverview(db, actor, { id: focus }),
  ]);
  if (!terms.ok || !list.ok) return <Forbidden />;

  return (
    <>
      <PageHeader title="契約・報酬" description="販売条件から契約確認、入金、報酬まで。" />
      {focus && (
        <p className="mb-4 text-sm">
          今日の仕事から選んだ案件を表示中です。{" "}
          <Link href="/ops/contracts" className="text-primary underline">
            全件を表示
          </Link>
        </p>
      )}
      <Flash searchParams={await searchParams} />

      <Section
        title="販売条件・報酬条件の版"
        description={
          <>
            販売価格・報酬額は未決です。既存の版は書き換えず、新しい版を作ります。完了した契約は完了時の写しで固定され、後の変更の影響を受けません（AC-16）。
            価格・報酬条件が未設定の版は保存できますが、その版では営業可能にできません。無効化は新しい担当確保を止め、すでに引き継いだ商談の条件は維持します。
          </>
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>版</TableHead>
              <TableHead>名称</TableHead>
              <TableHead>範囲</TableHead>
              <TableHead className="text-right">販売価格</TableHead>
              <TableHead className="text-right">月額</TableHead>
              <TableHead>報酬条件</TableHead>
              <TableHead>営業に使えるか</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {terms.value.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="whitespace-nowrap font-medium">{t.version}</TableCell>
                <TableCell>{t.name}</TableCell>
                <TableCell className="min-w-48">
                  <Json value={t.scope} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{yen(t.price)}</TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">
                  {t.monthlyFee === null ? "—" : yen(t.monthlyFee)}
                </TableCell>
                <TableCell>{rewardRuleText(t.rewardRule)}</TableCell>
                <TableCell>
                  {isTermsReadyForSales(t) ? (
                    <Badge variant="success">使える</Badge>
                  ) : (
                    <Badge variant="warning" className="whitespace-normal">
                      使えない（{termsIssueText(t)}）
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <form action={setProductTermsActiveAction} className={inlineFormClass}>
                    <ReturnTo path={here} />
                    <input type="hidden" name="productTermsId" value={t.id} />
                    <input type="hidden" name="active" value={t.active ? "false" : "true"} />
                    <Button type="submit" size="xs" variant="outline">
                      {t.active ? "無効にする" : "有効にする"}
                    </Button>
                  </form>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <details className={detailsClass}>
          <summary className={summaryClass}>新しい版を作成する</summary>
          <form action={createProductTermsAction} className={stackFormClass}>
            <ReturnTo path={here} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="版（一意。例：2026-10-a）" htmlFor="terms-version">
                <Input id="terms-version" name="version" required />
              </Field>
              <Field label="名称" htmlFor="terms-name">
                <Input id="terms-name" name="name" required />
              </Field>
            </div>
            <Field label="提供範囲（ページ数・修正回数・納期など）" htmlFor="terms-scope">
              <Textarea id="terms-scope" name="scope" rows={3} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="販売価格（円・空欄は未設定）" htmlFor="terms-price">
                <Input id="terms-price" name="price" inputMode="numeric" className="tabular-nums" />
              </Field>
              <Field label="月額（円・任意）" htmlFor="terms-monthly">
                <Input id="terms-monthly" name="monthlyFee" inputMode="numeric" className="tabular-nums" />
              </Field>
            </div>
            <Field label="報酬条件の種類" htmlFor="terms-reward-type">
              <NativeSelect id="terms-reward-type" name="rewardType" defaultValue="">
                <option value="">未設定</option>
                <option value="fixed">定額（円）</option>
                <option value="rate">販売価格に対する割合（万分率。1000 = 10%）</option>
              </NativeSelect>
            </Field>
            <Field label="報酬条件の値" htmlFor="terms-reward-value">
              <Input id="terms-reward-value" name="rewardValue" inputMode="numeric" className="tabular-nums" />
            </Field>
            <div>
              <Button type="submit" size="sm">
                版を作成
              </Button>
            </div>
          </form>
        </details>
      </Section>

      <Section
        title="契約（成約報告）"
        description="営業ユーザーの成約報告だけでは報酬は発生しません。運営が契約資料を確認して契約完了にしたときに、報酬が1回だけ発生します。契約確定時に納品準備も作成します。入金と報酬は別に記録します。"
      >
        {list.value.length === 0 ? <EmptyState>契約はまだありません</EmptyState> : null}
        <div className="grid gap-4">
          {list.value.map(({ c, companyName, salesName, payments, reward }) => (
            <Card id={`contract-${c.id}`} key={c.id} className="gap-3">
              <CardHeader>
                <CardTitle>
                  <h3>
                    <Link href={`/ops/companies/${c.companyId}`}>{companyName}</Link>
                  </h3>
                </CardTitle>
                <CardDescription>
                  営業：{salesName} ·{" "}
                  <Link href={`/ops/assignments/${c.assignmentId}/conditions`} className="text-primary underline">
                    条件変更・履歴
                  </Link>
                </CardDescription>
                <CardAction className="text-right">
                  <StatusBadge map={CONTRACT_STATUS_LABEL} status={c.status} />
                  {c.closeReason ? <div className="mt-1 text-muted-foreground text-xs">{c.closeReason}</div> : null}
                </CardAction>
              </CardHeader>
              <CardContent className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
                <Block title="報告・資料">
                  <div className="tabular-nums">報告 {fmtDate(c.reportedAt)}</div>
                  <div className="break-all">資料：{c.documentRef ?? "未登録"}</div>
                  {c.reportNote ? <div className="text-muted-foreground text-xs">{c.reportNote}</div> : null}
                </Block>

                <Block title="契約確認">
                  {c.status === "completed" ? (
                    <>
                      <div className="tabular-nums">完了 {fmtDate(c.completedAt)}</div>
                      <Link
                        href={`/ops/delivery?contract=${c.id}`}
                        className="inline-flex rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground"
                      >
                        納品準備を開く
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        会社情報・素材・ドメインを確認し、制作へ進みます。
                      </p>
                      <details>
                        <summary className={summaryClass}>契約時点の写し</summary>
                        <div className="mt-2">
                          <Json value={c.snapshot} />
                        </div>
                      </details>
                    </>
                  ) : null}
                  {c.status === "reported" ? (
                    <form action={startContractReviewAction} className={inlineFormClass}>
                      <ReturnTo path={here} />
                      <input type="hidden" name="contractId" value={c.id} />
                      <Button type="submit" size="xs" variant="outline">
                        確認を開始
                      </Button>
                    </form>
                  ) : null}
                  {c.status === "reported" || c.status === "under_review" ? (
                    <>
                      <form action={confirmContractAction} className="grid gap-2">
                        <ReturnTo path={here} />
                        <input type="hidden" name="contractId" value={c.id} />
                        {c.salesOfferId ? (
                          <div className="rounded border p-2 text-sm">
                            <p className="font-medium">報告時の引き継ぎ条件で確定</p>
                            {terms.value
                              .filter((t) => t.id === c.productTermsId)
                              .map((t) => (
                                <p key={t.id}>
                                  {t.name}（{t.version}）<br />
                                  {yen(t.price)} / 月額 {t.monthlyFee === null ? "未設定" : yen(t.monthlyFee)}
                                  <br />
                                  {rewardRuleText(t.rewardRule)}
                                </p>
                              ))}
                          </div>
                        ) : (
                          <NativeSelect
                            name="productTermsId"
                            defaultValue={c.productTermsId ?? ""}
                            aria-label="条件の版"
                            className="h-8"
                          >
                            <option value="">条件の版（報告時の版を使う）</option>
                            {terms.value
                              .filter((t) => isTermsReadyForSales(t))
                              .map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.version}：{yen(t.price)} / {rewardRuleText(t.rewardRule)}
                                </option>
                              ))}
                          </NativeSelect>
                        )}
                        <Input
                          name="documentRef"
                          placeholder="契約資料の参照（未登録なら必須）"
                          defaultValue={c.documentRef ?? ""}
                          aria-label="契約資料の参照"
                          className="h-8"
                        />
                        <div>
                          <Button type="submit" size="xs" variant="success">
                            契約完了を確認
                          </Button>
                        </div>
                      </form>
                      <form action={rejectContractAction} className={inlineFormClass}>
                        <ReturnTo path={here} />
                        <input type="hidden" name="contractId" value={c.id} />
                        <Input
                          name="reason"
                          placeholder="差し戻しの理由（必須）"
                          required
                          aria-label="差し戻しの理由"
                          className="h-8 flex-1"
                        />
                        <Button type="submit" size="xs" variant="outline">
                          差し戻し
                        </Button>
                      </form>
                    </>
                  ) : null}
                </Block>

                <Block title="入金">
                  {payments.map((p) => (
                    <div key={p.id} className="space-y-1.5 rounded-md border px-2.5 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium tabular-nums">{yen(p.amount)}</span>
                        <StatusBadge map={PAYMENT_STATUS_LABEL} status={p.status} />
                        {p.receivedAt ? (
                          <span className="text-muted-foreground text-xs tabular-nums">
                            （{fmtDate(p.receivedAt)}）
                          </span>
                        ) : null}
                      </div>
                      {p.status === "pending" || p.status === "received" ? (
                        <div className="flex flex-wrap gap-1.5">
                          {p.status === "pending" ? (
                            <>
                              <PaymentButton paymentId={p.id} status="received" text="入金済みにする" />
                              <PaymentButton paymentId={p.id} status="cancelled" text="取消" />
                            </>
                          ) : null}
                          {p.status === "received" ? (
                            <PaymentButton paymentId={p.id} status="refunded" text="返金にする" />
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
                  {c.status === "completed" ? (
                    <form action={recordPaymentAction} className={inlineFormClass}>
                      <ReturnTo path={here} />
                      <input type="hidden" name="contractId" value={c.id} />
                      <Input
                        name="amount"
                        inputMode="numeric"
                        placeholder="金額（円）"
                        required
                        size={10}
                        aria-label="金額（円）"
                        className="h-8 w-28 tabular-nums"
                      />
                      <Label className="font-normal">
                        <Input type="checkbox" name="received" /> 入金済み
                      </Label>
                      <Input name="note" placeholder="メモ" size={10} aria-label="メモ" className="h-8 w-28" />
                      <Button type="submit" size="xs">
                        入金を記録
                      </Button>
                    </form>
                  ) : null}
                </Block>

                <Block title="報酬">
                  {reward ? (
                    <>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusBadge map={REWARD_STATUS_LABEL} status={reward.reward.status} />
                        <span>
                          ：現在額 <span className="font-medium tabular-nums">{yen(reward.currentAmount)}</span>
                        </span>
                        <span className="text-muted-foreground text-xs tabular-nums">
                          （発生時 {yen(reward.reward.amount)}）
                        </span>
                      </div>
                      {reward.reward.scheduledFor ? (
                        <div className="tabular-nums">支払予定 {fmtDate(reward.reward.scheduledFor)}</div>
                      ) : null}
                      {reward.reward.paidAt ? (
                        <div className="tabular-nums">支払済み {fmtDate(reward.reward.paidAt)}</div>
                      ) : null}
                      {reward.adjustments.map((adj) => (
                        <div key={adj.id} className="text-muted-foreground text-xs tabular-nums">
                          調整 {adj.delta > 0 ? "+" : ""}
                          {adj.delta.toLocaleString("ja-JP")}円：{adj.reason}（{fmtDate(adj.createdAt)}）
                        </div>
                      ))}
                      {reward.reward.status === "accrued" || reward.reward.status === "scheduled" ? (
                        <form action={scheduleRewardAction} className={inlineFormClass}>
                          <ReturnTo path={here} />
                          <input type="hidden" name="rewardId" value={reward.reward.id} />
                          <Input
                            type="date"
                            name="scheduledFor"
                            required
                            aria-label="支払予定日"
                            className="h-8 w-40"
                          />
                          <Button type="submit" size="xs" variant="outline">
                            支払予定を設定
                          </Button>
                        </form>
                      ) : null}
                      {reward.reward.status === "scheduled" ? (
                        <form action={markRewardPaidAction} className={inlineFormClass}>
                          <ReturnTo path={here} />
                          <input type="hidden" name="rewardId" value={reward.reward.id} />
                          <Button type="submit" size="xs" variant="success">
                            支払済みにする
                          </Button>
                        </form>
                      ) : null}
                      {reward.reward.status !== "cancelled" ? (
                        <form action={adjustRewardAction} className={inlineFormClass}>
                          <ReturnTo path={here} />
                          <input type="hidden" name="rewardId" value={reward.reward.id} />
                          <Input
                            name="delta"
                            inputMode="numeric"
                            placeholder="増減（円）"
                            required
                            size={8}
                            aria-label="増減（円）"
                            className="h-8 w-24 tabular-nums"
                          />
                          <Input
                            name="reason"
                            placeholder="理由（必須）"
                            required
                            size={10}
                            aria-label="調整の理由"
                            className="h-8 w-28"
                          />
                          <Button type="submit" size="xs" variant="outline">
                            調整
                          </Button>
                        </form>
                      ) : null}
                      {reward.reward.status === "accrued" || reward.reward.status === "scheduled" ? (
                        <form action={cancelRewardAction} className={inlineFormClass}>
                          <ReturnTo path={here} />
                          <input type="hidden" name="rewardId" value={reward.reward.id} />
                          <Input
                            name="reason"
                            placeholder="取消の理由（必須）"
                            required
                            size={10}
                            aria-label="取消の理由"
                            className="h-8 w-36"
                          />
                          <Button type="submit" size="xs" variant="destructive">
                            取消
                          </Button>
                        </form>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-muted-foreground">未発生</span>
                  )}
                </Block>
              </CardContent>
            </Card>
          ))}
        </div>
      </Section>
    </>
  );
}

/** 契約カードの中の1区画（報告・契約確認・入金・報酬） */
function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-2 text-sm">
      <h4 className="font-medium text-muted-foreground text-xs">{title}</h4>
      {children}
    </div>
  );
}

function PaymentButton({ paymentId, status, text }: { paymentId: string; status: string; text: string }) {
  return (
    <form action={updatePaymentStatusAction} className={inlineFormClass}>
      <ReturnTo path={here} />
      <input type="hidden" name="paymentId" value={paymentId} />
      <input type="hidden" name="status" value={status} />
      <Button type="submit" size="xs" variant={status === "received" ? "success" : "outline"}>
        {text}
      </Button>
    </form>
  );
}
