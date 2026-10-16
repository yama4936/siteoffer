import sharp from "sharp";
import { expect, it } from "vitest";
import { normalizeAssetImage } from "../src/images.ts";

it("JPEGの向きを補正し、EXIFを除去して小さなロゴもPNGにできる", async () => {
  const source = await sharp({ create: { width: 24, height: 16, channels: 3, background: "#2255aa" } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const result = await normalizeAssetImage(source);
  expect(result.width).toBe(16);
  expect(result.height).toBe(24);
  const meta = await sharp(result.png).metadata();
  expect(meta.format).toBe("png");
  expect(meta.exif).toBeUndefined();
  expect(meta.orientation).toBeUndefined();
});
it("SVG・壊れたファイル・入力上限超過を拒否し、大きな静止画を縮小する", async () => {
  await expect(normalizeAssetImage(Buffer.from('<svg width="10" height="10"></svg>'))).rejects.toThrow();
  await expect(normalizeAssetImage(Buffer.from("broken"))).rejects.toThrow();
  await expect(normalizeAssetImage(Buffer.alloc(12 * 1024 * 1024 + 1))).rejects.toThrow("12MB");
  const bytes = await sharp({ create: { width: 3000, height: 1000, channels: 4, background: "#2255aa" } })
    .webp()
    .toBuffer();
  const result = await normalizeAssetImage(bytes);
  expect(result.width).toBe(2560);
  expect(result.height).toBe(853);
});
