import { ACTIVE_ASSIGNMENT_STATUSES, assignments, type DbOrTx, domainPreferences } from "@siteoffer/db";
import { and, eq, sql } from "drizzle-orm";
import { lockAssignmentCompany } from "../assignment/shared.ts";
import type { Actor } from "../common/actor.ts";
import type { Clock } from "../common/clock.ts";
import { recordEvent } from "../common/events.ts";
import { err, ok, type Result } from "../common/result.ts";
import { authorizeUser, requireUser } from "../permissions/policy.ts";
import { findSecretInFields, type SecretKind } from "./secrets.ts";

export type DomainPreference = typeof domainPreferences.$inferSelect;
export type DomainIntent = DomainPreference["intent"];
export type DomainManager = DomainPreference["currentManager"];
export type TriState = DomainPreference["usesEmail"];

/** 新規候補を表示するときに添える文言（13章：表示だけでは空き・取得成功を保証しない） */
export const NEW_DOMAIN_AVAILABILITY_NOTICE =
  "新規ドメイン候補は希望の記録です。空き状況や取得できることを保証するものではありません。取得の可否は運営が確認します。";

/** 既存ドメインを使う場合の文言（13章：公開前に運営が管理権限・メール等への影響を確認する） */
export const EXISTING_DOMAIN_REVIEW_NOTICE =
  "現在のドメインを使う場合は、公開前に運営が管理権限・現在のサービス・メール等への影響を確認します。接続先の変更とドメインの移管は別の手続きです。";

const INTENTS: readonly DomainIntent[] = ["keep", "transfer_consult", "new", "undecided"];
const MANAGERS: readonly DomainManager[] = ["company", "vendor", "unknown"];
const TRI: readonly TriState[] = ["yes", "no", "unknown"];

export const MAX_NEW_DOMAIN_CANDIDATES = 10;
const MAX_TEXT = 2000;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * 聞き取りの入力。レジストラのパスワード・移管コード・鍵の欄は意図的に持たない（13章）。
 * needsOpsReview は運営だけが変更できる。
 */
export interface DomainPreferenceInput {
  companyId: string;
  assignmentId?: string | null;
  currentUrl?: string | null;
  currentDomain?: string | null;
  intent: DomainIntent;
  newDomainCandidates?: string[];
  currentManager?: DomainManager;
  usesEmail?: TriState;
  customerWish?: string | null;
  needsOpsReview?: boolean;
}

export type DomainPreferenceError =
  | "forbidden"
  | "invalid_input"
  | "secret_like_value"
  | "assignment_not_found"
  | "not_found"
  | "conflict";

export interface SavedDomainPreference {
  preference: DomainPreference;
  /** 画面に表示する注意文 */
  notices: string[];
}

function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
}

function noticesFor(p: Pick<DomainPreference, "intent" | "newDomainCandidates">): string[] {
  const notices: string[] = [];
  if (p.intent === "new" || p.newDomainCandidates.length > 0) notices.push(NEW_DOMAIN_AVAILABILITY_NOTICE);
  if (p.intent === "keep" || p.intent === "transfer_consult") notices.push(EXISTING_DOMAIN_REVIEW_NOTICE);
  return notices;
}

/**
 * ドメイン希望を記録する（担当ごとに1件。2回目以降は更新）。
 * - 営業：自分の有効な担当の企業についてだけ記録できる。運営確認の要否は変更できない（常に要確認）。
 * - 運営：担当なしでも記録でき、運営確認の要否を指定できる。
 * 自由記述に秘密らしき値があれば保存しない（値はエラーに含めない）。
 */
export async function saveDomainPreference(
  db: DbOrTx,
  clock: Clock,
  actor: Actor,
  input: DomainPreferenceInput,
): Promise<Result<SavedDomainPreference, DomainPreferenceError>> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  // 担当に紐づかない記録は所有者を限定しない（運営だけ）。営業は担当中の企業についてだけ記録できる
  if (!input.assignmentId) {
    const auth = authorizeUser(
      actor,
      "create",
      { type: "domainPreference", ownerUserId: null },
      "営業は担当中の企業についてだけ記録できます",
    );
    if (!auth.ok) return auth;
  }
  const actorUserId = user.value.userId;

  if (!INTENTS.includes(input.intent)) return err("invalid_input", "intent");
  if (input.currentManager !== undefined && !MANAGERS.includes(input.currentManager))
    return err("invalid_input", "currentManager");
  if (input.usesEmail !== undefined && !TRI.includes(input.usesEmail)) return err("invalid_input", "usesEmail");

  const candidatesRaw = input.newDomainCandidates ?? [];
  if (candidatesRaw.length > MAX_NEW_DOMAIN_CANDIDATES) return err("invalid_input", "newDomainCandidates");
  for (const [field, v] of [
    ["currentUrl", input.currentUrl],
    ["currentDomain", input.currentDomain],
    ["customerWish", input.customerWish],
  ] as const) {
    if (v != null && v.length > MAX_TEXT) return err("invalid_input", field);
  }

  // 秘密らしき値は形式検査より先に調べる（候補欄に貼られた移管コードも「秘密」として拒否する）
  const secret = findSecretInFields({
    currentUrl: input.currentUrl,
    currentDomain: input.currentDomain,
    customerWish: input.customerWish,
    newDomainCandidates: candidatesRaw,
  });
  if (secret) return err("secret_like_value", secretMessage(secret.field, secret.kind));

  const candidates = [...new Set(candidatesRaw.map(normalizeDomain).filter((d) => d.length > 0))];
  if (candidates.some((d) => !DOMAIN_RE.test(d))) return err("invalid_input", "newDomainCandidates");
  const currentDomain = input.currentDomain ? normalizeDomain(input.currentDomain) : null;
  if (currentDomain && !DOMAIN_RE.test(currentDomain)) return err("invalid_input", "currentDomain");

  return db.transaction(async (tx) => {
    // Parent -> assignment, including the FK write for the first saved preference.
    if (input.assignmentId && (await lockAssignmentCompany(tx, input.assignmentId)) !== input.companyId)
      return err("assignment_not_found");
    const [assignment] = input.assignmentId
      ? await tx.select().from(assignments).where(eq(assignments.id, input.assignmentId)).for("update")
      : [];
    const [existing] = input.assignmentId
      ? await tx
          .select()
          .from(domainPreferences)
          .where(eq(domainPreferences.assignmentId, input.assignmentId))
          .for("update")
      : [];

    if (input.assignmentId) {
      const a = assignment;
      if (!a || a.companyId !== input.companyId) return err("assignment_not_found");
      // 権限：ドメイン希望の所有者は担当の営業ユーザー（読んだ担当の行から渡す）
      const auth = authorizeUser(actor, existing ? "update" : "create", {
        type: "domainPreference",
        ownerUserId: a.userId,
      });
      if (!auth.ok) return auth;
      // 業務条件：営業は有効な担当についてだけ記録できる（運営は終了した担当にも記録できる）
      const active = (ACTIVE_ASSIGNMENT_STATUSES as readonly string[]).includes(a.status);
      if (actor.kind === "sales" && !active) return err("forbidden");
    }

    const needsOpsReview =
      actor.kind === "ops" && input.needsOpsReview !== undefined
        ? input.needsOpsReview || input.intent === "keep" || input.intent === "transfer_consult"
        : true;
    const values = {
      companyId: input.companyId,
      assignmentId: input.assignmentId ?? null,
      currentUrl: input.currentUrl?.trim() || null,
      currentDomain,
      intent: input.intent,
      newDomainCandidates: candidates,
      currentManager: input.currentManager ?? "unknown",
      usesEmail: input.usesEmail ?? "unknown",
      customerWish: input.customerWish?.trim() || null,
      needsOpsReview,
      recordedBy: actorUserId,
      updatedAt: clock.now(),
    } satisfies Partial<typeof domainPreferences.$inferInsert>;

    let saved: DomainPreference;
    if (existing) {
      // 内容が変わったら運営確認をやり直す
      const [row] = await tx
        .update(domainPreferences)
        .set({ ...values, revision: sql`${domainPreferences.revision} + 1`, confirmedAt: null, confirmedBy: null })
        .where(eq(domainPreferences.id, existing.id))
        .returning();
      saved = row!;
      await recordEvent(tx, clock, {
        actor,
        action: "domain_preference.update",
        targetType: "domain_preference",
        targetId: saved.id,
        before: existing,
        after: saved,
      });
    } else {
      const [row] = await tx
        .insert(domainPreferences)
        .values({ ...values, createdAt: clock.now() })
        .returning();
      saved = row!;
      await recordEvent(tx, clock, {
        actor,
        action: "domain_preference.create",
        targetType: "domain_preference",
        targetId: saved.id,
        after: saved,
      });
    }
    return ok({ preference: saved, notices: noticesFor(saved) });
  });
}

/** 運営がドメイン希望を確認した日時を記録する（13章「確認日時」） */
export async function confirmDomainPreference(
  db: DbOrTx,
  clock: Clock,
  actor: Actor,
  input: { id: string; revision: number },
): Promise<Result<DomainPreference, DomainPreferenceError>> {
  // 対象を読む前に確かめる（所有者を限定しない確認。営業は常に拒否される）
  const auth = authorizeUser(actor, "confirm", { type: "domainPreference", ownerUserId: null });
  if (!auth.ok) return auth;
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    return err("invalid_input", "確認対象の版が不正です。画面を再読み込みしてください");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id)) return err("not_found");
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(domainPreferences).where(eq(domainPreferences.id, input.id)).for("update");
    if (!before) return err("not_found");
    if (before.revision !== input.revision) {
      return err("conflict", "聞き取り内容が更新されています。最新の内容を確認してから、もう一度操作してください");
    }
    // 応答消失・別タブからの同じ確認は成功として返し、確認者・日時・履歴を増やさない。
    if (before.confirmedAt) return ok(before);
    const [after] = await tx
      .update(domainPreferences)
      .set({ confirmedAt: clock.now(), confirmedBy: auth.value.userId, updatedAt: clock.now() })
      .where(eq(domainPreferences.id, input.id))
      .returning();
    await recordEvent(tx, clock, {
      actor,
      action: "domain_preference.confirm",
      targetType: "domain_preference",
      targetId: input.id,
      before,
      after,
    });
    return ok(after!);
  });
}

/** 契約スナップショット用：担当に紐づく希望、なければ企業の最新の希望 */
export async function findDomainPreferenceForContract(
  db: DbOrTx,
  companyId: string,
  assignmentId: string,
): Promise<DomainPreference | null> {
  const [byAssignment] = await db
    .select()
    .from(domainPreferences)
    .where(and(eq(domainPreferences.companyId, companyId), eq(domainPreferences.assignmentId, assignmentId)));
  if (byAssignment) return byAssignment;
  const rows = await db.select().from(domainPreferences).where(eq(domainPreferences.companyId, companyId));
  rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return rows[0] ?? null;
}

const SECRET_LABEL: Record<SecretKind, string> = {
  aws_access_key: "AWSのアクセスキー",
  aws_secret_key: "AWSのシークレットキー",
  private_key: "秘密鍵",
  password: "パスワード",
  transfer_code: "移管コード・パスワード",
};

function secretMessage(field: string, kind: SecretKind): string {
  return `${field} に${SECRET_LABEL[kind]}らしき値が含まれているため保存しませんでした。移管コード・パスワード・鍵は入力しないでください。`;
}
