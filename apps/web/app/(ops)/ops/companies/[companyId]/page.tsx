import { isTermsReadyForSales } from "@siteoffer/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AuditView } from "@/components/ops/audit-view";
import { Flash, Forbidden, first, Json, ReturnTo } from "@/components/ops/ui";
import { getDb } from "@/lib/db";
import { sellableIssueText } from "@/lib/ops/commands";
import { isUuid, safeReturnTo } from "@/lib/ops/form";
import {
  ASSIGNMENT_STATUS_LABEL,
  fmtDate,
  JOB_STATUS_LABEL,
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
import { getCurrentActor } from "@/lib/session";
import {
  excludeCandidateAction,
  makeSellableAction,
  reviewProposalAction,
  setOfficialSiteStatusAction,
  updateCandidateAction,
  withdrawSellableAction,
} from "../../actions";

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

  const d = r.value;
  const c = d.company;
  const here = `/ops/companies/${c.id}`;
  const back = safeReturnTo(first(sp, "returnTo") ?? null, "/ops/discovery");
  const latest = d.proposalVersions[0] ?? null;
  // 条件の版を選ぶ前の段階の理由（版の可否は選択肢に表示する）
  const baseIssues = sellableIssues({ company: c, latestVersion: latest, terms: null }).filter(
    (i) => i !== "terms_not_selected",
  );
  const readyTerms = terms.value.filter((t) => isTermsReadyForSales(t));

  return (
    <main>
      <p>
        <Link href={back}>← 一覧へ戻る</Link>
      </p>
      <h1>{c.name}</h1>
      <Flash searchParams={sp} />

      <section>
        <h2>基本情報</h2>
        <table>
          <tbody>
            <tr>
              <th>法人番号</th>
              <td>{c.corporateNumber ?? "不明"}</td>
              <th>準備段階</th>
              <td>{label(PIPELINE_LABEL, c.pipelineStatus)}</td>
            </tr>
            <tr>
              <th>所在地</th>
              <td>
                {[c.prefecture, c.city, c.address].filter(Boolean).join(" ") || "不明"}
                <br />
                <span className="muted">出典：{c.addressSourceUrl ?? "なし"}</span>
              </td>
              <th>公式サイト</th>
              <td>{label(OFFICIAL_SITE_LABEL, c.officialSiteStatus)}</td>
            </tr>
            <tr>
              <th>業種</th>
              <td>{c.industry ?? "不明"}</td>
              <th>営業抑止</th>
              <td>
                {label(SUPPRESSION_LABEL, c.suppression)}
                {c.suppressionReason ? `（${c.suppressionReason}）` : ""}
              </td>
            </tr>
            <tr>
              <th>代表窓口</th>
              <td>{c.representativePhone ?? "不明"}</td>
              <th>更新</th>
              <td>{fmtDate(c.updatedAt)}</td>
            </tr>
          </tbody>
        </table>

        <details>
          <summary>候補を修正する</summary>
          <form action={updateCandidateAction} className="stack">
            <ReturnTo path={here} />
            <input type="hidden" name="companyId" value={c.id} />
            <label>
              企業名
              <input name="name" defaultValue={c.name} required />
            </label>
            <label>
              都道府県
              <input name="prefecture" defaultValue={c.prefecture ?? ""} />
            </label>
            <label>
              市区町村
              <input name="city" defaultValue={c.city ?? ""} />
            </label>
            <label>
              住所
              <input name="address" defaultValue={c.address ?? ""} />
            </label>
            <label>
              住所の出典URL
              <input name="addressSourceUrl" type="url" defaultValue={c.addressSourceUrl ?? ""} />
            </label>
            <label>
              業種
              <input name="industry" defaultValue={c.industry ?? ""} />
            </label>
            <label>
              代表窓口（電話）
              <input name="representativePhone" defaultValue={c.representativePhone ?? ""} />
            </label>
            <button type="submit">修正を保存</button>
          </form>
        </details>

        <details>
          <summary>候補を除外する（企業共通の抑止。再収集でも営業可能に戻りません）</summary>
          <form action={excludeCandidateAction} className="stack">
            <ReturnTo path={here} />
            <input type="hidden" name="companyId" value={c.id} />
            <label>
              種類
              <select name="kind" defaultValue="excluded">
                <option value="excluded">対象外（除外）</option>
                <option value="existing_customer">既存顧客</option>
              </select>
            </label>
            <label>
              理由
              <input name="reason" required />
            </label>
            <button type="submit">除外する</button>
          </form>
        </details>
      </section>

      <section>
        <h2>サイトと公式サイトの確認</h2>
        <table>
          <thead>
            <tr>
              <th>URL</th>
              <th>種類</th>
              <th>主サイト</th>
              <th>登録</th>
            </tr>
          </thead>
          <tbody>
            {d.websites.map((w) => (
              <tr key={w.id}>
                <td>{w.url}</td>
                <td>{w.kind === "current" ? "現サイト" : "提案"}</td>
                <td>{w.isPrimary ? "主" : ""}</td>
                <td>{fmtDate(w.createdAt)}</td>
              </tr>
            ))}
            {d.websites.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  サイトは見つかっていません
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <form action={setOfficialSiteStatusAction} className="inline">
          <ReturnTo path={here} />
          <input type="hidden" name="companyId" value={c.id} />
          <select
            name="status"
            defaultValue={c.officialSiteStatus === "needs_review" ? "confirmed" : c.officialSiteStatus}
          >
            {Object.entries(OFFICIAL_SITE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select name="websiteId" defaultValue="">
            <option value="">（主サイトは変えない）</option>
            {d.websites.map((w) => (
              <option key={w.id} value={w.id}>
                主サイト：{w.url}
              </option>
            ))}
          </select>
          <input name="note" placeholder="確認メモ（任意）" />
          <button type="submit">公式サイトの確度を更新</button>
        </form>

        <h3>出典</h3>
        <table>
          <thead>
            <tr>
              <th>取得元</th>
              <th>役割</th>
              <th>出典URL</th>
              <th>取得日時</th>
            </tr>
          </thead>
          <tbody>
            {d.sources.map((s) => (
              <tr key={s.id}>
                <td>{s.provider}</td>
                <td>{s.role === "site" ? "公式サイト候補" : "企業候補"}</td>
                <td>{s.sourceUrl ?? "—"}</td>
                <td>{fmtDate(s.fetchedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>診断結果</h2>
        {d.latestAudit ? (
          <AuditView audit={d.latestAudit} findings={d.findings} />
        ) : (
          <p className="muted">診断はまだありません。</p>
        )}
        {d.audits.length > 1 ? <p className="muted">過去の診断 {d.audits.length - 1}件（最新のみ表示）</p> : null}
      </section>

      <section>
        <h2>提案版とレビュー（運営確認）</h2>
        <table>
          <thead>
            <tr>
              <th>版</th>
              <th>状態</th>
              <th>内容</th>
              <th>デモ</th>
              <th>レビュー</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {d.proposalVersions.map((v) => (
              <tr key={v.id}>
                <td>v{v.version}</td>
                <td>{label(PROPOSAL_STATUS_LABEL, v.status)}</td>
                <td>
                  <details>
                    <summary>改善提案・電話台本など</summary>
                    <Json value={v.content} />
                  </details>
                </td>
                <td>{v.demoArtifactDir ? <code>{v.demoArtifactDir}</code> : "—"}</td>
                <td>
                  {fmtDate(v.reviewedAt)}
                  {v.reviewNote ? <div>{v.reviewNote}</div> : null}
                </td>
                <td>
                  {v.status === "in_review" ? (
                    <>
                      <form action={reviewProposalAction} className="inline">
                        <ReturnTo path={here} />
                        <input type="hidden" name="proposalVersionId" value={v.id} />
                        <input type="hidden" name="decision" value="approved" />
                        <input name="note" placeholder="確認メモ（任意）" />
                        <button type="submit">承認</button>
                      </form>
                      <form action={reviewProposalAction} className="inline">
                        <ReturnTo path={here} />
                        <input type="hidden" name="proposalVersionId" value={v.id} />
                        <input type="hidden" name="decision" value="rejected" />
                        <input name="note" placeholder="差し戻しの理由（必須）" required />
                        <button type="submit">差し戻し</button>
                      </form>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
            {d.proposalVersions.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  提案版はまだありません
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>

        <h3>生成ジョブ</h3>
        <table>
          <thead>
            <tr>
              <th>用途</th>
              <th>状態</th>
              <th>生成器</th>
              <th>モデル（要求/応答）</th>
              <th>プロンプト版</th>
              <th>失敗理由</th>
              <th>登録</th>
            </tr>
          </thead>
          <tbody>
            {d.generationJobs.map((j) => (
              <tr key={j.id}>
                <td>{j.purpose}</td>
                <td>{label(JOB_STATUS_LABEL, j.status)}</td>
                <td>{j.generator}</td>
                <td>
                  {j.requestedModel ?? "未記録"} / {j.responseModel ?? "未記録"}
                </td>
                <td>{j.promptVersion}</td>
                <td>{j.errorCode ? `${j.errorCode}: ${j.error ?? ""}` : "—"}</td>
                <td>{fmtDate(j.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>営業可能化</h2>
        <p className="muted">
          運営確認（最新の提案版の承認）が済み、販売条件・報酬条件が設定された版を選んだ候補だけを営業可能にできます。判定はサーバー側で行います。
        </p>
        {c.pipelineStatus === "sellable" ? (
          <form action={withdrawSellableAction} className="inline">
            <ReturnTo path={here} />
            <input type="hidden" name="companyId" value={c.id} />
            <input name="reason" placeholder="取り下げの理由（必須）" required />
            <button type="submit">営業可能を取り下げる</button>
          </form>
        ) : (
          <>
            {baseIssues.length > 0 ? (
              <ul className="warn">
                {baseIssues.map((i) => (
                  <li key={i}>{sellableIssueText(i)}</li>
                ))}
              </ul>
            ) : null}
            {readyTerms.length === 0 ? (
              <p className="warn">
                販売条件・報酬条件が設定された有効な版がありません。<Link href="/ops/contracts">商品条件</Link>
                で版を作成してください。
              </p>
            ) : null}
            <form action={makeSellableAction} className="inline">
              <ReturnTo path={here} />
              <input type="hidden" name="companyId" value={c.id} />
              <select name="productTermsId" defaultValue="">
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
              </select>
              <button type="submit">営業可能にする</button>
            </form>
          </>
        )}
      </section>

      <section>
        <h2>担当の履歴</h2>
        <table>
          <thead>
            <tr>
              <th>営業ユーザー</th>
              <th>状態</th>
              <th>確保</th>
              <th>期限</th>
              <th>解除理由</th>
            </tr>
          </thead>
          <tbody>
            {d.assignments.map(({ a, userName }) => (
              <tr key={a.id}>
                <td>{userName}</td>
                <td>{label(ASSIGNMENT_STATUS_LABEL, a.status)}</td>
                <td>{fmtDate(a.claimedAt)}</td>
                <td>{fmtDate(a.expiresAt)}</td>
                <td>{a.releaseReason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          <Link href="/ops/assignments">担当状況の画面で付け替え・延長・解除</Link>
        </p>
      </section>

      <section>
        <h2>この企業の操作履歴（最新50件）</h2>
        <table>
          <thead>
            <tr>
              <th>日時</th>
              <th>主体</th>
              <th>操作</th>
              <th>変更前</th>
              <th>変更後</th>
            </tr>
          </thead>
          <tbody>
            {events.value.map(({ e, actorName }) => (
              <tr key={e.id}>
                <td>{fmtDate(e.createdAt)}</td>
                <td>
                  {e.actorKind}
                  {actorName ? `：${actorName}` : ""}
                </td>
                <td>{e.action}</td>
                <td>
                  <Json value={e.before} />
                </td>
                <td>
                  <Json value={e.after} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
