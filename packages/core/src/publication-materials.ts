import { createHash } from "node:crypto";
import {
  approvals,
  auditEvents,
  companies,
  contracts,
  type DbOrTx,
  deliveries,
  deliveryBuilds,
  deliveryVersions,
  deployments,
  imageAssetFiles,
  imageAssets,
  publicationCheckOperations,
  publicationMaterialChecks,
  users,
} from "@siteoffer/db";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Actor } from "./common/actor.ts";
import type { Clock } from "./common/clock.ts";
import { recordEvent } from "./common/events.ts";
import { activeContentOperator, lockContentCompany } from "./content-auth.ts";
import { findSecretInFields } from "./domain-preference/secrets.ts";
import { parseDeliveryImageSnapshot } from "./image-assets.ts";

export class PublicationMaterialError extends Error {}
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Only a display/identity value. This module never fetches or deploys to the URL. */
export function publicationUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}
type Issue = { assetId: string | null; label: string; reason: string };
const imagePolicyFields = {
  id: imageAssets.id,
  companyId: imageAssets.companyId,
  policyRevision: imageAssets.policyRevision,
  rightsStatus: imageAssets.rightsStatus,
  allowProduction: imageAssets.allowProduction,
  confirmedBy: imageAssets.confirmedBy,
  confirmedAt: imageAssets.confirmedAt,
};
type ImagePolicy = Pick<typeof imageAssets.$inferSelect, keyof typeof imagePolicyFields>;
async function publicationAssets(db: DbOrTx, snapshots: unknown[]) {
  const ids = [
    ...new Set(snapshots.flatMap((snapshot) => parseDeliveryImageSnapshot(snapshot)?.map((a) => a.assetId) ?? [])),
  ];
  const assets = new Map<string, { asset: ImagePolicy; file: { sha256: string } | null }>();
  for (let offset = 0; offset < ids.length; offset += 500) {
    const found = await db
      .select({ asset: imagePolicyFields, file: { sha256: imageAssetFiles.sha256 } })
      .from(imageAssets)
      .leftJoin(imageAssetFiles, eq(imageAssetFiles.assetId, imageAssets.id))
      .where(inArray(imageAssets.id, ids.slice(offset, offset + 500)));
    for (const row of found) assets.set(row.asset.id, row);
  }
  return assets;
}
type ImageSource = {
  companyId: string;
  deliveryId: string;
  versionDeliveryId: string | undefined;
  build: { id: string; snapshot: unknown } | null;
};
function publicationIssues(row: ImageSource, assets: Awaited<ReturnType<typeof publicationAssets>>) {
  const issues: Issue[] = [],
    states: unknown[] = [];
  const snapshot = parseDeliveryImageSnapshot(row.build?.snapshot);
  if (row.versionDeliveryId !== row.deliveryId || !row.build)
    issues.push({ assetId: null, label: "使用素材の記録", reason: "制作回と使用素材を追跡できません" });
  else if (row.build.snapshot === null)
    issues.push({ assetId: null, label: "使用素材の記録", reason: "使用素材が記録されていない旧版です" });
  else if (!snapshot) issues.push({ assetId: null, label: "使用素材の記録", reason: "素材の記録を読み取れません" });
  else
    for (const source of snapshot) {
      const found = assets.get(source.assetId),
        a = found?.asset,
        f = found?.file;
      states.push([
        source.assetId,
        a?.companyId,
        a?.policyRevision,
        a?.rightsStatus,
        a?.allowProduction,
        a?.confirmedBy,
        a?.confirmedAt,
        f?.sha256,
      ]);
      const reason =
        !a || a.companyId !== row.companyId
          ? "素材を確認できません"
          : !a.allowProduction || a.rightsStatus === "unknown" || !a.confirmedBy || !a.confirmedAt
            ? "本番サイトでの利用許可が停止しています"
            : !f
              ? "画像ファイルを確認できません"
              : f.sha256 !== source.sha256
                ? "公開記録と画像ファイルが一致しません"
                : null;
      if (reason) issues.push({ assetId: source.assetId, label: source.label, reason });
    }
  return { issues, states };
}
async function scan(db: DbOrTx, filter: { companyId?: string; deliveryId?: string } = {}) {
  const rows = await db
    .select({
      deployment: {
        id: deployments.id,
        deliveryVersionId: deployments.deliveryVersionId,
        environment: deployments.environment,
        url: deployments.url,
        createdAt: deployments.createdAt,
      },
      delivery: { id: deliveries.id, status: deliveries.status, lockedVersionId: deliveries.lockedVersionId },
      companyId: companies.id,
      companyName: companies.name,
      version: {
        id: deliveryVersions.id,
        number: deliveryVersions.version,
        deliveryId: deliveryVersions.deliveryId,
        buildId: deliveryVersions.buildId,
      },
      build: { id: deliveryBuilds.id, snapshot: deliveryBuilds.imageAssetSnapshot },
      check: publicationMaterialChecks,
      checkedByName: users.displayName,
      batchRequestId: sql<string | null>`(select ae."after"->>'batchRequestId' from ${auditEvents} ae
        where ae.target_type='deployment' and ae.target_id=${deployments.id}::text
          and ae.action='publication_material.confirm' and ae.actor_id=${publicationMaterialChecks.checkedBy}
          and ae."after"->>'revision'=${publicationMaterialChecks.revision}::text
        order by ae.created_at desc,ae.id desc limit 1)`,
    })
    .from(deployments)
    .innerJoin(deliveries, eq(deliveries.id, deployments.deliveryId))
    .innerJoin(contracts, eq(contracts.id, deliveries.contractId))
    .innerJoin(companies, eq(companies.id, contracts.companyId))
    .leftJoin(deliveryVersions, eq(deliveryVersions.id, deployments.deliveryVersionId))
    .leftJoin(
      deliveryBuilds,
      and(eq(deliveryBuilds.id, deliveryVersions.buildId), eq(deliveryBuilds.deliveryId, deliveries.id)),
    )
    .leftJoin(publicationMaterialChecks, eq(publicationMaterialChecks.deploymentId, deployments.id))
    .leftJoin(users, eq(users.id, publicationMaterialChecks.checkedBy))
    .where(
      and(
        eq(deployments.status, "recorded"),
        filter.companyId ? eq(companies.id, filter.companyId) : undefined,
        filter.deliveryId ? eq(deliveries.id, filter.deliveryId) : undefined,
      ),
    )
    .orderBy(desc(deployments.createdAt), desc(deliveryVersions.version), desc(deployments.id));
  const assets = await publicationAssets(
    db,
    rows.map((r) => r.build?.snapshot),
  );
  const approved = new Set<string>(),
    versionIds = [...new Set(rows.map((r) => r.deployment.deliveryVersionId))];
  for (let offset = 0; offset < versionIds.length; offset += 500) {
    for (const row of await db
      .select({ id: approvals.deliveryVersionId })
      .from(approvals)
      .where(
        and(
          eq(approvals.decision, "approved"),
          inArray(approvals.deliveryVersionId, versionIds.slice(offset, offset + 500)),
        ),
      ))
      approved.add(row.id);
  }
  return rows.map((row) => {
    const { issues, states } = publicationIssues(
      {
        companyId: row.companyId,
        deliveryId: row.delivery.id,
        versionDeliveryId: row.version?.deliveryId,
        build: row.build,
      },
      assets,
    );
    const checked = !!row.check && !row.check.revokedAt;
    return {
      deploymentId: row.deployment.id,
      deliveryId: row.delivery.id,
      companyId: row.companyId,
      companyName: row.companyName,
      environment: row.deployment.environment,
      url: publicationUrl(row.deployment.url),
      version: row.version?.number ?? 0,
      createdAt: row.deployment.createdAt.toISOString(),
      deliveryStatus: row.delivery.status,
      fingerprint: hash([
        row.deployment.id,
        row.deployment.deliveryVersionId,
        row.deployment.environment,
        row.deployment.url,
        row.build,
        states,
      ]),
      issues,
      state: checked ? ("resolved" as const) : issues.length ? ("pending" as const) : ("clear" as const),
      approved: approved.has(row.deployment.deliveryVersionId),
      check: row.check
        ? {
            ...row.check,
            checkedByName: row.checkedByName ?? "運営",
            batchRequestId: uuid(row.batchRequestId) ? row.batchRequestId : null,
            checkedAt: row.check.checkedAt.toISOString(),
            revokedAt: row.check.revokedAt?.toISOString() ?? null,
          }
        : null,
    };
  });
}
type ScanItem = Awaited<ReturnType<typeof scan>>[number];
function candidates(item: ScanItem, rows: ScanItem[]) {
  // A different target or environment must not silently retire the old public site.
  const matching = rows.filter(
    (r) =>
      r.deliveryId === item.deliveryId &&
      r.environment === item.environment &&
      r.url &&
      (!item.url || r.url === item.url),
  );
  const latestByUrl = new Map<string, ScanItem>();
  for (const row of matching) if (!latestByUrl.has(row.url!)) latestByUrl.set(row.url!, row);
  return [...latestByUrl.values()].filter(
    (r) =>
      r.deploymentId !== item.deploymentId &&
      r.version > item.version &&
      r.createdAt >= item.createdAt &&
      !r.issues.length &&
      r.approved &&
      (!r.check || r.check.revokedAt),
  );
}
function view(item: ScanItem, rows: ScanItem[]) {
  return {
    ...item,
    relatedConfirmedBatch: item.check?.batchRequestId
      ? rows.filter(
          (r) =>
            r.state === "resolved" &&
            r.check?.checkedBy === item.check?.checkedBy &&
            r.check?.batchRequestId === item.check?.batchRequestId,
        ).length
      : 0,
    relatedPending: item.url ? rows.filter((r) => samePublicationTarget(item, r) && r.state === "pending").length : 0,
    replacements: candidates(item, rows).map((r) => ({
      deploymentId: r.deploymentId,
      version: r.version,
      url: r.url!,
      createdAt: r.createdAt,
    })),
  };
}
export type PublicationMaterialItem = ReturnType<typeof view>;
export async function listPublicationMaterials(
  db: DbOrTx,
  actor: Actor | null,
  input: {
    companyId?: string;
    deliveryId?: string;
    deploymentId?: string;
    page?: number;
    mode?: "pending" | "resolved" | "all";
  } = {},
) {
  if (
    (input.companyId && !uuid(input.companyId)) ||
    (input.deliveryId && !uuid(input.deliveryId)) ||
    (input.deploymentId && !uuid(input.deploymentId))
  )
    throw new PublicationMaterialError("対象の企業・納品を確認してください");
  return db.transaction(async (tx) => {
    await activeContentOperator(tx, actor);
    const source = await scan(tx, input),
      all = source.filter((r) => !input.deploymentId || r.deploymentId === input.deploymentId),
      mode = input.mode ?? "pending",
      rows = all.filter((r) => mode === "all" || r.state === mode);
    const page = Number.isSafeInteger(input.page) && input.page! >= 0 ? Math.min(input.page!, 100000) : 0;
    return {
      total: rows.length,
      pending: all.filter((r) => r.state === "pending").length,
      resolved: all.filter((r) => r.state === "resolved").length,
      scanned: all.length,
      items: rows.slice(page * 20, (page + 1) * 20).map((r) => view(r, source)),
    };
  });
}
/** Oldest actionable publications for the operations queue. No file bodies or confirmation notes. */
export async function getPublicationMaterialWork(db: DbOrTx, actor: Actor | null) {
  return db.transaction(
    async (tx) => {
      await activeContentOperator(tx, actor);
      let total = 0;
      let cursor: string | undefined;
      const items: {
        id: string;
        deliveryId: string;
        companyId: string;
        companyName: string;
        version: number;
        environment: string;
        since: string;
        reason: string;
      }[] = [];
      for (;;) {
        const rows = await tx
          .select({
            id: deployments.id,
            deliveryId: deliveries.id,
            companyId: companies.id,
            companyName: companies.name,
            version: { number: deliveryVersions.version, deliveryId: deliveryVersions.deliveryId },
            build: { id: deliveryBuilds.id, snapshot: deliveryBuilds.imageAssetSnapshot },
            environment: deployments.environment,
            createdAt: deployments.createdAt,
          })
          .from(deployments)
          .innerJoin(deliveries, eq(deliveries.id, deployments.deliveryId))
          .innerJoin(contracts, eq(contracts.id, deliveries.contractId))
          .innerJoin(companies, eq(companies.id, contracts.companyId))
          .leftJoin(deliveryVersions, eq(deliveryVersions.id, deployments.deliveryVersionId))
          .leftJoin(
            deliveryBuilds,
            and(eq(deliveryBuilds.id, deliveryVersions.buildId), eq(deliveryBuilds.deliveryId, deliveries.id)),
          )
          .leftJoin(publicationMaterialChecks, eq(publicationMaterialChecks.deploymentId, deployments.id))
          .where(
            and(
              eq(deployments.status, "recorded"),
              or(isNull(publicationMaterialChecks.deploymentId), isNotNull(publicationMaterialChecks.revokedAt)),
              // Only an intact, explicitly empty snapshot is certainly clear without inspecting policies.
              or(
                isNull(deliveryBuilds.id),
                ne(deliveryVersions.deliveryId, deliveries.id),
                isNull(deliveryBuilds.imageAssetSnapshot),
                sql`${deliveryBuilds.imageAssetSnapshot} <> '[]'::jsonb`,
              ),
              cursor ? gt(deployments.id, cursor) : undefined,
            ),
          )
          // Walk the existing primary key; retain only the oldest 20 summaries below.
          .orderBy(asc(deployments.id))
          .limit(500);
        const assets = await publicationAssets(
          tx,
          rows.map((r) => r.build?.snapshot),
        );
        for (const row of rows) {
          const { issues } = publicationIssues(
            {
              companyId: row.companyId,
              deliveryId: row.deliveryId,
              versionDeliveryId: row.version?.deliveryId,
              build: row.build,
            },
            assets,
          );
          if (!issues.length) continue;
          total++;
          const since = row.createdAt.toISOString(),
            last = items[items.length - 1];
          if (items.length < 20 || (last && (since.localeCompare(last.since) || row.id.localeCompare(last.id)) < 0)) {
            items.push({
              id: row.id,
              deliveryId: row.deliveryId,
              companyId: row.companyId,
              companyName: row.companyName,
              version: row.version?.number ?? 0,
              environment: row.environment,
              since,
              reason: issues[0]!.reason,
            });
            items.sort((a, b) => a.since.localeCompare(b.since) || a.id.localeCompare(b.id));
            if (items.length > 20) items.pop();
          }
        }
        if (rows.length < 500) break;
        const last: { id: string } = rows[rows.length - 1]!;
        cursor = last.id;
      }
      return { total, items };
    },
    // All windows must see the same permissions and publication records.
    { isolationLevel: "repeatable read" },
  );
}
export async function getPublicationMaterial(db: DbOrTx, actor: Actor | null, deploymentId: string) {
  if (!uuid(deploymentId)) throw new PublicationMaterialError("公開記録を確認してください");
  return db.transaction(async (tx) => {
    await activeContentOperator(tx, actor);
    const [record] = await tx
      .select({ deliveryId: deployments.deliveryId })
      .from(deployments)
      .where(eq(deployments.id, deploymentId));
    if (!record) throw new PublicationMaterialError("公開記録が見つかりません");
    const rows = await scan(tx, { deliveryId: record.deliveryId });
    const item = rows.find((r) => r.deploymentId === deploymentId);
    if (!item) throw new PublicationMaterialError("公開記録が見つかりません");
    return view(item, rows);
  });
}
function validateNote(note: unknown) {
  if (
    typeof note !== "string" ||
    note.trim().length < 10 ||
    note.trim().length > 2000 ||
    note.includes(String.fromCharCode(0))
  )
    throw new PublicationMaterialError("確認した内容を10〜2000文字で入力してください");
  if (findSecretInFields({ note }))
    throw new PublicationMaterialError("パスワードなどの秘密情報は記入しないでください");
  return note.trim();
}
async function lockTarget(tx: DbOrTx, actor: Actor | null, id: string) {
  if (actor?.kind !== "ops" || !uuid(id))
    throw new PublicationMaterialError("運営として対象の公開記録を確認してください");
  const [hint] = await tx
    .select({ deliveryId: deployments.deliveryId, companyId: contracts.companyId })
    .from(deployments)
    .innerJoin(deliveries, eq(deliveries.id, deployments.deliveryId))
    .innerJoin(contracts, eq(contracts.id, deliveries.contractId))
    .where(eq(deployments.id, id));
  if (!hint) throw new PublicationMaterialError("公開記録が見つかりません");
  await lockContentCompany(tx, hint.companyId);
  await tx.select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.id, hint.deliveryId)).for("update");
  const who = await activeContentOperator(tx, actor);
  await tx
    .select({ id: imageAssets.id })
    .from(imageAssets)
    .where(eq(imageAssets.companyId, hint.companyId))
    .orderBy(asc(imageAssets.id))
    .for("share");
  return { ...hint, who };
}
function operation(actorId: string, requestId: string, payload: unknown) {
  if (!uuid(requestId)) throw new PublicationMaterialError("受付番号を確認してください");
  return { key: hash([actorId, requestId.toLowerCase()]), payloadHash: hash(payload) };
}
async function receipt(db: DbOrTx, op: ReturnType<typeof operation>) {
  const [row] = await db.select().from(publicationCheckOperations).where(eq(publicationCheckOperations.key, op.key));
  if (row && row.payloadHash !== op.payloadHash)
    throw new PublicationMaterialError("同じ受付番号で内容を変更できません");
  return row;
}
type ConfirmationSettings = {
  outcome: "replaced" | "site_offline";
  replacementId: string | null;
  url: string;
  note: string;
};
function assertConfirmation(
  item: ScanItem,
  rows: ScanItem[],
  input: { revision: number; fingerprint: string },
  settings: ConfirmationSettings,
) {
  const { url } = settings;
  if (
    item.state !== "pending" ||
    (item.check?.revision ?? 0) !== input.revision ||
    item.fingerprint !== input.fingerprint
  )
    throw new PublicationMaterialError("素材の許可または対応状況が変わりました。最新の一覧を確認してください");
  if (item.url && item.url !== url) throw new PublicationMaterialError("記録された公開先と確認したURLが一致しません");
  if (settings.outcome === "replaced") {
    const replacement = candidates(item, rows).find((r) => r.deploymentId === settings.replacementId && r.url === url);
    if (!replacement)
      throw new PublicationMaterialError(
        "同じ公開先・環境の新しい承認版で、素材の確認が済んだ公開記録を選択してください",
      );
  } else if (settings.replacementId !== null)
    throw new PublicationMaterialError("公開停止の記録に置き換え先は指定できません");
}
async function writeConfirmation(
  tx: DbOrTx,
  clock: Clock,
  who: Extract<Actor, { kind: "ops" }>,
  item: ScanItem,
  settings: ConfirmationSettings,
  batchRequestId?: string,
) {
  const { url, note } = settings;
  const values = {
    deploymentId: item.deploymentId,
    revision: (item.check?.revision ?? 0) + 1,
    fingerprint: item.fingerprint,
    outcome: settings.outcome,
    replacementId: settings.replacementId,
    observedUrl: url,
    note,
    checkedBy: who.userId,
    checkedAt: clock.now(),
    revokedAt: null,
    revokedBy: null,
    revocationNote: null,
  };
  await tx
    .insert(publicationMaterialChecks)
    .values(values)
    .onConflictDoUpdate({ target: publicationMaterialChecks.deploymentId, set: values });
  await recordEvent(tx, clock, {
    actor: who,
    action: "publication_material.confirm",
    targetType: "deployment",
    targetId: item.deploymentId,
    before: item.check,
    after: batchRequestId ? { ...values, batchRequestId } : values,
  });
}
export async function confirmPublicationMaterialCheck(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  input: {
    deploymentId: string;
    revision: number;
    fingerprint: string;
    requestId: string;
    outcome: "replaced" | "site_offline";
    replacementId: string | null;
    observedUrl: string;
    note: string;
    confirmed: boolean;
  },
) {
  const note = validateNote(input?.note),
    url = publicationUrl(input?.observedUrl);
  if (
    !url ||
    input.confirmed !== true ||
    !["replaced", "site_offline"].includes(input.outcome) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0
  )
    throw new PublicationMaterialError("公開先と対応内容、実際の反映を確認してください");
  if (findSecretInFields({ url })) throw new PublicationMaterialError("公開先に秘密情報を含めないでください");
  return db.transaction(async (tx) => {
    const target = await lockTarget(tx, actor, input.deploymentId),
      op = operation(target.who.userId, input.requestId, [
        "confirm",
        input.deploymentId,
        input.revision,
        input.fingerprint,
        input.outcome,
        input.replacementId,
        url,
        note,
      ]);
    const prior = await receipt(tx, op),
      rows = await scan(tx, { deliveryId: target.deliveryId }),
      item = rows.find((r) => r.deploymentId === input.deploymentId);
    if (!item) throw new PublicationMaterialError("公開記録が見つかりません");
    if (prior) return { item: view(item, rows), replayed: true };
    const settings = { outcome: input.outcome, replacementId: input.replacementId, url, note };
    assertConfirmation(item, rows, input, settings);
    await writeConfirmation(tx, clock, target.who, item, settings);
    await tx
      .insert(publicationCheckOperations)
      .values({ ...op, deploymentId: item.deploymentId, createdAt: clock.now() });
    const fresh = await scan(tx, { deliveryId: target.deliveryId });
    return { item: view(fresh.find((r) => r.deploymentId === item.deploymentId)!, fresh), replayed: false };
  });
}
async function writeReopen(
  tx: DbOrTx,
  clock: Clock,
  who: Extract<Actor, { kind: "ops" }>,
  item: ScanItem,
  note: string,
  reopenBatchRequestId?: string,
  sourceBatchRequestId?: string,
) {
  const patch = {
    revision: item.check!.revision + 1,
    revokedAt: clock.now(),
    revokedBy: who.userId,
    revocationNote: note,
  };
  await tx
    .update(publicationMaterialChecks)
    .set(patch)
    .where(eq(publicationMaterialChecks.deploymentId, item.deploymentId));
  await recordEvent(tx, clock, {
    actor: who,
    action: "publication_material.reopen",
    targetType: "deployment",
    targetId: item.deploymentId,
    before: item.check,
    after: reopenBatchRequestId ? { ...patch, reopenBatchRequestId, sourceBatchRequestId } : patch,
  });
}
export async function reopenPublicationMaterialCheck(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  input: { deploymentId: string; revision: number; requestId: string; note: string; confirmed: boolean },
) {
  const note = validateNote(input?.note);
  if (input.confirmed !== true || !Number.isSafeInteger(input.revision) || input.revision < 1)
    throw new PublicationMaterialError("再確認に戻す理由と確認チェックが必要です");
  return db.transaction(async (tx) => {
    const target = await lockTarget(tx, actor, input.deploymentId),
      op = operation(target.who.userId, input.requestId, ["reopen", input.deploymentId, input.revision, note]),
      prior = await receipt(tx, op),
      rows = await scan(tx, { deliveryId: target.deliveryId }),
      item = rows.find((r) => r.deploymentId === input.deploymentId);
    if (!item) throw new PublicationMaterialError("公開記録が見つかりません");
    if (prior) return { item: view(item, rows), replayed: true };
    if (item.state !== "resolved" || item.check?.revision !== input.revision)
      throw new PublicationMaterialError("対応状況が変わりました。最新の一覧を確認してください");
    await writeReopen(tx, clock, target.who, item, note);
    await tx
      .insert(publicationCheckOperations)
      .values({ ...op, deploymentId: item.deploymentId, createdAt: clock.now() });
    const fresh = await scan(tx, { deliveryId: target.deliveryId });
    return { item: view(fresh.find((r) => r.deploymentId === item.deploymentId)!, fresh), replayed: false };
  });
}

export const PUBLICATION_BATCH_LIMIT = 50;
function samePublicationTarget(a: ScanItem, b: ScanItem) {
  return a.url !== null && a.deliveryId === b.deliveryId && a.environment === b.environment && a.url === b.url;
}
function publicationScope(item: ScanItem) {
  return hash([item.deliveryId, item.environment, item.url]);
}
export async function getPublicationMaterialBatch(db: DbOrTx, actor: Actor | null, deploymentId: string) {
  if (!uuid(deploymentId)) throw new PublicationMaterialError("公開記録を確認してください");
  return db.transaction(async (tx) => {
    await activeContentOperator(tx, actor);
    const [hint] = await tx
      .select({ deliveryId: deployments.deliveryId })
      .from(deployments)
      .where(eq(deployments.id, deploymentId));
    if (!hint) throw new PublicationMaterialError("公開記録が見つかりません");
    const rows = await scan(tx, { deliveryId: hint.deliveryId }),
      anchor = rows.find((r) => r.deploymentId === deploymentId);
    if (!anchor?.url) throw new PublicationMaterialError("公開URLが記録されていない版は、個別に確認してください");
    const members = rows
      .filter((r) => samePublicationTarget(anchor, r) && r.state === "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.deploymentId.localeCompare(b.deploymentId));
    let shown = members.slice(0, PUBLICATION_BATCH_LIMIT);
    if (anchor.state === "pending" && !shown.some((r) => r.deploymentId === anchor.deploymentId))
      shown = [...shown.slice(0, PUBLICATION_BATCH_LIMIT - 1), anchor];
    return {
      deploymentId: anchor.deploymentId,
      deliveryId: anchor.deliveryId,
      companyName: anchor.companyName,
      environment: anchor.environment,
      url: anchor.url,
      scope: publicationScope(anchor),
      total: members.length,
      limit: PUBLICATION_BATCH_LIMIT,
      items: shown.map((r) => ({
        deploymentId: r.deploymentId,
        version: r.version,
        createdAt: r.createdAt,
        revision: r.check?.revision ?? 0,
        fingerprint: r.fingerprint,
        issues: r.issues,
        replacements: view(r, rows).replacements,
      })),
    };
  });
}
export async function confirmPublicationMaterialBatch(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  input: {
    deploymentId: string;
    scope: string;
    items: { deploymentId: string; revision: number; fingerprint: string }[];
    requestId: string;
    outcome: "replaced" | "site_offline";
    replacementId: string | null;
    observedUrl: string;
    note: string;
    confirmed: boolean;
  },
) {
  const note = validateNote(input?.note),
    url = publicationUrl(input?.observedUrl);
  if (
    !url ||
    input.confirmed !== true ||
    !["replaced", "site_offline"].includes(input.outcome) ||
    !Array.isArray(input.items) ||
    input.items.length < 2 ||
    input.items.length > PUBLICATION_BATCH_LIMIT ||
    typeof input.scope !== "string" ||
    !/^[0-9a-f]{64}$/.test(input.scope)
  )
    throw new PublicationMaterialError("2〜50件の対象、公開先と対応内容、実際の反映を確認してください");
  if (findSecretInFields({ url })) throw new PublicationMaterialError("公開先に秘密情報を含めないでください");
  const entries = input.items
    .map((r) => {
      if (
        !r ||
        !uuid(r.deploymentId) ||
        !Number.isSafeInteger(r.revision) ||
        r.revision < 0 ||
        typeof r.fingerprint !== "string" ||
        !/^[0-9a-f]{64}$/.test(r.fingerprint)
      )
        throw new PublicationMaterialError("対象の公開記録と確認版を確認してください");
      return { deploymentId: r.deploymentId.toLowerCase(), revision: r.revision, fingerprint: r.fingerprint };
    })
    .sort((a, b) => a.deploymentId.localeCompare(b.deploymentId));
  if (new Set(entries.map((r) => r.deploymentId)).size !== entries.length)
    throw new PublicationMaterialError("同じ公開記録を複数回選択できません");
  return db.transaction(async (tx) => {
    const target = await lockTarget(tx, actor, input.deploymentId),
      op = operation(target.who.userId, input.requestId, [
        "confirm_batch",
        input.deploymentId.toLowerCase(),
        input.scope,
        entries,
        input.outcome,
        input.replacementId,
        url,
        note,
      ]);
    const prior = await receipt(tx, op),
      rows = await scan(tx, { deliveryId: target.deliveryId });
    const anchor = rows.find((r) => r.deploymentId === input.deploymentId.toLowerCase());
    if (!anchor) throw new PublicationMaterialError("公開記録が見つかりません");
    if (prior)
      return {
        items: entries
          .map((e) => rows.find((r) => r.deploymentId === e.deploymentId))
          .filter((r): r is ScanItem => !!r)
          .map((r) => view(r, rows)),
        replayed: true,
      };
    if (!anchor.url || publicationScope(anchor) !== input.scope || anchor.url !== url)
      throw new PublicationMaterialError("公開先・環境が変わりました。対象を再取得してください");
    const settings = { outcome: input.outcome, replacementId: input.replacementId, url, note };
    // Validate every row before writing any row; the outer transaction also rolls back audit/receipt failures.
    const selected = entries.map((entry) => {
      const item = rows.find((r) => r.deploymentId === entry.deploymentId);
      if (!item || !samePublicationTarget(anchor, item))
        throw new PublicationMaterialError("同じ納品・公開先・環境の記録だけをまとめて確認できます");
      assertConfirmation(item, rows, entry, settings);
      return item;
    });
    for (const item of selected) await writeConfirmation(tx, clock, target.who, item, settings, input.requestId);
    await tx
      .insert(publicationCheckOperations)
      .values({ ...op, deploymentId: anchor.deploymentId, createdAt: clock.now() });
    const fresh = await scan(tx, { deliveryId: target.deliveryId });
    return {
      items: entries.map((e) => view(fresh.find((r) => r.deploymentId === e.deploymentId)!, fresh)),
      replayed: false,
    };
  });
}

async function reopenBatchContext(db: DbOrTx, rows: ScanItem[], deploymentId: string) {
  const anchor = rows.find((r) => r.deploymentId === deploymentId);
  if (!anchor?.check?.batchRequestId || anchor.state !== "resolved")
    throw new PublicationMaterialError("現在も確認済みの一括確認の記録を選んでください");
  const actorId = anchor.check.checkedBy,
    batchRequestId = anchor.check.batchRequestId;
  const history = await db
    .select({ targetId: auditEvents.targetId, after: auditEvents.after })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.actorId, actorId),
        eq(auditEvents.action, "publication_material.confirm"),
        eq(auditEvents.targetType, "deployment"),
        sql`${auditEvents.after}->>'batchRequestId'=${batchRequestId}`,
      ),
    )
    .limit(PUBLICATION_BATCH_LIMIT + 1);
  if (history.length < 2 || history.length > PUBLICATION_BATCH_LIMIT)
    throw new PublicationMaterialError("一括確認の履歴を照合できません。個別に確認してください");
  const members = history
    .map((event) => {
      const data = event.after as Record<string, unknown> | null;
      if (
        !uuid(event.targetId) ||
        !data ||
        data.deploymentId !== event.targetId ||
        !Number.isSafeInteger(data.revision) ||
        Number(data.revision) < 1 ||
        data.checkedBy !== actorId ||
        data.batchRequestId !== batchRequestId ||
        typeof data.observedUrl !== "string" ||
        typeof data.fingerprint !== "string" ||
        !/^[0-9a-f]{64}$/.test(data.fingerprint)
      )
        throw new PublicationMaterialError("一括確認の履歴を照合できません。個別に確認してください");
      const current = rows.find((r) => r.deploymentId === event.targetId),
        originalRevision = Number(data.revision);
      const eligible =
        !!current &&
        samePublicationTarget(anchor, current) &&
        current.url === publicationUrl(data.observedUrl) &&
        current.state === "resolved" &&
        current.check?.revision === originalRevision &&
        current.check.checkedBy === actorId &&
        current.check.batchRequestId === batchRequestId;
      return {
        deploymentId: event.targetId,
        originalRevision,
        originalFingerprint: String(data.fingerprint),
        revision: current?.check?.revision ?? 0,
        version: current?.version ?? 0,
        state: current?.state ?? "unavailable",
        eligible,
        reason: eligible
          ? "この一括確認のままです"
          : !current
            ? "現在の記録を取得できません"
            : current.check?.revokedAt
              ? "すでに再確認へ戻されています"
              : "別の確認操作や公開先の変更があります",
      };
    })
    .sort((a, b) => a.deploymentId.localeCompare(b.deploymentId));
  if (new Set(members.map((r) => r.deploymentId)).size !== members.length)
    throw new PublicationMaterialError("一括確認の履歴を照合できません。個別に確認してください");
  // Verify the entire original member set against its immutable successful receipt.
  const [source] = await db
    .select()
    .from(publicationCheckOperations)
    .where(eq(publicationCheckOperations.key, hash([actorId, batchRequestId.toLowerCase()])));
  const sourcePayload = [
    "confirm_batch",
    source?.deploymentId,
    hash([anchor.deliveryId, anchor.environment, publicationUrl(anchor.check.observedUrl)]),
    members.map((r) => ({
      deploymentId: r.deploymentId,
      revision: r.originalRevision - 1,
      fingerprint: r.originalFingerprint,
    })),
    anchor.check.outcome,
    anchor.check.replacementId,
    publicationUrl(anchor.check.observedUrl),
    anchor.check.note,
  ];
  if (!source || source.payloadHash !== hash(sourcePayload))
    throw new PublicationMaterialError("元の受付内容と履歴が一致しません。個別に確認してください");
  return {
    deploymentId: anchor.deploymentId,
    companyName: anchor.companyName,
    deliveryId: anchor.deliveryId,
    environment: anchor.environment,
    url: anchor.check.observedUrl,
    checkedByName: anchor.check.checkedByName,
    checkedAt: anchor.check.checkedAt,
    originalNote: anchor.check.note,
    batchRequestId,
    scope: hash([actorId, batchRequestId, members.map((r) => [r.deploymentId, r.originalRevision])]),
    items: [...members].sort((a, b) => a.version - b.version || a.deploymentId.localeCompare(b.deploymentId)),
  };
}
export async function getPublicationReopenBatch(db: DbOrTx, actor: Actor | null, deploymentId: string) {
  if (!uuid(deploymentId)) throw new PublicationMaterialError("公開記録を確認してください");
  return db.transaction(async (tx) => {
    await activeContentOperator(tx, actor);
    const [hint] = await tx
      .select({ deliveryId: deployments.deliveryId })
      .from(deployments)
      .where(eq(deployments.id, deploymentId));
    if (!hint) throw new PublicationMaterialError("公開記録が見つかりません");
    return reopenBatchContext(tx, await scan(tx, { deliveryId: hint.deliveryId }), deploymentId);
  });
}
export async function reopenPublicationMaterialBatch(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  input: {
    deploymentId: string;
    scope: string;
    items: { deploymentId: string; revision: number }[];
    requestId: string;
    note: string;
    confirmed: boolean;
  },
) {
  const note = validateNote(input?.note);
  if (
    input.confirmed !== true ||
    !Array.isArray(input.items) ||
    input.items.length < 2 ||
    input.items.length > PUBLICATION_BATCH_LIMIT ||
    typeof input.scope !== "string" ||
    !/^[0-9a-f]{64}$/.test(input.scope)
  )
    throw new PublicationMaterialError("2〜50件の対象、再確認の理由とチェックを確認してください");
  const entries = input.items
    .map((r) => {
      if (!r || !uuid(r.deploymentId) || !Number.isSafeInteger(r.revision) || r.revision < 1)
        throw new PublicationMaterialError("対象と確認版を確認してください");
      return { deploymentId: r.deploymentId.toLowerCase(), revision: r.revision };
    })
    .sort((a, b) => a.deploymentId.localeCompare(b.deploymentId));
  if (new Set(entries.map((r) => r.deploymentId)).size !== entries.length)
    throw new PublicationMaterialError("同じ公開記録を複数回選択できません");
  return db.transaction(async (tx) => {
    const target = await lockTarget(tx, actor, input.deploymentId),
      op = operation(target.who.userId, input.requestId, [
        "reopen_batch",
        input.deploymentId.toLowerCase(),
        input.scope,
        entries,
        note,
      ]);
    const prior = await receipt(tx, op),
      rows = await scan(tx, { deliveryId: target.deliveryId });
    if (prior)
      return {
        items: entries
          .map((e) => rows.find((r) => r.deploymentId === e.deploymentId))
          .filter((r): r is ScanItem => !!r)
          .map((r) => view(r, rows)),
        replayed: true,
      };
    const context = await reopenBatchContext(tx, rows, input.deploymentId.toLowerCase());
    if (context.scope !== input.scope)
      throw new PublicationMaterialError("一括確認の対象が変わりました。最新の履歴を確認してください");
    const selected = entries.map((entry) => {
      const member = context.items.find((r) => r.deploymentId === entry.deploymentId),
        current = rows.find((r) => r.deploymentId === entry.deploymentId);
      if (!member?.eligible || member.revision !== entry.revision || !current)
        throw new PublicationMaterialError("確認状況が変わりました。最新の履歴を確認してください");
      return current;
    });
    for (const item of selected)
      await writeReopen(tx, clock, target.who, item, note, input.requestId, context.batchRequestId);
    await tx
      .insert(publicationCheckOperations)
      .values({ ...op, deploymentId: input.deploymentId, createdAt: clock.now() });
    const fresh = await scan(tx, { deliveryId: target.deliveryId });
    return {
      items: entries.map((e) => view(fresh.find((r) => r.deploymentId === e.deploymentId)!, fresh)),
      replayed: false,
    };
  });
}
