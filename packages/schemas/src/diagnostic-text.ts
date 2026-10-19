/** Script-authored diagnostic explanations must be text, not a lossy decode or a coerced value. */
export function isReadableDiagnosticText(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  for (const character of value) {
    if (character === "\uFFFD" || character === "\0") return false;
    const code = character.charCodeAt(0);
    // for...of keeps valid astral pairs together; a single surrogate is malformed Unicode.
    if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}
