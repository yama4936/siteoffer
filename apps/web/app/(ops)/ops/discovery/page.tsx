import Link from "next/link";
import { Flash, Forbidden, first, ReturnTo } from "@/components/ops/ui";
import { getDb } from "@/lib/db";
import { DISCOVERY_PROVIDERS } from "@/lib/ops/commands";
import {
  fmtDate,
  JOB_STATUS_LABEL,
  label,
  OFFICIAL_SITE_LABEL,
  PIPELINE_LABEL,
  SUPPRESSION_LABEL,
  shortId,
} from "@/lib/ops/format";
import { type CompanyFilter, listCompanies, listDiscoveryJobs } from "@/lib/ops/queries";
import { getCurrentActor } from "@/lib/session";
import { createDiscoveryJobAction } from "../actions";

function oneOf(map: Record<string, string>, v: string | undefined): string | undefined {
  return v && Object.hasOwn(map, v) ? v : undefined;
}

export default async function DiscoveryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const actor = await getCurrentActor();
  const db = getDb();
  const filter: CompanyFilter = {
    q: first(sp, "q") || undefined,
    prefecture: first(sp, "prefecture") || undefined,
    // 列挙値以外はDBに渡さない
    pipelineStatus: oneOf(PIPELINE_LABEL, first(sp, "pipeline")) as CompanyFilter["pipelineStatus"],
    officialSiteStatus: oneOf(OFFICIAL_SITE_LABEL, first(sp, "official")) as CompanyFilter["officialSiteStatus"],
    suppressed: first(sp, "suppressed") === "yes" ? true : first(sp, "suppressed") === "no" ? false : undefined,
  };
  const jobs = await listDiscoveryJobs(db, actor);
  const cs = await listCompanies(db, actor, filter);
  if (!jobs.ok || !cs.ok) return <Forbidden />;
  const qs = new URLSearchParams(
    Object.entries(sp).flatMap(([k, v]) => (typeof v === "string" && k !== "msg" && k !== "error" ? [[k, v]] : [])),
  ).toString();
  const here = `/ops/discovery${qs ? `?${qs}` : ""}`;

  return (
    <main>
      <h1>1. 収集条件・ジョブ・候補</h1>
      <Flash searchParams={sp} />

      <section>
        <h2>収集ジョブの登録</h2>
        <p className="muted">
          条件を保存してジョブを登録します。実行はワーカーが行います。業種分類は未決のため自由記述です。
          所在地はキーワードではなく出典のある住所で判定されます。
        </p>
        <form action={createDiscoveryJobAction} className="stack">
          <ReturnTo path="/ops/discovery" />
          <label>
            取得元
            <select name="provider" defaultValue="fixture">
              {DISCOVERY_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p === "fixture" ? "fixture（架空企業・開発用）" : `${p}（国税庁法人番号API）`}
                </option>
              ))}
            </select>
          </label>
          <label>
            都道府県
            <input name="prefecture" placeholder="愛知県" />
          </label>
          <label>
            市区町村（前方一致。指定するときは都道府県も必須）
            <input name="city" placeholder="名古屋市" />
          </label>
          <label>
            市区町村コード（5桁・任意）
            <input name="cityCode" inputMode="numeric" pattern="\d{5}" />
          </label>
          <label>
            業種
            <input name="industry" placeholder="建設" />
          </label>
          <label>
            企業名に含まれる語（空白・読点区切り。所在地の判定には使いません）
            <input name="keywords" />
          </label>
          <label>
            上限件数（1〜1000、既定50）
            <input name="limit" type="number" min={1} max={1000} />
          </label>
          <button type="submit">ジョブを登録</button>
        </form>
      </section>

      <section>
        <h2>収集ジョブ</h2>
        <p className="muted">
          登録したジョブ（待機）はワーカーが拾って実行します（数秒〜）。実行後は状態が「成功」などに変わり、
          収集した企業が下の候補一覧に増えます。診断・提案の生成もワーカーが続けて行い、企業の状態が進みます。
          {jobs.value.some((j) => j.status === "queued" || j.status === "running") ? (
            <strong className="warn"> 処理中のジョブがあります。</strong>
          ) : null}{" "}
          <a href={here}>再読み込みして最新の状態を表示</a>
        </p>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>取得元</th>
              <th>条件</th>
              <th>状態</th>
              <th>件数（取得/新規/更新/スキップ/失敗）</th>
              <th>試行</th>
              <th>失敗理由</th>
              <th>登録・終了</th>
            </tr>
          </thead>
          <tbody>
            {jobs.value.map((j) => (
              <tr key={j.id}>
                <td>
                  <Link href={`/ops/discovery/${j.id}`}>{shortId(j.id)}</Link>
                </td>
                <td>{j.provider}</td>
                <td>
                  <code>{JSON.stringify(j.criteria)}</code>
                </td>
                <td>{label(JOB_STATUS_LABEL, j.status)}</td>
                <td>
                  {j.foundCount}/{j.createdCount}/{j.updatedCount}/{j.skippedCount}/{j.failedCount}
                </td>
                <td>{j.attempts}</td>
                <td>
                  {j.error ? <span className="warn">{j.error}</span> : null}
                  {Array.isArray(j.failures) && j.failures.length > 0 ? (
                    <span> 候補の失敗・スキップ {j.failures.length}件</span>
                  ) : null}
                </td>
                <td>
                  {fmtDate(j.createdAt)}
                  <br />
                  {fmtDate(j.finishedAt)}
                </td>
              </tr>
            ))}
            {jobs.value.length === 0 ? (
              <tr>
                <td colSpan={8} className="muted">
                  ジョブはまだありません
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section>
        <h2>企業候補</h2>
        <form className="inline" method="get" action="/ops/discovery">
          <input name="q" placeholder="企業名・法人番号" defaultValue={filter.q ?? ""} />
          <input name="prefecture" placeholder="都道府県" defaultValue={filter.prefecture ?? ""} />
          <select name="official" defaultValue={filter.officialSiteStatus ?? ""}>
            <option value="">公式サイト：すべて</option>
            {Object.entries(OFFICIAL_SITE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select name="pipeline" defaultValue={filter.pipelineStatus ?? ""}>
            <option value="">準備段階：すべて</option>
            {Object.entries(PIPELINE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select name="suppressed" defaultValue={first(sp, "suppressed") ?? ""}>
            <option value="">抑止：すべて</option>
            <option value="no">抑止なし</option>
            <option value="yes">抑止あり</option>
          </select>
          <button type="submit">絞り込み</button>
        </form>
        <table>
          <thead>
            <tr>
              <th>企業名</th>
              <th>法人番号</th>
              <th>所在地</th>
              <th>業種</th>
              <th>公式サイト</th>
              <th>準備段階</th>
              <th>営業抑止</th>
              <th>更新</th>
            </tr>
          </thead>
          <tbody>
            {cs.value.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link href={`/ops/companies/${c.id}?returnTo=${encodeURIComponent(here)}`}>{c.name}</Link>
                </td>
                <td>{c.corporateNumber ?? "不明"}</td>
                <td>
                  {[c.prefecture, c.city].filter(Boolean).join(" ") || "不明"}
                  {c.addressSourceUrl ? null : c.prefecture ? <span className="muted">（出典なし）</span> : null}
                </td>
                <td>{c.industry ?? "不明"}</td>
                <td className={c.officialSiteStatus === "needs_review" ? "warn" : undefined}>
                  {label(OFFICIAL_SITE_LABEL, c.officialSiteStatus)}
                </td>
                <td>{label(PIPELINE_LABEL, c.pipelineStatus)}</td>
                <td>{label(SUPPRESSION_LABEL, c.suppression)}</td>
                <td>{fmtDate(c.updatedAt)}</td>
              </tr>
            ))}
            {cs.value.length === 0 ? (
              <tr>
                <td colSpan={8} className="muted">
                  該当する候補はありません
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <p className="muted">最大200件まで表示します。</p>
      </section>
    </main>
  );
}
