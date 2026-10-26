import { expect, it } from "vitest";
import { generationWorkReadiness } from "./generation-work-readiness.ts";

const runtime = (n: number) => ({ kind: "稼働通知（停止後45秒まで残ります）", n });

it("稼働中だけなら未完了業務は0件と示し、切替前の停止確認は通さない", () => {
  const rows = [{ kind: "企業収集", n: 0 }, { kind: "制作キュー", n: 0 }, runtime(1)];
  const original = JSON.stringify(rows);
  const [work, switching] = generationWorkReadiness(rows);
  expect(work?.ok).toBe(true);
  expect(work?.message).toContain("未完了の受付・制作・キュー・工程は0件");
  expect(switching?.ok).toBe(false);
  expect(switching?.message).toContain("方式を切り替える直前");
  expect(switching?.message).toContain("45秒以上");
  expect(JSON.stringify(rows)).toBe(original);
});

it("業務と通知の双方を残し、未完了の業務への対応を先に案内する", () => {
  const checks = generationWorkReadiness([{ kind: "将来の新しい業務", n: 2 }, runtime(1)]);
  expect(checks.map((row) => row.ok)).toEqual([false, false]);
  expect(checks[0]!.message).toContain("将来の新しい業務 2件");
  expect(checks[1]!.message).toContain("未完了業務への対応後");
});

it("通知0件からプロセス停止を推測しない", () => {
  const checks = generationWorkReadiness([{ kind: "制作キュー", n: 0 }, runtime(0)]);
  expect(checks.every((row) => row.ok)).toBe(true);
  expect(checks[1]!.message).toContain("プロセスの停止自体を証明するものではない");
});

it("欠落・重複・不正な件数を正常扱いせず、値をエラーへ転記しない", () => {
  for (const rows of [
    [],
    [runtime(0)],
    [{ kind: "企業収集", n: 0 }],
    [runtime(0), runtime(0), { kind: "企業収集", n: 0 }],
    [{ kind: "private", n: NaN }, runtime(0)],
    [{ kind: "private", n: -1 }, runtime(0)],
    [{ kind: "private", n: Number.MAX_SAFE_INTEGER + 1 }, runtime(0)],
  ]) {
    expect(() => generationWorkReadiness(rows)).toThrow("件数を確認できません");
    try {
      generationWorkReadiness(rows);
    } catch (error) {
      expect(String(error)).not.toContain("private");
    }
  }
});
