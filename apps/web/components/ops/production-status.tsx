import Link from "next/link";
import { Section } from "@/components/ui/page";
import { fmtDate } from "@/lib/ops/format";
import type { getProductionStatusForOps, imageRequestReadiness } from "@/lib/ops/production-status";

type Production = Extract<Awaited<ReturnType<typeof getProductionStatusForOps>>, { ok: true }>["value"];
type ImageRequest = ReturnType<typeof imageRequestReadiness>;

export function ProductionModeNotice({ status }: { status: Production }) {
  return (
    <section
      className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-5 py-4"
      aria-label="サイト制作の現在の方式"
    >
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">サイト制作の現在の方式</p>
        <p
          className={`mt-1 font-semibold text-sm ${status.site.status === "ready" ? "text-primary" : "text-amber-800"}`}
        >
          {status.site.label}
        </p>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{status.site.detail}</p>
        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted-foreground">
          {status.preparation.map((item) => `${item.title}：${item.label}`).join(" ／ ")}
        </p>
      </div>
      <Link
        className="shrink-0 text-primary text-sm underline underline-offset-4"
        href="/ops/settings#production-status"
      >
        制作の準備を確認
      </Link>
    </section>
  );
}

export function ProductionSettings({ status, imageRequest }: { status: Production; imageRequest: ImageRequest }) {
  return (
    <Section
      id="production-status"
      className="scroll-mt-24"
      title="制作の動作モード"
      description={`ワーカーからの通知をもとに表示します。確認時点：${fmtDate(status.checkedAt)}。個別の成功は実行結果で確認します。`}
    >
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border bg-card p-5">
          <h3 className="text-sm font-medium">サイト制作</h3>
          <p className="mt-2 font-semibold text-sm">{status.site.label}</p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{status.site.detail}</p>
        </div>
        <div className="rounded-xl border bg-card p-5">
          <h3 className="text-sm font-medium">デザイン画像</h3>
          <p className="mt-2 font-semibold text-sm">{status.image.label}</p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{imageRequest.message}</p>
          <Link className="mt-3 inline-block text-primary text-sm underline" href="/ops/designs">
            デザイン画像を用意する
          </Link>
        </div>
      </div>
      <div className="rounded-xl border bg-card p-5">
        <h3 className="font-medium text-sm">診断から制作へ進むための準備</h3>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          ワーカーが実際に使う設定の通知です。実接続・成果物の品質・営業開始の承認を示すものではありません。
        </p>
        <dl className="mt-4 divide-y">
          {status.preparation.map((item) => (
            <div key={item.id} className="grid min-w-0 gap-2 py-4 sm:grid-cols-[10rem_1fr]">
              <dt className="font-medium text-sm">{item.title}</dt>
              <dd className="min-w-0 text-sm">
                <strong className={item.status === "configured" ? "text-primary" : "text-amber-800"}>
                  {item.label}
                </strong>
                <p className="mt-1 break-words text-muted-foreground leading-relaxed">{item.detail}</p>
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <Link href="/ops/processing" className="inline-block text-primary text-sm underline">
        待機中の依頼・停止確認・稼働通知を見る
      </Link>
      <details className="rounded-xl border bg-card p-5 text-sm">
        <summary className="cursor-pointer font-medium">管理者向け：ローカルで実生成を使う準備</summary>
        <div className="mt-4 space-y-3 leading-relaxed text-muted-foreground">
          <p>
            通常のローカルデモは架空データを使います。実生成は、既存の会社情報・診断・承認画像を確認してから、管理者が明示して選びます。
          </p>
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              起動中と同じDB・ポート設定の端末で <code className="break-all text-foreground">pnpm demo:doctor</code>{" "}
              を実行し、不足項目を確認します。この確認はモデルを呼びません。
            </li>
            <li>
              認証ファイルの参照・Dockerの生成／ビルド用イメージ・ネットワークを準備します。方式を変更する前に、元の方式で未完了の依頼を確認します。
            </li>
            <li>
              通常停止後に <code className="break-all text-foreground">pnpm demo:codex</code>{" "}
              で既存DBを継続起動します。以後の診断・提案・納品はCodexの利用枠を消費します。
            </li>
          </ol>
          <p>
            画像APIの利用には、Web側の画像モデル指定と、画像処理ワーカー側のAPIキーが必要です。契約・利用条件・利用料を確認してから設定してください。用意した画像の取り込みでも制作を進められます。
          </p>
          <p>
            事前確認の成功と、認証・API接続・生成品質・公開の確認は別です。詳しい環境別手順はリポジトリのREADMEとdemo/READMEを参照してください。
          </p>
        </div>
      </details>
    </Section>
  );
}
