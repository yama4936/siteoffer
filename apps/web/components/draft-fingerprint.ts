/** Keep array order and every nested field; JSONB may reorder object keys. */
export function draftFingerprint(value: object) {
  return JSON.stringify(value, (_key, part: unknown) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return part;
    const fields = part as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(fields)
        .sort()
        .map((key) => [key, fields[key]]),
    );
  });
}
