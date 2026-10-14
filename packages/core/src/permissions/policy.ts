import type { Actor } from "../common/actor.ts";
import { err, ok, type Result } from "../common/result.ts";

/**
 * 権限判定の対象（resource）。種類ごとに、判定に必要な属性だけを持つ。
 * 新しい種類を足すときは ResourceMap・ActionMap・policies の3か所に追加する（policies が欠けると型エラー）。
 *
 * 所有者（ownerUserId）は呼び出し側がDBから読んで渡す。画面から受け取った値をそのまま使わない。
 */
export interface ResourceMap {
  /** 企業。営業可能な候補か、誰が担当中かで詳細の可否が変わる */
  company: { companyId: string; sellable: boolean; assignedUserId: string | null };
  /** 担当案件（Assignment） */
  assignment: { ownerUserId: string };
  /** 活動記録・活動メモ・運営への相談 */
  salesActivity: { ownerUserId: string };
  /** ドメイン希望 */
  domainPreference: { ownerUserId: string };
  /** 契約（成約報告を含む） */
  contract: { ownerUserId: string };
  /** 営業報酬・報酬の調整 */
  reward: { ownerUserId: string };
  /** 顧客からの入金 */
  payment: Record<never, never>;
  /** 販売条件・報酬条件 */
  productTerms: Record<never, never>;
  /** 運営設定（同時担当数・期限など） */
  settings: Record<never, never>;
  /** 操作履歴 */
  auditLog: Record<never, never>;
  /** ユーザー（営業・運営） */
  user: { userId: string; role: "sales" | "ops" };
}

export interface ActionMap {
  /** read_shared：担当中か・営業拒否など、重複防止に必要な企業共通の状態だけ */
  company: "read_shared" | "read" | "claim" | "report_refusal" | "manage";
  assignment: "read" | "update" | "release" | "reassign";
  salesActivity: "read" | "create" | "update";
  domainPreference: "read" | "create" | "update";
  /** report：成約報告。confirm：運営の契約確認 */
  contract: "read" | "report" | "confirm" | "update";
  reward: "read" | "manage";
  payment: "read" | "manage";
  productTerms: "read" | "manage";
  settings: "read" | "update";
  auditLog: "read";
  /** suspend・reactivate：利用停止と解除 */
  user: "read" | "list" | "suspend" | "reactivate";
}

export type ResourceType = keyof ResourceMap;
export type Resource = { [K in ResourceType]: { type: K } & ResourceMap[K] }[ResourceType];
export type ResourceOf<K extends ResourceType> = { type: K } & ResourceMap[K];
export type ActionOf<K extends ResourceType> = ActionMap[K];

type SalesActor = Extract<Actor, { kind: "sales" }>;
type SalesPolicy<K extends ResourceType> = (
  actor: SalesActor,
  action: ActionMap[K],
  resource: ResourceOf<K>,
) => boolean;

const own = (actor: SalesActor, r: { ownerUserId: string }) => r.ownerUserId === actor.userId;

/**
 * 営業ユーザーの規則。運営はすべて許可（ただし下の opsRule の例外を除く）。
 * 顧客（提案リンク）はここでは常に拒否する。提案リンクの判定は share-link 側で行う。
 */
const salesPolicies: { [K in ResourceType]: SalesPolicy<K> } = {
  company: (actor, action, r) => {
    switch (action) {
      case "read_shared":
        return true;
      case "read":
        return r.sellable || r.assignedUserId === actor.userId;
      case "claim":
        // 確保できるかの業務条件（上限・営業拒否・競合）は担当確保の処理で判定する
        return r.sellable;
      case "report_refusal":
        return r.assignedUserId === actor.userId;
      case "manage":
        return false;
    }
  },
  assignment: (actor, action, r) => action !== "reassign" && own(actor, r),
  salesActivity: (actor, _action, r) => own(actor, r),
  domainPreference: (actor, _action, r) => own(actor, r),
  contract: (actor, action, r) => (action === "read" || action === "report") && own(actor, r),
  reward: (actor, action, r) => action === "read" && own(actor, r),
  payment: () => false,
  // 販売条件は営業が案内に使うため読める。変更はできない（5.1）
  productTerms: (_actor, action) => action === "read",
  settings: () => false,
  auditLog: () => false,
  user: (actor, action, r) => action === "read" && r.userId === actor.userId,
};

/** 運営にも許さない操作。利用停止の対象は営業ユーザーだけ（運営アカウントは seed・管理手順で扱う） */
function opsRule(actor: Extract<Actor, { kind: "ops" }>, action: string, resource: Resource): boolean {
  if (resource.type === "user" && (action === "suspend" || action === "reactivate")) {
    return resource.role === "sales" && resource.userId !== actor.userId;
  }
  return true;
}

/**
 * サーバー側の権限判定。画面とAPIの両方から呼ぶ。画面の表示制御だけに頼らない（24.2・AC-17）。
 * actor が null（未ログイン）なら常に拒否。
 * system（ワーカーの定期ジョブ等）は許可する。system を名乗れるのはサーバー内部のコードだけにする。
 */
export function can<K extends ResourceType>(
  actor: Actor | null,
  action: ActionOf<K>,
  resource: ResourceOf<K>,
): boolean {
  if (!actor) return false;
  switch (actor.kind) {
    case "ops":
      return opsRule(actor, action, resource as Resource);
    case "system":
      return true;
    case "customer":
      return false;
    case "sales": {
      const policy = salesPolicies[resource.type] as SalesPolicy<K>;
      return policy(actor, action, resource);
    }
  }
}

export type AuthorizeError = "unauthenticated" | "forbidden";

/** can の Result 版。業務関数の先頭で `const a = authorize(...); if (!a.ok) return a;` のように使う */
export function authorize<K extends ResourceType>(
  actor: Actor | null,
  action: ActionOf<K>,
  resource: ResourceOf<K>,
): Result<void, AuthorizeError> {
  if (!actor) return err("unauthenticated");
  return can(actor, action, resource)
    ? ok(undefined)
    : err("forbidden", `${resource.type}.${action} は許可されていません`);
}
