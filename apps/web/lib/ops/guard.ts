import { type Actor, err, ok, type Result } from "@siteoffer/core";

/** 運営の操作主体 */
export type OpsActor = Extract<Actor, { kind: "ops" }>;

/**
 * 運営画面の読み取り・処理の入口で必ず呼ぶ（AC-17）。
 * 画面（layout）でも運営以外を移動させるが、Server Function は直接POSTで呼べるため、ここでも判定する。
 * 個別の権限（設定・報酬など）は、この後に core の authorize / 業務関数で重ねて判定する。
 */
export function requireOps(actor: Actor | null): Result<OpsActor, "forbidden"> {
  if (actor?.kind === "ops") return ok(actor);
  return err("forbidden", "運営だけが行える操作です");
}
