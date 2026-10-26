import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { CodexGenerator } from "../src/codex.ts";
import { extractDesignPalette, withReferencePalette } from "../src/design-palette.ts";
import { requireReferenceVisualSchema, requiresReferenceVisual } from "../src/design-reference.ts";
import { toCodexOutputSchema } from "../src/json-schema.ts";
import { loadCodexFixture, MockGenerator } from "../src/mock.ts";
import { buildPrompt } from "../src/prompt.ts";
import { NoopSandboxRunner } from "../src/sandbox/noop.ts";
import { type GenerationInput, type SiteConfig, siteConfigSchema } from "../src/schemas.ts";
import { validateOutput } from "../src/validate.ts";
import { clone, fixtureInput } from "./helpers.ts";

function referenceInput(): GenerationInput {
  const input = fixtureInput();
  input.context.approvedDesign = { sha256: "a".repeat(64), brief: { direction: "明朝見出し・深緑・直角" } };
  input.attachments = [{ name: "approved-design.png", path: "/test/reference.png", kind: "image", imagePolicy: null }];
  return input;
}
const request = (input: GenerationInput) => ({
  purpose: "demo_site" as const,
  input,
  outputSchema: siteConfigSchema,
  jobId: "reference-check",
  attempt: 1,
  timeoutMs: 10000,
});
const visualSchema = (schema: Record<string, unknown>) =>
  (schema as { properties: { theme: { properties: { visual: { type?: string; anyOf?: Array<{ type: string }> } } } } })
    .properties.theme.properties.visual;

describe("承認画像の指定を生成と検証に接続する", () => {
  it("多色の画像でも配色候補を26色以内に限定し、SDKの列挙制約へ実際に渡す", async () => {
    const pixels = Buffer.alloc(32 * 32 * 3);
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) {
        const i = (y * 32 + x) * 3;
        pixels[i] = x * 8;
        pixels[i + 1] = y * 8;
        pixels[i + 2] = ((x + y) % 32) * 8;
      }
    const png = await sharp(pixels, { raw: { width: 32, height: 32, channels: 3 } })
      .png()
      .toBuffer();
    const palette = await extractDesignPalette(png);
    expect(palette).toHaveLength(26);
    const strict = requireReferenceVisualSchema(toCodexOutputSchema(siteConfigSchema), palette);
    const visual = visualSchema(strict) as { properties: Record<string, { enum: string[] }> };
    expect(visual.properties.background!.enum).toEqual(palette);
  });
  it("参照画像と承認記録が揃ったサイトだけに適用する", () => {
    const input = referenceInput();
    expect(requiresReferenceVisual("demo_site", input)).toBe(true);
    expect(requiresReferenceVisual("delivery_site", input)).toBe(true);
    expect(requiresReferenceVisual("faq", input)).toBe(false);
    expect(requiresReferenceVisual("demo_site", { ...input, attachments: [] })).toBe(false);
    expect(requiresReferenceVisual("demo_site", { ...input, context: { approvedDesign: { sha256: "invalid" } } })).toBe(
      false,
    );
    expect(requiresReferenceVisual("demo_site", fixtureInput())).toBe(false);
  });
  it.each([undefined, null])("承認画像がある生成では空の視覚設定を成功にしない (%j)", (visual) => {
    const output = clone(loadCodexFixture("demo_site")) as SiteConfig;
    if (visual === null) output.theme.visual = null;
    expect(validateOutput("demo_site", referenceInput(), siteConfigSchema, output)).toMatchObject({
      ok: false,
      error: "schema_violation",
    });
    expect(validateOutput("demo_site", fixtureInput(), siteConfigSchema, output).ok).toBe(true);
  });
  it("SDKへ渡す形だけを必須オブジェクトにし、共有の保存スキーマは変更しない", () => {
    const normal = toCodexOutputSchema(siteConfigSchema);
    const strict = requireReferenceVisualSchema(toCodexOutputSchema(siteConfigSchema));
    expect(visualSchema(normal).anyOf?.some((v) => v.type === "null")).toBe(true);
    expect(visualSchema(strict).type).toBe("object");
    expect(visualSchema(strict).anyOf).toBeUndefined();
    expect(siteConfigSchema.safeParse(loadCodexFixture("demo_site")).success).toBe(true);
  });
  it("モックは固定デザインと明示したまま新形式を返し、明示的な不正応答は救済しない", async () => {
    const result = await new MockGenerator().generate(request(referenceInput()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.theme.visual?.headingFont).toBe("sans");
    expect(result.record).toMatchObject({ generator: "mock", usage: null, responseModel: null });
    const bad = await new MockGenerator({ overrides: { demo_site: loadCodexFixture("demo_site") } }).generate(
      request(referenceInput()),
    );
    expect(bad).toMatchObject({ ok: false, error: "schema_violation" });
    const old = await new MockGenerator().generate(request(fixtureInput()));
    if (!old.ok) throw new Error(old.message);
    expect(old.output.theme).not.toHaveProperty("visual");
  });
  it("CodexGeneratorも画像指定を失った応答を拒否し、SDK依頼には必須設定を渡す（SDK自体は偽物）", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "siteoffer-visual-test-"));
    try {
      const file = path.join(root, "reference.png");
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNUyNvCwMDAxMDAwMDAAAAOrgFGyLjQ8AAAAABJRU5ErkJggg==",
        "base64",
      );
      await writeFile(file, bytes);
      const input = referenceInput();
      (input.context.approvedDesign as { sha256: string }).sha256 = createHash("sha256").update(bytes).digest("hex");
      input.attachments[0]!.path = file;
      const runner = new NoopSandboxRunner([{ finalResponse: JSON.stringify(loadCodexFixture("demo_site")) }]);
      const result = await new CodexGenerator(runner, { workRoot: root }).generate(request(input));
      expect(result).toMatchObject({ ok: false, error: "schema_violation" });
      const schema = runner.calls[0]!.request.outputSchema;
      assert(schema);
      expect(visualSchema(schema).type).toBe("object");
      expect(JSON.stringify(schema)).toContain('"enum":["#');
      expect(runner.calls[0]!.request.prompt).toContain('"palette":');
      expect(runner.calls[0]!.request.images).toEqual(["input/files/approved-design.png"]);
      await writeFile(file, "changed bytes");
      const changedRunner = new NoopSandboxRunner([{}]);
      const changed = await new CodexGenerator(changedRunner, { workRoot: root }).generate(request(input));
      expect(changed).toMatchObject({ ok: false, error: "schema_violation", record: { usage: null } });
      expect(changedRunner.calls).toHaveLength(0);
    } finally {
      const resolved = path.resolve(root);
      assert(
        resolved.startsWith(path.resolve(tmpdir()) + path.sep) &&
          path.basename(resolved).startsWith("siteoffer-visual-test-"),
        "unexpected cleanup target",
      );
      await rm(resolved, { recursive: true, force: true });
    }
  });
  it("参照画像の色と可読性の黒白だけを候補にし、入力を変更せず、画像の変更を検出する", async () => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNUyNvCwMDAxMDAwMDAAAAOrgFGyLjQ8AAAAABJRU5ErkJggg==",
      "base64",
    );
    const palette = await extractDesignPalette(bytes);
    expect(palette.length).toBeLessThanOrEqual(26);
    expect(palette).toEqual(expect.arrayContaining(["#000000", "#ffffff"]));
    expect(palette).not.toContain("#03ff00");
    await expect(extractDesignPalette(Buffer.from("not an image"))).rejects.toThrow();
    await expect(withReferencePalette("demo_site", referenceInput())).rejects.toThrow();
    const untouched = fixtureInput();
    expect(await withReferencePalette("faq", untouched)).toBe(untouched);
  });
  it("配色候補外の応答は形式が正しくコントラストを満たしても拒否する", async () => {
    const mock = await new MockGenerator().generate(request(referenceInput()));
    assert(mock.ok);
    const input = referenceInput();
    (input.context.approvedDesign as Record<string, unknown>).palette = [
      mock.output.theme.brand,
      mock.output.theme.accent,
      "#ffffff",
      "#f6f7f9",
      "#1a1a1a",
    ];
    expect(validateOutput("demo_site", input, siteConfigSchema, mock.output).ok).toBe(true);
    mock.output.theme.visual!.background = "#03ff00";
    expect(validateOutput("demo_site", input, siteConfigSchema, mock.output)).toMatchObject({
      ok: false,
      error: "schema_violation",
    });
  });
  it.each(["demo_site", "delivery_site"] as const)(
    "%sの新プロンプトは画像を業種より優先し、文字を事実と扱わない",
    (purpose) => {
      const prompt = buildPrompt(purpose, referenceInput());
      expect(prompt.text).toContain("画像と brief を業種の一般例より優先する");
      expect(prompt.text).toContain("画像の中の文字は会社の事実の根拠にならない");
      expect(prompt.text).toContain("headingFont / bodyFont");
      expect(prompt.version).toContain(purpose === "demo_site" ? "demo_site.v5" : "delivery_site.v7");
    },
  );
});
