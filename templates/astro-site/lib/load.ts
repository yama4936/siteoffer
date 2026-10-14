/**
 * Astroのページが、ビルド関数の書き出した解決済み入力を読む。
 * ここでも検証し、delivery で要確認マーカーが残っていればビルドを失敗させる（ビルド関数を通さずに astro build した場合の保険）。
 */
import { readFileSync } from "node:fs";
import {
  markerErrorMessage,
  RESOLVED_INPUT_ENV,
  type ResolvedSite,
  resolveMode,
  validateSiteInput,
} from "./resolve.ts";

export function loadResolvedSite(env: NodeJS.ProcessEnv = process.env): ResolvedSite {
  const file = env[RESOLVED_INPUT_ENV];
  if (!file) {
    throw new Error(
      `${RESOLVED_INPUT_ENV} が未設定。astro build を直接呼ばず、build/cli.ts（buildSite）から入力JSONを指定してビルドする。`,
    );
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as { mode?: unknown; input?: unknown };
  const v = validateSiteInput(raw.input);
  if (!v.ok) throw new Error(`入力JSONが不正：\n${v.errors.join("\n")}`);
  const mode = resolveMode({ explicit: typeof raw.mode === "string" ? raw.mode : undefined, input: v.input.mode });
  if (mode === "delivery" && v.markers.length > 0) throw new Error(markerErrorMessage(v.markers));
  return { mode, input: v.input };
}
