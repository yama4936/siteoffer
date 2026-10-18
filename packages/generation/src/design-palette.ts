import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import sharp from "sharp";
import { requiresReferenceVisual } from "./design-reference.ts";
import type { GenerationInput, GenerationPurpose } from "./schemas.ts";

/** Sample a bounded image locally and retain frequent, visually distinct colour bins. */
export async function extractDesignPalette(bytes: Buffer): Promise<string[]> {
  if (bytes.byteLength > 12 * 1024 * 1024) throw new Error("reference too large");
  const { data, info } = await sharp(bytes, { limitInputPixels: 20_000_000 })
    .flatten({ background: "#ffffff" })
    .resize(160, 160, { fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error("reference colour channels");
  const bins = new Map<number, { count: number; sum: number[] }>();
  for (let i = 0; i < data.length; i += 3) {
    const rgb = [data[i]!, data[i + 1]!, data[i + 2]!];
    const key = ((rgb[0]! >> 5) << 6) | ((rgb[1]! >> 5) << 3) | (rgb[2]! >> 5);
    const bin = bins.get(key) ?? { count: 0, sum: [0, 0, 0] };
    bin.count++;
    for (let c = 0; c < 3; c++) bin.sum[c] = bin.sum[c]! + rgb[c]!;
    bins.set(key, bin);
  }
  const points = [...bins.entries()]
    .map(([id, bin]) => ({ id, count: bin.count, rgb: bin.sum.map((sum) => Math.round(sum / bin.count)) }))
    .sort((a, b) => b.count - a.count || a.id - b.id);
  const chosen: typeof points = [];
  if (points.length) chosen.push(points.shift()!);
  while (chosen.length < 24 && points.length) {
    let bestIndex = 0,
      bestScore = -1;
    for (let i = 0; i < points.length; i++) {
      const point = points[i]!;
      const distance = Math.min(
        ...chosen.map((other) => point.rgb.reduce((sum, value, c) => sum + (value - other.rgb[c]!) ** 2, 0)),
      );
      const score = distance * Math.sqrt(point.count);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    chosen.push(points.splice(bestIndex, 1)[0]!);
  }
  // Black/white remain available for legible text even in a nearly uniform reference.
  return [
    ...new Set(
      chosen
        .map((point) => `#${point.rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`)
        .concat(["#000000", "#ffffff"]),
    ),
  ];
}

/** Recompute from the approved bytes, rather than trusting a caller-supplied palette. */
export async function withReferencePalette(
  purpose: GenerationPurpose,
  input: GenerationInput,
): Promise<GenerationInput> {
  if (!requiresReferenceVisual(purpose, input)) return input;
  const reference = input.context.approvedDesign as Record<string, unknown>;
  const attachment = input.attachments.find((a) => a.kind === "image" && a.name === "approved-design.png")!;
  const file = await stat(attachment.path);
  if (!file.isFile() || file.size > 12 * 1024 * 1024) throw new Error("reference size");
  const bytes = await readFile(attachment.path);
  if (createHash("sha256").update(bytes).digest("hex") !== String(reference.sha256).toLowerCase())
    throw new Error("reference changed");
  const palette = await extractDesignPalette(bytes);
  if (palette.length < 2 || palette.length > 26) throw new Error("reference palette size");
  return { ...input, context: { ...input.context, approvedDesign: { ...reference, palette } } };
}
