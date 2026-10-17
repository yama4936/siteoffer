import { systemClock } from "@siteoffer/core";
import { discoveryAvailability } from "@siteoffer/discovery";
import Link from "next/link";
import { Flash, Forbidden } from "@/components/ops/ui";
import { WorkQueue } from "@/components/ops/work-queue";
import { PageHeader } from "@/components/ui/page";
import { getDb } from "@/lib/db";
import { getOpsWorkQueue } from "@/lib/ops/work-queue";
import { getCurrentActor } from "@/lib/session";
import "@/components/ops/work-queue.css";

export default async function OpsHome({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const db = getDb();
  const r = await getOpsWorkQueue(db, await getCurrentActor());
  if (!r.ok) return <Forbidden />;
  const capabilities = await discoveryAvailability(db, systemClock);
  const live = capabilities.some((p) => p.ready);
  const nta = capabilities.find((p) => p.provider === "nta-corporate-number")?.ready;
  const images = !!(process.env.OPENAI_API_KEY && process.env.SITEOFFER_IMAGE_MODEL);
  return (
    <>
      <PageHeader
        title="今日の仕事"
        description="探す時間を減らして、案件を一歩先へ。確認が必要な仕事をまとめています。"
      />
      <Flash searchParams={await searchParams} />
      <WorkQueue {...r.value} updatedAt={systemClock.now().toISOString()} />
      <p className="my-4 text-sm">
        <Link href="/ops/processing" className="text-primary underline">
          待機中の処理・ワーカーの状態を確認
        </Link>
      </p>
      <section className="work-system" aria-label="運用の状態">
        <Link href="/ops/discovery">
          <span>収集ワーカー</span>
          <strong>{live ? "稼働を確認しました" : "起動・接続の確認が必要です"}</strong>
          <p>
            {nta
              ? "国税庁の収集を受け付けています。"
              : live
                ? "現在は架空企業の動作確認が利用できます。実収集の設定はこちら。"
                : "収集の受付状況と設定方法を確認できます。"}
          </p>
        </Link>
        <Link href="/ops/designs">
          <span>デザイン画像</span>
          <strong>{images ? "画像APIの設定あり" : "画像の取り込みで進められます"}</strong>
          <p>
            {images
              ? "APIの接続・生成結果は実行時に確認します。"
              : "制作条件を保存し、用意した画像を取り込んで承認・制作へ進めます。"}
          </p>
        </Link>
        <Link href="/ops/content">
          <span>公開後の更新</span>
          <strong>お知らせ・ブログを管理</strong>
          <p>下書き・公開内容・変更履歴を確認し、必要な記事だけを更新できます。</p>
        </Link>
      </section>
    </>
  );
}
