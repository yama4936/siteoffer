export type ObservationEntry = {
  fact: string | null;
  evidence: string | null;
  url: string | null;
  href: string | null;
  fetchedAt: string | null;
};

/** 保存された参照先だけを開く。補完・書き換え・外部への先読みは行わない。 */
export function observationHref(value: string): string | null {
  if (!/^https?:\/\//i.test(value) || value.includes("\\")) return null;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code <= 32 || code === 127) return null;
  }
  try {
    const url = new URL(value);
    return url.hostname && !url.username && !url.password ? value : null;
  } catch {
    return null;
  }
}

const fields = new Set(["fact", "evidence", "url", "fetched_at"]);

/** 現行・旧形式を表示用に読むだけで、保存値や不明な値を文字列へ変換しない。 */
export function readObservations(value: unknown): { entries: ObservationEntry[]; needsOriginal: boolean } {
  if (value === null || value === undefined) return { entries: [], needsOriginal: false };
  const records = Array.isArray(value) ? value : [value];
  let needsOriginal = !Array.isArray(value);
  const entries = records.map((record): ObservationEntry => {
    const object = record !== null && typeof record === "object" && !Array.isArray(record) ? record : {};
    if (object !== record || Object.keys(object).some((key) => !fields.has(key))) needsOriginal = true;
    function text(key: string): string | null {
      if (!Object.hasOwn(object, key)) return null;
      const field = (object as Record<string, unknown>)[key];
      if (field === null || field === undefined) return null;
      if (typeof field === "string" && field.trim().length > 0) return field;
      needsOriginal = true;
      return null;
    }
    const fact = text("fact"),
      evidence = text("evidence"),
      url = text("url"),
      fetchedAt = text("fetched_at");
    if (!fact && !evidence && !url && !fetchedAt) needsOriginal = true;
    return { fact, evidence, url, href: url ? observationHref(url) : null, fetchedAt };
  });
  return { entries, needsOriginal };
}
