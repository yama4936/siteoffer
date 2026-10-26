import { type GenerationInput, type GenerationPurpose, VisualDesignSchema } from "./schemas.ts";

export function requiresReferenceVisual(purpose: GenerationPurpose, input: GenerationInput) {
  if (purpose !== "demo_site" && purpose !== "delivery_site") return false;
  const reference = input.context.approvedDesign;
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) return false;
  const hash = (reference as { sha256?: unknown }).sha256;
  return (
    typeof hash === "string" &&
    /^[a-f0-9]{64}$/i.test(hash) &&
    input.attachments.some((a) => a.kind === "image" && a.name === "approved-design.png")
  );
}
export function referencePalette(input: GenerationInput): string[] {
  const reference = input.context.approvedDesign as { palette?: unknown } | undefined;
  const palette = reference?.palette;
  return Array.isArray(palette) &&
    palette.length > 0 &&
    palette.length <= 26 &&
    palette.every((c) => typeof c === "string" && /^#[a-f0-9]{6}$/i.test(c))
    ? palette.map((c) => c.toLowerCase())
    : [];
}
export function referenceVisualValid(output: unknown, input: GenerationInput) {
  const theme = (output as { theme?: { visual?: unknown; brand?: unknown; accent?: unknown } } | null)?.theme;
  const visual = VisualDesignSchema.safeParse(theme?.visual);
  if (!visual.success) return false;
  const palette = referencePalette(input);
  return (
    palette.length === 0 ||
    [theme?.brand, theme?.accent, visual.data.background, visual.data.surface, visual.data.text].every(
      (color) => typeof color === "string" && palette.includes(color.toLowerCase()),
    )
  );
}
/** A reference-image site must return the visual object, rather than selecting the nullable legacy fallback. */
export function requireReferenceVisualSchema(schema: Record<string, unknown>, palette: string[] = []) {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const themeProperties = properties?.theme?.properties as Record<string, Record<string, unknown>> | undefined;
  const branches = themeProperties?.visual?.anyOf;
  if (!Array.isArray(branches) || !themeProperties) return schema;
  const visual = branches.find((branch) => branch && typeof branch === "object" && branch.type === "object");
  if (visual) {
    themeProperties.visual = visual;
    if (palette.length) {
      const visualProperties = visual.properties as Record<string, Record<string, unknown>>;
      for (const key of ["background", "surface", "text"])
        visualProperties[key] = { ...visualProperties[key], enum: palette };
      for (const key of ["brand", "accent"]) themeProperties[key] = { ...themeProperties[key], enum: palette };
    }
  }
  return schema;
}
