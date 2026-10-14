import { appSettings, type DbOrTx } from "@siteoffer/db";
import { eq } from "drizzle-orm";

/**
 * 運営設定の既定値。値は推奨案（12.2）で、運営が変更できる。
 * ここに無いキーを読もうとしたら型エラーにする。
 */
export const DEFAULT_SETTINGS = {
  "assignment.maxActivePerUser": 3,
  "assignment.unstartedTimeoutHours": 72,
  "shareLink.defaultTtlHours": 24 * 14,
  "session.ttlHours": 24 * 7,
} as const satisfies Record<string, number | string | boolean>;

export type SettingKey = keyof typeof DEFAULT_SETTINGS;

export async function getSetting<K extends SettingKey>(db: DbOrTx, key: K): Promise<(typeof DEFAULT_SETTINGS)[K]> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
  return (row?.value ?? DEFAULT_SETTINGS[key]) as (typeof DEFAULT_SETTINGS)[K];
}
