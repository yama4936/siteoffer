import { describe, expect, it } from "vitest";
import { rebasePath } from "./rebase-paths.ts";

describe("rebasePath", () => {
  const from = "/home/u/projects/siteoffer";
  const to = "/home/u/siteoffer-demo";

  it("複製元の下の値を同じ相対位置へ付け替える", () => {
    expect(rebasePath(`${from}/.data/demo/artifacts/demos/a`, from, to)).toBe(`${to}/.data/demo/artifacts/demos/a`);
    expect(rebasePath(`${from}/reports/sites/x`, from, to)).toBe(`${to}/reports/sites/x`);
  });

  it("複製元の外・名前が前方一致するだけの場所・ルートそのものは変えない", () => {
    expect(rebasePath("/srv/other/a", from, to)).toBeNull();
    expect(rebasePath(`${from}-old/reports/x`, from, to)).toBeNull();
    expect(rebasePath(from, from, to)).toBeNull();
    expect(rebasePath(`${from}/../escape`, from, to)).toBeNull();
  });

  it("付け替え済みの値は変えない（再実行しても増えない）", () => {
    expect(rebasePath(`${to}/reports/sites/x`, from, to)).toBeNull();
  });
});
