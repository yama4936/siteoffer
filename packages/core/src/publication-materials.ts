import { createHash } from "node:crypto";
import {
  approvals,
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
import { and, asc, desc, eq, inArray } from "drizzle-orm";
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
async function scan(db: DbOrTx, filter: { companyId?: string; deliveryId?: string } = {}) {
  const rows = await db
    .select({
      deployment: deployments,
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
  const ids = [
    ...new Set(rows.flatMap((r) => parseDeliveryImageSnapshot(r.build?.snapshot)?.map((a) => a.assetId) ?? [])),
  ];
  const assets = new Map<string, { asset: typeof imageAssets.$inferSelect; file: { sha256: string } | null }>();
  for (let offset = 0; offset < ids.length; offset += 500) {
    const found = await db
      .select({ asset: imageAssets, file: { sha256: imageAssetFiles.sha256 } })
      .from(imageAssets)
      .leftJoin(imageAssetFiles, eq(imageAssetFiles.assetId, imageAssets.id))
      .where(inArray(imageAssets.id, ids.slice(offset, offset + 500)));
    for (const row of found) assets.set(row.asset.id, row);
  }
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
    const issues: Issue[] = [],
      states: unknown[] = [];
    const snapshot = parseDeliveryImageSnapshot(row.build?.snapshot);
    if (!row.version || row.version.deliveryId !== row.delivery.id || !row.build)
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
  return db.transaction(async (tx) => {
    await activeContentOperator(tx, actor);
    const rows = (await scan(tx)).filter((r) => r.state === "pending");
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.deploymentId.localeCompare(b.deploymentId));
    return {
      total: rows.length,
      items: rows.slice(0, 20).map((r) => ({
        id: r.deploymentId,
        deliveryId: r.deliveryId,
        companyId: r.companyId,
        companyName: r.companyName,
        version: r.version,
        environment: r.environment,
        since: r.createdAt,
        reason: r.issues[0]!.reason,
      })),
    };
  });
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
    if (
      item.state !== "pending" ||
      (item.check?.revision ?? 0) !== input.revision ||
      item.fingerprint !== input.fingerprint
    )
      throw new PublicationMaterialError("素材の許可または対応状況が変わりました。最新の一覧を確認してください");
    if (item.url && item.url !== url) throw new PublicationMaterialError("記録された公開先と確認したURLが一致しません");
    if (input.outcome === "replaced") {
      const replacement = candidates(item, rows).find((r) => r.deploymentId === input.replacementId && r.url === url);
      if (!replacement)
        throw new PublicationMaterialError(
          "同じ公開先・環境の新しい承認版で、素材の確認が済んだ公開記録を選択してください",
        );
    } else if (input.replacementId !== null)
      throw new PublicationMaterialError("公開停止の記録に置き換え先は指定できません");
    const values = {
      deploymentId: item.deploymentId,
      revision: input.revision + 1,
      fingerprint: item.fingerprint,
      outcome: input.outcome,
      replacementId: input.replacementId,
      observedUrl: url,
      note,
      checkedBy: target.who.userId,
      checkedAt: clock.now(),
      revokedAt: null,
      revokedBy: null,
      revocationNote: null,
    };
    await tx
      .insert(publicationMaterialChecks)
      .values(values)
      .onConflictDoUpdate({ target: publicationMaterialChecks.deploymentId, set: values });
    await tx
      .insert(publicationCheckOperations)
      .values({ ...op, deploymentId: item.deploymentId, createdAt: clock.now() });
    await recordEvent(tx, clock, {
      actor: target.who,
      action: "publication_material.confirm",
      targetType: "deployment",
      targetId: item.deploymentId,
      before: item.check,
      after: values,
    });
    const fresh = await scan(tx, { deliveryId: target.deliveryId });
    return { item: view(fresh.find((r) => r.deploymentId === item.deploymentId)!, fresh), replayed: false };
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
    const patch = {
      revision: input.revision + 1,
      revokedAt: clock.now(),
      revokedBy: target.who.userId,
      revocationNote: note,
    };
    await tx
      .update(publicationMaterialChecks)
      .set(patch)
      .where(eq(publicationMaterialChecks.deploymentId, item.deploymentId));
    await tx
      .insert(publicationCheckOperations)
      .values({ ...op, deploymentId: item.deploymentId, createdAt: clock.now() });
    await recordEvent(tx, clock, {
      actor: target.who,
      action: "publication_material.reopen",
      targetType: "deployment",
      targetId: item.deploymentId,
      before: item.check,
      after: patch,
    });
    const fresh = await scan(tx, { deliveryId: target.deliveryId });
    return { item: view(fresh.find((r) => r.deploymentId === item.deploymentId)!, fresh), replayed: false };
  });
}
