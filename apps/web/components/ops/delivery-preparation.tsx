import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { DescriptionList } from "@/components/ui/page";
import type { DeliveryPreparationData } from "@/lib/ops/delivery-preparation";
import { DOMAIN_INTENT_LABEL, DOMAIN_MANAGER_LABEL, TRI_LABEL, yen } from "@/lib/ops/format";
import { DeliverySupplement } from "./delivery-supplement";

function scopeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(scopeText).filter(Boolean).join("\n");
  if (value && typeof value === "object")
    return Object.entries(value)
      .map(([key, v]) => `${key === "description" ? "" : `${key}：`}${scopeText(v)}`)
      .join("\n");
  return value == null ? "" : String(value);
}
export function DeliveryPreparation({ data: d }: { data: DeliveryPreparationData }) {
  const companyHref = `/ops/companies/${d.company.id}`;
  return (
    <section aria-label="制作の準備" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold">制作の準備</h3>
          <p className="mt-1 text-sm text-muted-foreground">制作に使う提案・デザインと、現在の登録情報を確認します。</p>
        </div>
        <Badge variant={d.blockers.length ? "warning" : "success"}>
          {d.blockers.length ? `開始前の確認 ${d.blockers.length}件` : "制作入力の参照を確認済み"}
        </Badge>
      </div>
      {d.blockers.length > 0 && (
        <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <p className="font-semibold">以下を確認してから制作を開始してください</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {d.blockers.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      )}
      {d.supplementation.needed && (
        <DeliverySupplement deliveryId={d.deliveryId} companyId={d.company.id} data={d.supplementation} />
      )}
      {d.supplement && (
        <p className="text-sm text-muted-foreground">
          納品用の補完 第{d.supplement.revision}版を使用します。契約原本は契約画面で確認できます。
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="min-w-0 space-y-3 rounded-xl border p-4">
          <h4 className="font-semibold text-sm">制作に使う提供範囲</h4>
          <DescriptionList>
            <dt>商品・条件版</dt>
            <dd>
              {d.scope?.name ?? "記録なし"}
              {d.scope?.version ? ` / ${d.scope.version}` : ""}
            </dd>
            <dt>契約価格</dt>
            <dd>
              {yen(d.scope?.price ?? null)}
              {d.scope?.monthlyFee != null ? ` / 月額 ${yen(d.scope.monthlyFee)}` : ""}
            </dd>
            <dt>提供範囲</dt>
            <dd className="whitespace-pre-wrap">{scopeText(d.scope?.scope) || "契約資料で確認してください"}</dd>
            <dt>提案版</dt>
            <dd>{d.proposal ? `第${d.proposal.version}版` : "未記録"}</dd>
          </DescriptionList>
          <Link href={`/ops/contracts?focus=${d.contractId}`} className="text-sm text-primary underline">
            契約内容を開く
          </Link>
        </section>
        <section className="min-w-0 space-y-3 rounded-xl border p-4">
          <h4 className="font-semibold text-sm">制作に使うデザイン</h4>
          {d.design ? (
            <>
              <p className="text-sm">
                第{d.design.version}版 · {d.design.status === "approved" ? "承認済み" : "承認状態を要確認"}
              </p>
              {d.design.hasImage && (
                <a
                  href={`/ops/designs/${d.design.id}/image`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="制作に使うデザイン画像を別タブで開く"
                >
                  {/* biome-ignore lint/performance/noImgElement: 認証Cookieが必要な画像は直接取得する */}
                  <img
                    src={`/ops/designs/${d.design.id}/image`}
                    alt={`制作に使うデザイン 第${d.design.version}版`}
                    className="max-h-56 w-full rounded-lg border object-contain object-top"
                  />
                </a>
              )}
              <Link
                href={`/ops/designs?company=${d.company.id}&design=${d.design.id}`}
                className="text-sm text-primary underline"
              >
                デザインと制作条件を開く
              </Link>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">デザイン画像の記録がありません。</p>
          )}
        </section>
        <section className="min-w-0 space-y-3 rounded-xl border p-4">
          <h4 className="font-semibold text-sm">掲載する会社情報</h4>
          <DescriptionList>
            <dt>会社名</dt>
            <dd>{d.company.name}</dd>
            <dt>住所</dt>
            <dd>{d.company.address || "未登録・顧客への確認が必要"}</dd>
            <dt>電話</dt>
            <dd>{d.company.phone || "未登録・顧客への確認が必要"}</dd>
            <dt>業種</dt>
            <dd>{d.company.industry || "未登録"}</dd>
          </DescriptionList>
          <p className="text-xs text-muted-foreground">登録情報です。掲載内容の正確さは顧客と確認してください。</p>
          <Link href={`${companyHref}#company-information`} className="text-sm text-primary underline">
            会社情報を確認・修正
          </Link>
        </section>
        <section className="min-w-0 space-y-3 rounded-xl border p-4">
          <h4 className="font-semibold text-sm">ドメイン・メールの希望</h4>
          {d.domain ? (
            <>
              <Badge variant={d.domain.confirmed ? "success" : "warning"}>
                {d.domain.confirmed ? "運営確認済み" : "運営確認が必要"}
              </Badge>
              <DescriptionList>
                <dt>希望</dt>
                <dd>{DOMAIN_INTENT_LABEL[d.domain.intent]}</dd>
                <dt>現在のドメイン</dt>
                <dd>{d.domain.currentDomain || "未登録"}</dd>
                <dt>管理者</dt>
                <dd>{DOMAIN_MANAGER_LABEL[d.domain.manager]}</dd>
                <dt>メール利用</dt>
                <dd>{TRI_LABEL[d.domain.usesEmail]}</dd>
                {d.domain.candidates.length > 0 && (
                  <>
                    <dt>新規の候補</dt>
                    <dd>{d.domain.candidates.join(" / ")}</dd>
                  </>
                )}
              </DescriptionList>
              {d.domain.wish && <p className="whitespace-pre-wrap break-words text-sm">{d.domain.wish}</p>}
              <Link href={`/ops/delivery?domain=${d.domain.id}`} className="text-sm text-primary underline">
                聞き取り内容を確認する
              </Link>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              希望の記録がありません。営業担当に聞き取りを依頼してください。
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            希望の確認とドメイン取得・移管の完了は別です。公開前に設定を確認します。
          </p>
        </section>
        <section className="min-w-0 space-y-3 rounded-xl border p-4">
          <h4 className="font-semibold text-sm">画像素材の利用許諾</h4>
          <p className="text-sm">
            登録 {d.assets.total}件 / 本番利用の確認済み {d.assets.production}件 / 次回の制作で配置 {d.assets.ready}件
          </p>
          <p className="text-xs text-muted-foreground">
            画像ファイルを登録し、本番利用と配置先を確認した素材を次回の制作へ渡します。未確認・デモ限定の素材は本番に使用しません。
          </p>
          <p className="text-sm">今回の制作に固定した素材 {d.assets.currentBuildCount}件</p>
          {!d.assets.currentBuildAllowed && (
            <p role="alert" className="text-sm text-destructive">
              今回使用した画像の利用許諾を確認できません。素材の許諾を確認するか、使用画像を変更して再制作してください。顧客向け共有は停止中です。公開前に許諾を確認してください。
            </p>
          )}
          <Link href={`${companyHref}#image-assets`} className="text-sm text-primary underline">
            素材と利用許諾を確認
          </Link>
        </section>
        <section className="min-w-0 space-y-3 rounded-xl border p-4">
          <h4 className="font-semibold text-sm">お知らせ・既存サイトの引き継ぎ</h4>
          <p className="whitespace-pre-wrap break-words text-sm">
            {d.design?.updatePlan || "既存の記事・更新方法を確認し、引き継ぐ範囲を決めてください。"}
          </p>
          <p className="text-sm">
            登録記事 {d.articles.total}件 / 公開済み {d.articles.published}件
          </p>
          <p className="text-xs text-muted-foreground">
            元サイトの記事が自動で移行されたことを示す件数ではありません。
          </p>
          <Link href={`/ops/content?company=${d.company.id}`} className="text-sm text-primary underline">
            記事・お知らせを管理
          </Link>
        </section>
      </div>
      {d.notices.length > 0 && (
        <details open className="rounded-lg border p-3 text-sm">
          <summary className="cursor-pointer font-medium">引き継ぎ時の確認事項（{d.notices.length}件）</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {d.notices.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
