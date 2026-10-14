/** 操作の主体。権限判定と操作履歴に使う */
export type Actor =
  | { kind: "sales"; userId: string }
  | { kind: "ops"; userId: string }
  | { kind: "system"; job: string }
  | { kind: "customer"; shareLinkId: string };

export function actorUserId(actor: Actor): string | null {
  return actor.kind === "sales" || actor.kind === "ops" ? actor.userId : null;
}
