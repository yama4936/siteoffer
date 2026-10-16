import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SiteInputRaw } from "@siteoffer/astro-site";
import { loadDeliveryImageAssets } from "@siteoffer/core";
import type { DbOrTx } from "@siteoffer/db";
import type { Attachment, GenerationInput } from "@siteoffer/schemas";
export async function prepareDeliveryMaterials(
  db: DbOrTx,
  deliveryId: string,
  buildId: string,
  workDir: string,
  input: GenerationInput,
) {
  const files = await loadDeliveryImageAssets(db, buildId, deliveryId),
    attachments: Attachment[] = [];
  const images: Partial<Record<"hero" | "logo", { src: string; alt: string }>> = {};
  if (files.length) await mkdir(path.join(workDir, "materials"), { recursive: true });
  for (const f of files) {
    const name = `material-${f.assetId}.png`,
      file = path.join(workDir, "materials", name);
    await writeFile(file, f.bytes);
    attachments.push({ name, path: file, kind: "image", imagePolicy: f.policy });
    images[f.slot] = { src: `materials/${name}`, alt: f.label };
  }
  return {
    images,
    input: {
      ...input,
      attachments: [...input.attachments, ...attachments],
      context: {
        ...input.context,
        productionMaterials: files.map((f) => ({
          id: f.assetId,
          slot: f.slot,
          label: f.label,
          sha256: f.sha256,
          file: `material-${f.assetId}.png`,
          instruction:
            "この素材を指定された配置先へアプリが組み込みます。画像内の文字・人物・実績を確認済み事実として推測しない。",
        })),
      },
    },
  };
}
export function applyDeliveryMaterials(
  input: SiteInputRaw,
  images: Partial<Record<"hero" | "logo", { src: string; alt: string }>>,
): SiteInputRaw {
  return {
    ...input,
    company: { ...input.company, ...(images.logo ? { logo: images.logo } : {}) },
    hero: { ...input.hero, ...(images.hero ? { image: images.hero } : {}) },
  };
}
