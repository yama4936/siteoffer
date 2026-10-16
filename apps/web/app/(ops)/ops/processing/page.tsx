import { systemClock } from "@siteoffer/core";
import { discoveryAvailability } from "@siteoffer/discovery";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DiscoveryRefresh } from "@/components/ops/discovery-refresh";
import { DiscoveryStatus } from "@/components/ops/discovery-status";
import { PageHeader } from "@/components/ui/page";
import { getDb } from "@/lib/db";
import { fmtDate } from "@/lib/ops/format";
import { getProcessingOverview, PHASE_LABELS } from "@/lib/ops/processing";
import { requireUser } from "@/lib/session";

export default async function ProcessingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("ops");
  const sp = await searchParams;
  const company = typeof sp.company === "string" ? sp.company : undefined;
  if (sp.company !== undefined && !company) notFound();
  const db = getDb();
  const result = await getProcessingOverview(db, systemClock, user.actor, company, {
    discovery: Number(sp.discoveryPage),
    images: Number(sp.imagesPage),
    sites: Number(sp.sitesPage),
  });
  if (!result.ok) notFound();
  const d = result.value;
  const discovery = await discoveryAvailability(db, systemClock);
  const groups = [
    {
      name: "収集",
      kind: "discovery",
      ...d.paging.discovery,
      rows: d.discovery.map((j) => ({
        id: j.id,
        title: j.provider,
        status: j.status === "queued" ? "開始待ち" : "収集中",
        since: j.startedAt ?? j.createdAt,
        href: `/ops/discovery/${j.id}`,
      })),
    },
    {
      name: "画像生成",
      kind: "images",
      ...d.paging.images,
      rows: d.images.map((j) => ({
        id: j.id,
        title: `${j.companyName} · 画像 第${j.version}版`,
        status: j.status === "queued" ? "開始待ち" : "生成中",
        since: j.since,
        href: `/ops/designs?company=${j.companyId}&design=${j.id}`,
      })),
    },
    {
      name: "サイト制作",
      kind: "sites",
      ...d.paging.sites,
      rows: d.sites.map((j) => ({
        id: j.id,
        title: `${j.companyName} · 画像 第${j.version}版から制作`,
        status: j.status === "generating" ? "制作中" : "開始待ち",
        since: j.since,
        href: `/ops/designs?company=${j.companyId}&design=${j.id}`,
      })),
    },
  ];
  function pageHref(kind: string, page: number) {
    const q = new URLSearchParams();
    if (company) q.set("company", company);
    for (const [key, value] of Object.entries(d.paging)) q.set(`${key}Page`, String(key === kind ? page : value.page));
    return `/ops/processing?${q}#processing-${kind}`;
  }
  function workerNotice(w: (typeof d.workers)[number]) {
    return (
      <li key={w.id} className="border-t pt-3 text-sm">
        <p className="font-medium">
          ワーカー {d.workers.findIndex((item) => item.id === w.id) + 1} ·{" "}
          {w.live ? "稼働通知あり" : "通知を確認できません"} · {w.mode === "demo" ? "デモ起動" : "通常起動"}
        </p>
        <p className="mt-1">
          {!w.live && "最終記録："}
          {w.phase ? PHASE_LABELS[w.phase] : "受付状況は未通知"}
          {w.since ? `（${fmtDate(w.since)}から）` : ""}
        </p>
        {w.intakeOverdue && (
          <p className="mt-1 text-amber-800">
            稼働通知はありますが、受付待機の更新が遅れています。ワーカーのログを確認してください。
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          最終通知 {fmtDate(w.heartbeatAt)} · 最終受付完了 {fmtDate(w.completedAt)}
        </p>
      </li>
    );
  }
  return (
    <>
      <PageHeader title="処理の状況" description="依頼の待機状況と、処理するワーカーの通知を確認できます。" />
      <DiscoveryRefresh />
      {company && (
        <p className="mb-4 text-sm">
          {d.companyName}の制作を表示中 ·{" "}
          <Link className="text-primary underline" href="/ops/processing">
            全案件を見る
          </Link>
        </p>
      )}
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        {(
          [
            ["画像生成", d.image],
            ["サイト制作", d.site],
          ] as const
        ).map(([name, state]) => (
          <section key={name} className="rounded-xl border bg-card p-5">
            <h2 className="font-semibold">{name}</h2>
            <p className={`mt-2 font-medium ${state.status === "ready" ? "text-success" : "text-amber-800"}`}>
              {state.label}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{state.detail}</p>
          </section>
        ))}
      </div>
      {!company && <DiscoveryStatus capabilities={discovery} />}
      <section className="mb-6 rounded-xl border bg-card p-5" aria-label="ワーカーの通知">
        <h2 className="font-semibold">ワーカーの通知</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          稼働通知だけで個別の処理成功は判断できません。通知があっても受付処理が長く変わらない場合は、管理者が処理履歴とログを確認してください。
        </p>
        <ul className="mt-4 space-y-4">{d.workers.filter((w) => w.live).map(workerNotice)}</ul>
        {!d.workers.some((w) => w.live) && <p className="mt-4 text-sm">現在の稼働通知がありません。</p>}
        {d.workers.some((w) => !w.live) && (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer">過去の通知（{d.workers.filter((w) => !w.live).length}件）</summary>
            <ul className="mt-3 space-y-4">{d.workers.filter((w) => !w.live).map(workerNotice)}</ul>
          </details>
        )}
      </section>
      <p className="mb-4 text-sm text-muted-foreground">
        待機中・実行中を古い順に20件ずつ表示します。経過時間だけで失敗には変更しません。失敗した処理の再試行は、各案件の内容と履歴を確認してから行ってください。
      </p>
      {groups
        .filter((g) => !company || g.name !== "収集")
        .map((g) => (
          <section
            key={g.name}
            id={`processing-${g.kind}`}
            className="mb-6 scroll-mt-24"
            aria-label={`${g.name}の待機・実行中`}
          >
            <h2 className="mb-3 text-lg font-semibold">
              {g.name} · {g.total}件
            </h2>
            {!g.rows.length && (
              <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
                待機中・実行中の依頼はありません。
              </p>
            )}
            <ul className="space-y-2">
              {g.rows.map((j) => (
                <li
                  key={j.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4 text-sm"
                >
                  <div className="min-w-0">
                    <h3 className="break-words font-semibold">{j.title}</h3>
                    <p className="mt-1 text-muted-foreground">
                      {j.status} · {fmtDate(j.since)}から
                    </p>
                  </div>
                  <Link className="rounded-md border px-3 py-2 text-primary" href={j.href}>
                    依頼・結果を確認
                  </Link>
                </li>
              ))}
            </ul>
            {g.pages > 1 && (
              <nav aria-label={`${g.name}のページ`} className="mt-3 flex items-center justify-between gap-2 text-sm">
                {g.page > 1 ? (
                  <Link className="rounded-md border px-3 py-2 text-primary" href={pageHref(g.kind, g.page - 1)}>
                    前の20件
                  </Link>
                ) : (
                  <span />
                )}
                <span>
                  {g.page} / {g.pages}ページ
                </span>
                {g.page < g.pages ? (
                  <Link className="rounded-md border px-3 py-2 text-primary" href={pageHref(g.kind, g.page + 1)}>
                    次の20件
                  </Link>
                ) : (
                  <span />
                )}
              </nav>
            )}
          </section>
        ))}
      <details className="mb-6 rounded-xl border bg-card p-5 text-sm">
        <summary className="cursor-pointer font-medium">管理者向け：起動・設定の確認</summary>
        <div className="mt-3 space-y-2 leading-relaxed">
          <p>
            Web画面とワーカーが同じDBへ接続しているか、ワーカーのプロセスとログを確認します。設定を変更した場合はワーカーを再起動してください。
          </p>
          <p>
            画像生成にはワーカー側のOPENAI_API_KEYが必要です。収集専用モード（SITEOFFER_DISCOVERY_ONLY=true）は画像・サイトを処理しません。画像生成を使わない場合は画像の取り込みで進められます。
          </p>
          <p>
            サイト制作はSITEOFFER_GENERATORの設定を確認してください。mockは動作確認用、codexは認証・実行環境の設定が必要です。ワーカー更新後は新しい稼働通知が届くことも確認してください。
          </p>
          <p>この画面から処理の強制終了・再実行・課金を伴うAPI呼び出しは行いません。</p>
        </div>
      </details>
    </>
  );
}
