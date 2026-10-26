import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SiteInputRaw } from "@siteoffer/astro-site";
import { loadProposalImageAssets } from "@siteoffer/core";
import type { DbOrTx } from "@siteoffer/db";
import type { Attachment, GenerationInput } from "@siteoffer/schemas";

export async function prepareProposalMaterials(
  db: DbOrTx,
  companyId: string,
  snapshot: unknown,
  workDir: string,
  input: GenerationInput,
) {
  const files = await loadProposalImageAssets(db, companyId, snapshot);
  const attachments: Attachment[] = [];
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
        demoMaterials: files.map((f) => ({
          assetId: f.assetId,
          slot: f.slot,
          label: f.label,
          sha256: f.sha256,
          policyRevision: f.policyRevision,
          instruction:
            "アプリがこの許可済み素材だけを指定箇所へ組み込みます。写真を実際の実績・建物・人物と推測しない。承認デザイン画像はレイアウト参照のみ。",
        })),
      },
    },
  };
}
export function applyProposalMaterials(
  input: SiteInputRaw,
  images: Partial<Record<"hero" | "logo", { src: string; alt: string }>>,
): SiteInputRaw {
  return {
    ...input,
    company: { ...input.company, ...(images.logo ? { logo: images.logo } : {}) },
    hero: { ...input.hero, ...(images.hero ? { image: images.hero } : {}) },
  };
}
