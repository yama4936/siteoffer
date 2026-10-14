/** 役割ごとのログイン後の移動先（純粋関数。next/* に依存しない） */
export function homePathFor(role: "sales" | "ops"): string {
  return role === "ops" ? "/ops" : "/sales/companies";
}
