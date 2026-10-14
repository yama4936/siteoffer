/** Server Function が受け取る FormData の読み取り（純粋関数。next/* に依存しない） */

export function str(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === "string" ? v.trim() : "";
}

/** 空欄は null */
export function optStr(fd: FormData, name: string): string | null {
  return str(fd, name) || null;
}

/** 空欄は null。整数でなければ NaN（業務関数の検証で弾く） */
export function optInt(fd: FormData, name: string): number | null {
  const v = str(fd, name).replace(/[,，_]/g, "");
  if (!v) return null;
  return /^-?\d+$/.test(v) ? Number(v) : Number.NaN;
}

/**
 * 画面の日時入力（datetime-local / date）は日本時間として解釈する。
 * サーバーのタイムゾーンに左右されないよう、+09:00 を付けて Date にする。空欄・不正は null。
 */
export function jstDate(fd: FormData, name: string): Date | null {
  const v = str(fd, name);
  if (!v) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00+09:00` : `${v.length === 16 ? `${v}:00` : v}+09:00`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** URLの id がUUIDか（不正な値をDBに渡して例外にしない） */
export function isUuid(v: string | undefined | null): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** 戻り先は運営画面の中だけに限る（外部への移動に使わせない） */
export function safeReturnTo(value: FormDataEntryValue | null, fallback = "/ops"): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/ops") || value.startsWith("//") || value.includes("\\")) return fallback;
  if (value.length > 4 && !["/", "?", "#"].includes(value[4]!)) return fallback;
  return value;
}

/** 戻り先に結果の文言を付ける（既存の msg / error は置き換える） */
export function withFlash(path: string, flash: { msg?: string; error?: string }): string {
  const [base, query = ""] = path.split("?", 2) as [string, string?];
  const params = new URLSearchParams(query);
  params.delete("msg");
  params.delete("error");
  if (flash.msg) params.set("msg", flash.msg);
  if (flash.error) params.set("error", flash.error);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
