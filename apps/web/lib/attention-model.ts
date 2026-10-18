export type AttentionRole = "ops" | "sales";
export interface AttentionItem {
  key: string;
  title: string;
  reason: string;
  action: string;
  href: string;
  group: string;
}
export interface AttentionSummary {
  role: AttentionRole;
  total: number;
  checkedAt: string;
  groups: { key: string; label: string; count: number; href: string }[];
  items: AttentionItem[];
}
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
function localHref(value: unknown, role: AttentionRole): value is string {
  if (
    !text(value, 1500) ||
    [...value].some((char) => char.charCodeAt(0) <= 32 || char === "\\") ||
    !value.startsWith(`/${role}`)
  )
    return false;
  try {
    const url = new URL(value, "https://local.invalid");
    return (
      url.origin === "https://local.invalid" && (url.pathname === `/${role}` || url.pathname.startsWith(`/${role}/`))
    );
  } catch {
    return false;
  }
}
/** Reject malformed or cross-role data before showing links in the shared header. */
export function parseAttentionSummary(value: unknown, role: AttentionRole): AttentionSummary | null {
  if (!value || typeof value !== "object") return null;
  const data = value as AttentionSummary;
  if (
    data.role !== role ||
    !Number.isSafeInteger(data.total) ||
    data.total < 0 ||
    !text(data.checkedAt, 40) ||
    !Number.isFinite(Date.parse(data.checkedAt)) ||
    !Array.isArray(data.items) ||
    data.items.length > 6 ||
    !Array.isArray(data.groups) ||
    data.groups.length > 20
  )
    return null;
  const groupKeys = new Set<string>(),
    itemKeys = new Set<string>();
  let count = 0;
  for (const group of data.groups) {
    if (
      !group ||
      !text(group.key, 80) ||
      groupKeys.has(group.key) ||
      !text(group.label, 100) ||
      !Number.isSafeInteger(group.count) ||
      group.count < 1 ||
      !localHref(group.href, role)
    )
      return null;
    groupKeys.add(group.key);
    count += group.count;
  }
  if (count !== data.total || data.items.length > data.total) return null;
  for (const item of data.items) {
    if (
      !item ||
      !text(item.key, 160) ||
      itemKeys.has(item.key) ||
      !text(item.title, 500) ||
      !text(item.reason, 1000) ||
      !text(item.action, 200) ||
      !groupKeys.has(item.group) ||
      !localHref(item.href, role)
    )
      return null;
    itemKeys.add(item.key);
  }
  return data;
}
