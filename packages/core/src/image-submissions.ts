import { createHash } from "node:crypto";
import {
  companies,
  type DbOrTx,
  imageAssetFiles,
  imageAssets,
  imageSubmissionOperations,
  imageSubmissions,
  users,
} from "@siteoffer/db";
import { and, count, desc, eq } from "drizzle-orm";
import type { Actor } from "./common/actor.ts";
import type { Clock } from "./common/clock.ts";
import { recordEvent } from "./common/events.ts";
import { activeContentOperator, authorizeContentEditor, lockContentCompany } from "./content-auth.ts";
import { validateNormalizedAssetImage } from "./image-assets.ts";

const uuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const CUSTOMER_MATERIAL_MAX_ITEMS = 100,
  CUSTOMER_MATERIAL_MAX_BYTES = 256 * 1024 * 1024;
export class ImageSubmissionError extends Error {}
export interface CustomerImageDetails {
  label: string;
  rightsBasis: "own_work" | "licensed" | "permission";
  rightsNote: string;
  requestedDemo: boolean;
  requestedProduction: boolean;
  confirmed: boolean;
}
function details(input: CustomerImageDetails) {
  if (
    !input ||
    typeof input.label !== "string" ||
    typeof input.rightsNote !== "string" ||
    !["own_work", "licensed", "permission"].includes(input.rightsBasis) ||
    typeof input.requestedDemo !== "boolean" ||
    typeof input.requestedProduction !== "boolean" ||
    input.confirmed !== true
  )
    throw new ImageSubmissionError("画像の説明と利用許可を確認してください");
  const label = input.label.trim(),
    rightsNote = input.rightsNote.trim();
  if (
    !label ||
    label.length > 120 ||
    rightsNote.length < 5 ||
    rightsNote.length > 2000 ||
    (label + rightsNote).includes(String.fromCharCode(0)) ||
    (!input.requestedDemo && !input.requestedProduction)
  )
    throw new ImageSubmissionError(
      "素材名は120文字以内、権利の説明は5〜2000文字で入力し、許可する用途を選択してください",
    );
  return {
    label,
    rightsBasis: input.rightsBasis,
    rightsNote,
    requestedDemo: input.requestedDemo,
    requestedProduction: input.requestedProduction,
  };
}
async function customer(db: DbOrTx, actor: Actor | null, companyId: string) {
  if (actor?.kind !== "customer_user") throw new ImageSubmissionError("顧客としてログインしてください");
  await authorizeContentEditor(db, actor, companyId);
  return actor;
}
export async function authorizeCustomerImageSubmission(db: DbOrTx, actor: Actor | null, companyId: string) {
  return db.transaction((tx) => customer(tx, actor, companyId));
}
async function operator(db: DbOrTx, actor: Actor | null, companyId: string) {
  await lockContentCompany(db, companyId);
  return activeContentOperator(db, actor);
}
function operation(actorId: string, requestId: string, payload: unknown) {
  if (!uuid(requestId)) throw new ImageSubmissionError("受付番号を確認してください");
  return { key: hash(JSON.stringify([actorId, requestId.toLowerCase()])), payloadHash: hash(JSON.stringify(payload)) };
}
async function receipt(db: DbOrTx, op: ReturnType<typeof operation>) {
  const [r] = await db.select().from(imageSubmissionOperations).where(eq(imageSubmissionOperations.key, op.key));
  if (r && r.payloadHash !== op.payloadHash)
    throw new ImageSubmissionError("同じ受付番号で内容を変更できません。送信結果を確認してください");
  return r;
}
async function remember(db: DbOrTx, clock: Clock, op: ReturnType<typeof operation>, assetId: string) {
  await db.insert(imageSubmissionOperations).values({ ...op, assetId, createdAt: clock.now() });
}
const selection = {
  submission: imageSubmissions,
  asset: {
    id: imageAssets.id,
    companyId: imageAssets.companyId,
    label: imageAssets.label,
    allowSalesDemo: imageAssets.allowSalesDemo,
    allowProduction: imageAssets.allowProduction,
    placement: imageAssets.placement,
  },
  file: {
    sha256: imageAssetFiles.sha256,
    width: imageAssetFiles.width,
    height: imageAssetFiles.height,
    byteSize: imageAssetFiles.byteSize,
  },
};
async function read(db: DbOrTx, companyId: string, assetId: string) {
  const [r] = await db
    .select(selection)
    .from(imageSubmissions)
    .innerJoin(imageAssets, eq(imageAssets.id, imageSubmissions.assetId))
    .innerJoin(imageAssetFiles, eq(imageAssetFiles.assetId, imageAssets.id))
    .where(and(eq(imageAssets.id, assetId), eq(imageAssets.companyId, companyId)));
  if (!r) throw new ImageSubmissionError("提出した画像が見つかりません");
  return viewRow(r);
}
function viewRow(r: {
  submission: typeof imageSubmissions.$inferSelect;
  asset: Pick<
    typeof imageAssets.$inferSelect,
    "id" | "companyId" | "label" | "allowSalesDemo" | "allowProduction" | "placement"
  >;
  file: Pick<typeof imageAssetFiles.$inferSelect, "sha256" | "width" | "height" | "byteSize">;
}) {
  return {
    ...r.submission,
    ...r.asset,
    ...r.file,
    submittedAt: r.submission.submittedAt.toISOString(),
    updatedAt: r.submission.updatedAt.toISOString(),
    reviewedAt: r.submission.reviewedAt?.toISOString() ?? null,
  };
}
export type ImageSubmissionView = Awaited<ReturnType<typeof read>>;
async function lockSubmission(db: DbOrTx, companyId: string, assetId: string) {
  if (!uuid(assetId)) throw new ImageSubmissionError("画像を確認してください");
  const [asset] = await db
    .select()
    .from(imageAssets)
    .where(and(eq(imageAssets.id, assetId), eq(imageAssets.companyId, companyId)))
    .for("update");
  if (!asset) throw new ImageSubmissionError("提出した画像が見つかりません");
  const [submission] = await db
    .select()
    .from(imageSubmissions)
    .where(eq(imageSubmissions.assetId, assetId))
    .for("update");
  if (!submission) throw new ImageSubmissionError("顧客から提出された画像ではありません");
  return { asset, submission };
}
export async function submitCustomerImage(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  input: CustomerImageDetails & { companyId: string; requestId: string; png: Buffer; width: number; height: number },
) {
  const clean = details(input);
  validateNormalizedAssetImage(input);
  const sha256 = hash(input.png);
  return db.transaction(async (tx) => {
    const who = await customer(tx, actor, input.companyId),
      op = operation(who.userId, input.requestId, ["submit", input.companyId, clean, sha256]),
      prior = await receipt(tx, op);
    if (prior) return { item: await read(tx, input.companyId, prior.assetId), replayed: true };
    const rows = await tx
      .select({ id: imageAssets.id, sha256: imageAssetFiles.sha256, byteSize: imageAssetFiles.byteSize })
      .from(imageSubmissions)
      .innerJoin(imageAssets, eq(imageAssets.id, imageSubmissions.assetId))
      .innerJoin(imageAssetFiles, eq(imageAssetFiles.assetId, imageAssets.id))
      .where(eq(imageAssets.companyId, input.companyId));
    if (rows.some((r) => r.sha256 === sha256))
      throw new ImageSubmissionError("この会社には同じ画像が提出済みです。自分の一覧にない場合は運営にご確認ください");
    if (
      rows.length >= CUSTOMER_MATERIAL_MAX_ITEMS ||
      rows.reduce((n, r) => n + r.byteSize, 0) + input.png.length > CUSTOMER_MATERIAL_MAX_BYTES
    )
      throw new ImageSubmissionError("この会社の素材保存上限に達しました。運営にご相談ください");
    const [asset] = await tx
      .insert(imageAssets)
      .values({
        companyId: input.companyId,
        label: clean.label,
        sourceType: "customer_upload",
        rightsStatus: "unknown",
        allowSalesDemo: false,
        allowProduction: false,
        placement: "reference",
        createdAt: clock.now(),
        updatedAt: clock.now(),
      })
      .returning();
    await tx.insert(imageAssetFiles).values({
      assetId: asset!.id,
      pngBase64: input.png.toString("base64"),
      sha256,
      width: input.width,
      height: input.height,
      byteSize: input.png.length,
      uploadedBy: who.userId,
      uploadedAt: clock.now(),
    });
    const { label: _, ...claims } = clean;
    await tx.insert(imageSubmissions).values({
      assetId: asset!.id,
      submittedBy: who.userId,
      ...claims,
      submittedAt: clock.now(),
      updatedAt: clock.now(),
    });
    await remember(tx, clock, op, asset!.id);
    await recordEvent(tx, clock, {
      actor: who,
      action: "image_submission.submitted",
      targetType: "company",
      targetId: input.companyId,
      after: {
        assetId: asset!.id,
        sha256,
        requestedDemo: clean.requestedDemo,
        requestedProduction: clean.requestedProduction,
      },
    });
    return { item: await read(tx, input.companyId, asset!.id), replayed: false };
  });
}
export async function reviseCustomerImage(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  input: CustomerImageDetails & { companyId: string; assetId: string; revision: number; requestId: string },
) {
  const clean = details(input);
  return db.transaction(async (tx) => {
    const who = await customer(tx, actor, input.companyId),
      op = operation(who.userId, input.requestId, ["revise", input.companyId, input.assetId, input.revision, clean]),
      prior = await receipt(tx, op);
    if (prior) return { item: await read(tx, input.companyId, prior.assetId), replayed: true };
    const { asset, submission: s } = await lockSubmission(tx, input.companyId, input.assetId);
    if (s.submittedBy !== who.userId) throw new ImageSubmissionError("自分が提出した画像だけ変更できます");
    if (s.revision !== input.revision || !["pending", "needs_changes"].includes(s.status))
      throw new ImageSubmissionError("確認状況が変わりました。一覧を更新して確認してください");
    const { label, ...claims } = clean;
    await tx.update(imageAssets).set({ label, updatedAt: clock.now() }).where(eq(imageAssets.id, asset.id));
    await tx
      .update(imageSubmissions)
      .set({ ...claims, status: "pending", revision: s.revision + 1, updatedAt: clock.now() })
      .where(eq(imageSubmissions.assetId, asset.id));
    await remember(tx, clock, op, asset.id);
    await recordEvent(tx, clock, {
      actor: who,
      action: "image_submission.revised",
      targetType: "company",
      targetId: input.companyId,
      after: { assetId: asset.id, revision: s.revision + 1 },
    });
    return { item: await read(tx, input.companyId, asset.id), replayed: false };
  });
}
export async function withdrawCustomerImage(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  input: { companyId: string; assetId: string; revision: number; requestId: string; confirmed: boolean },
) {
  if (input.confirmed !== true) throw new ImageSubmissionError("取り下げの確認が必要です");
  return db.transaction(async (tx) => {
    const who = await customer(tx, actor, input.companyId),
      op = operation(who.userId, input.requestId, ["withdraw", input.companyId, input.assetId, input.revision]),
      prior = await receipt(tx, op);
    if (prior) return { item: await read(tx, input.companyId, prior.assetId), replayed: true };
    const { asset, submission: s } = await lockSubmission(tx, input.companyId, input.assetId);
    if (s.submittedBy !== who.userId) throw new ImageSubmissionError("自分が提出した画像だけ取り下げできます");
    if (s.revision !== input.revision || s.status === "withdrawn")
      throw new ImageSubmissionError("確認状況が変わりました。一覧を更新して確認してください");
    await tx
      .update(imageSubmissions)
      .set({ status: "withdrawn", revision: s.revision + 1, updatedAt: clock.now() })
      .where(eq(imageSubmissions.assetId, asset.id));
    await tx
      .update(imageAssets)
      .set({
        rightsStatus: "unknown",
        allowSalesDemo: false,
        allowProduction: false,
        placement: "reference",
        confirmedBy: null,
        confirmedAt: null,
        policyRevision: asset.policyRevision + 1,
        updatedAt: clock.now(),
      })
      .where(eq(imageAssets.id, asset.id));
    await remember(tx, clock, op, asset.id);
    await recordEvent(tx, clock, {
      actor: who,
      action: "image_submission.withdrawn",
      targetType: "company",
      targetId: input.companyId,
      after: { assetId: asset.id, revision: s.revision + 1 },
    });
    return { item: await read(tx, input.companyId, asset.id), replayed: false };
  });
}
export async function reviewCustomerImage(
  db: DbOrTx,
  clock: Clock,
  actor: Actor | null,
  input: {
    companyId: string;
    assetId: string;
    revision: number;
    requestId: string;
    decision: "accepted" | "needs_changes";
    note: string;
    allowDemo: boolean;
    allowProduction: boolean;
    confirmed: boolean;
  },
) {
  if (
    !input ||
    !["accepted", "needs_changes"].includes(input.decision) ||
    typeof input.note !== "string" ||
    input.note.trim().length < 5 ||
    input.note.trim().length > 2000 ||
    typeof input.allowDemo !== "boolean" ||
    typeof input.allowProduction !== "boolean" ||
    input.confirmed !== true
  )
    throw new ImageSubmissionError("確認結果と顧客へ伝える内容を入力し、確認チェックを付けてください");
  return db.transaction(async (tx) => {
    const who = await operator(tx, actor, input.companyId),
      note = input.note.trim(),
      op = operation(who.userId, input.requestId, [
        "review",
        input.companyId,
        input.assetId,
        input.revision,
        input.decision,
        note,
        input.allowDemo,
        input.allowProduction,
      ]),
      prior = await receipt(tx, op);
    if (prior) return { item: await read(tx, input.companyId, prior.assetId), replayed: true };
    const { asset, submission: s } = await lockSubmission(tx, input.companyId, input.assetId);
    if (s.revision !== input.revision || s.status !== "pending")
      throw new ImageSubmissionError("提出内容や確認状況が変わりました。一覧を更新して確認してください");
    if (
      input.decision === "accepted" &&
      ((!input.allowDemo && !input.allowProduction) ||
        (input.allowDemo && !s.requestedDemo) ||
        (input.allowProduction && !s.requestedProduction))
    )
      throw new ImageSubmissionError("顧客が許可した範囲から、確認済みの用途を選んでください");
    const accepted = input.decision === "accepted";
    await tx
      .update(imageSubmissions)
      .set({
        status: input.decision,
        revision: s.revision + 1,
        reviewNote: note,
        reviewedBy: who.userId,
        reviewedAt: clock.now(),
        updatedAt: clock.now(),
      })
      .where(eq(imageSubmissions.assetId, asset.id));
    await tx
      .update(imageAssets)
      .set({
        rightsStatus: accepted ? "customer_claimed" : "unknown",
        allowSalesDemo: accepted && input.allowDemo,
        allowProduction: accepted && input.allowProduction,
        confirmedBy: accepted ? who.userId : null,
        confirmedAt: accepted ? clock.now() : null,
        note: accepted ? note : null,
        policyRevision: asset.policyRevision + 1,
        updatedAt: clock.now(),
      })
      .where(eq(imageAssets.id, asset.id));
    await remember(tx, clock, op, asset.id);
    await recordEvent(tx, clock, {
      actor: who,
      action: "image_submission.reviewed",
      targetType: "company",
      targetId: input.companyId,
      after: {
        assetId: asset.id,
        revision: s.revision + 1,
        status: input.decision,
        allowSalesDemo: accepted && input.allowDemo,
        allowProduction: accepted && input.allowProduction,
      },
    });
    return { item: await read(tx, input.companyId, asset.id), replayed: false };
  });
}
export async function listCustomerImages(db: DbOrTx, actor: Actor | null, companyId: string, page = 0) {
  return db.transaction(async (tx) => {
    const who = await customer(tx, actor, companyId),
      filter = and(eq(imageAssets.companyId, companyId), eq(imageSubmissions.submittedBy, who.userId));
    const [total] = await tx
      .select({ value: count() })
      .from(imageSubmissions)
      .innerJoin(imageAssets, eq(imageAssets.id, imageSubmissions.assetId))
      .where(filter);
    const rows = await tx
      .select(selection)
      .from(imageSubmissions)
      .innerJoin(imageAssets, eq(imageAssets.id, imageSubmissions.assetId))
      .innerJoin(imageAssetFiles, eq(imageAssetFiles.assetId, imageAssets.id))
      .where(filter)
      .orderBy(desc(imageSubmissions.submittedAt), desc(imageAssets.id))
      .limit(20)
      .offset(Math.max(0, Math.min(Number.isSafeInteger(page) ? page : 0, 100000)) * 20);
    return { total: total!.value, items: rows.map(viewRow) };
  });
}
export async function listImageSubmissionsForOps(
  db: DbOrTx,
  actor: Actor | null,
  input: { companyId?: string; page?: number; pendingOnly?: boolean } = {},
) {
  if (input.companyId && !uuid(input.companyId)) throw new ImageSubmissionError("企業を確認してください");
  return db.transaction(async (tx) => {
    await activeContentOperator(tx, actor);
    const filter = and(
      input.companyId ? eq(imageAssets.companyId, input.companyId) : undefined,
      input.pendingOnly ? eq(imageSubmissions.status, "pending") : undefined,
    );
    const [total] = await tx
      .select({ value: count() })
      .from(imageSubmissions)
      .innerJoin(imageAssets, eq(imageAssets.id, imageSubmissions.assetId))
      .where(filter);
    const page = Number.isSafeInteger(input.page) && input.page! >= 0 ? Math.min(input.page!, 100000) : 0;
    const rows = await tx
      .select({ ...selection, companyName: companies.name, submitterName: users.displayName })
      .from(imageSubmissions)
      .innerJoin(imageAssets, eq(imageAssets.id, imageSubmissions.assetId))
      .innerJoin(imageAssetFiles, eq(imageAssetFiles.assetId, imageAssets.id))
      .innerJoin(companies, eq(companies.id, imageAssets.companyId))
      .innerJoin(users, eq(users.id, imageSubmissions.submittedBy))
      .where(filter)
      .orderBy(desc(imageSubmissions.submittedAt), desc(imageAssets.id))
      .limit(20)
      .offset(page * 20);
    return {
      total: total!.value,
      items: rows.map((r) => ({ ...viewRow(r), companyName: r.companyName, submitterName: r.submitterName })),
    };
  });
}
export async function countPendingImageSubmissions(db: DbOrTx, actor: Actor | null) {
  return db.transaction(async (tx) => {
    await activeContentOperator(tx, actor);
    const [total] = await tx
      .select({ value: count() })
      .from(imageSubmissions)
      .where(eq(imageSubmissions.status, "pending"));
    return total!.value;
  });
}
export async function getCustomerImageFile(db: DbOrTx, actor: Actor | null, assetId: string) {
  if (actor?.kind !== "customer_user") throw new ImageSubmissionError("顧客としてログインしてください");
  if (!uuid(assetId)) return null;
  const [hint] = await db
    .select({ companyId: imageAssets.companyId })
    .from(imageAssets)
    .where(eq(imageAssets.id, assetId));
  if (!hint) return null;
  return db.transaction(async (tx) => {
    const who = await customer(tx, actor, hint.companyId),
      [s] = await tx
        .select({ submittedBy: imageSubmissions.submittedBy })
        .from(imageSubmissions)
        .where(eq(imageSubmissions.assetId, assetId));
    if (s?.submittedBy !== who.userId) throw new ImageSubmissionError("自分が提出した画像だけ確認できます");
    const [file] = await tx.select().from(imageAssetFiles).where(eq(imageAssetFiles.assetId, assetId));
    if (!file) return null;
    const bytes = Buffer.from(file.pngBase64, "base64");
    if (hash(bytes) !== file.sha256) return null;
    return { bytes };
  });
}
