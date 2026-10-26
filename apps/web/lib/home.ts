/** 役割ごとのログイン後の移動先（純粋関数。next/* に依存しない） */
export function homePathFor(role: "sales" | "ops" | "customer"): string {
  return role === "customer" ? "/customer/content" : role === "ops" ? "/ops" : "/sales/companies";
}
