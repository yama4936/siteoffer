import { systemClock } from "@siteoffer/core";
import { discoveryAvailability } from "@siteoffer/discovery";
import { getAuditRecoveryCandidates } from "@siteoffer/worker/audit-recovery";
import { AUDIT_REQUEST_VIEWS, listAuditRequests } from "@siteoffer/worker/audit-request-management";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AuditRecovery } from "@/components/ops/audit-recovery";
import { AuditRequests } from "@/components/ops/audit-requests";
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
  const deliveryState = sp.deliveryState ?? "all";
  if (deliveryState !== "all" && deliveryState !== "stopped") notFound();
  const db = getDb();
  const result = await getProcessingOverview(
    db,
    systemClock,
    user.actor,
    company,
    {
      discovery: Number(sp.discoveryPage),
      images: Number(sp.imagesPage),
      sites: Number(sp.sitesPage),
      deliveries: Number(sp.deliveriesPage),
      handoffs: Number(sp.handoffsPage),
    },
    deliveryState,
  );
  if (!result.ok) notFound();
  const d = result.value;
  const recovery = await getAuditRecoveryCandidates(db, user.actor, company, Number(sp.auditPage));
  if (!recovery.ok) notFound();
  const recoverable = recovery.value;
  if (
    (sp.requestView !== undefined && typeof sp.requestView !== "string") ||
    (sp.requestQuery !== undefined && typeof sp.requestQuery !== "string")
  )
    notFound();
  const requests = await listAuditRequests(db, user.actor, {
    companyId: company,
    view: sp.requestView as string | undefined,
    query: sp.requestQuery as string | undefined,
    page: Number(sp.requestPage),
  });
  if (!requests.ok) notFound();
  const requested = requests.value;

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
      name: "診断後の制作受付",
      kind: "handoffs",
      ...d.paging.handoffs,
      rows: d.handoffs.map((j) => ({
        id: j.id,
        title: j.companyName,
        since: j.since,
        status: j.state === "sending" ? "引き継ぎ中" : j.state === "retry" ? "自動再送待ち" : "提案制作の受付待ち",
        detail: j.state === "retry" ? `再送受付：${fmtDate(j.nextAttemptAt)}以降` : null,
        href: `/ops/companies/${j.companyId}`,
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
    {
      name: "納品サイトの制作",
      kind: "deliveries",
      ...d.paging.deliveries,
      rows: d.deliveries.map((j) => ({
        id: j.id,
        title: j.companyName,
        attention: j.state === "failed" || j.state === "interrupted",
        status: {
          queued: "開始待ち",
          running: "制作・検査中",
          failed: "停止中・再試行が必要",
          interrupted: "接続が途切れています・再試行が必要",
          unknown: "制作状態の確認が必要",
        }[j.state],
        since: j.since,
        href: `/ops/delivery?focus=${j.id}#delivery-${j.id}`,
      })),
    },
  ];
  function pageHref(kind: string, page: number) {
    const q = new URLSearchParams();
    if (company) q.set("company", company);
    q.set("requestPage", String(kind === "requests" ? page : requested.page));
    q.set("requestView", requested.view);
    if (requested.query) q.set("requestQuery", requested.query);

    q.set("auditPage", String(kind === "audit" ? page : recoverable.page));
    if (deliveryState === "stopped") q.set("deliveryState", "stopped");
    for (const [key, value] of Object.entries(d.paging)) q.set(`${key}Page`, String(key === kind ? page : value.page));
    return `/ops/processing?${q}#${kind === "audit" ? "audit-recovery" : kind === "requests" ? "audit-requests" : `processing-${kind}`}`;
  }
  function requestFilterHref(view: string) {
    const u = new URL(pageHref("requests", 1), "http://local.invalid");
    u.searchParams.set("requestView", view);
    return `${u.pathname}${u.search}${u.hash}`;
  }
  const requestSearchFields = Array.from(
    new URL(pageHref("requests", 1), "http://local.invalid").searchParams.entries(),
  ).filter(([key]) => key !== "requestQuery");
  function deliveryFilterHref(state: "all" | "stopped") {
    const url = new URL(pageHref("deliveries", 1), "http://local.invalid");
    url.searchParams.set("deliveryState", state);
    return `${url.pathname}${url.search}${url.hash}`;
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
          {d.companyName}の処理を表示中 ·{" "}
          <Link className="text-primary underline" href="/ops/processing">
            全案件を見る
          </Link>
        </p>
      )}
      <AuditRecovery
        {...recoverable}
        previousHref={pageHref("audit", recoverable.page - 1)}
        nextHref={pageHref("audit", recoverable.page + 1)}
      />
      <AuditRequests
        data={requested}
        filters={Object.entries(AUDIT_REQUEST_VIEWS).map(([key, label]) => ({
          key,
          label,
          count: requested.counts[key as keyof typeof AUDIT_REQUEST_VIEWS],
          href: requestFilterHref(key),
        }))}
        searchFields={requestSearchFields}
        previousHref={pageHref("requests", requested.page - 1)}
        nextHref={pageHref("requests", requested.page + 1)}
      />
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
        待機中・実行中を古い順に20件ずつ表示します。納品サイトの制作は停止した依頼も表示します。再試行は案件の内容と停止理由を確認してから行ってください。
      </p>
      {groups
        .filter((g) => !company || g.name !== "収集")
        .map((g) => (
          <section
            key={g.name}
            id={`processing-${g.kind}`}
            className="mb-6 scroll-mt-24"
            aria-label={g.kind === "deliveries" ? "納品サイトの制作状況" : `${g.name}の待機・実行中`}
          >
            <h2 className="mb-3 text-lg font-semibold">
              {g.name} · {g.total}件
            </h2>
            {g.kind === "handoffs" && (
              <p className="mb-3 text-sm text-muted-foreground">
                診断結果と制作依頼は保存済みです。制作ワーカーが稼働すると自動で引き継ぎます。同じ診断を重ねて依頼する必要はありません。
              </p>
            )}
            {g.kind === "deliveries" && (
              <nav className="mb-3 flex flex-wrap gap-2 text-sm" aria-label="納品制作の表示対象">
                {(["all", "stopped"] as const).map((state) => (
                  <Link
                    key={state}
                    href={deliveryFilterHref(state)}
                    aria-current={deliveryState === state ? "page" : undefined}
                    className={`rounded-md border px-3 py-2 ${deliveryState === state ? "bg-primary text-primary-foreground" : "text-primary"}`}
                  >
                    {state === "all" ? "待機・実行・停止" : "停止した制作だけ"}
                  </Link>
                ))}
              </nav>
            )}
            {!g.rows.length && (
              <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
                {g.kind === "deliveries"
                  ? deliveryState === "stopped"
                    ? "停止した制作はありません。"
                    : "制作中・停止中の納品サイトはありません。"
                  : "待機中・実行中の依頼はありません。"}
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
                    <p
                      className={`mt-1 ${"attention" in j && j.attention ? "font-medium text-amber-800" : "text-muted-foreground"}`}
                    >
                      {j.status} · {fmtDate(j.since)}から
                    </p>
                    {"detail" in j && typeof j.detail === "string" && (
                      <p className="mt-1 text-xs text-muted-foreground">{j.detail}</p>
                    )}
                  </div>
                  <Link className="rounded-md border px-3 py-2 text-primary" href={j.href}>
                    {"attention" in j && j.attention ? "停止理由・再試行を確認" : "依頼・結果を確認"}
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
