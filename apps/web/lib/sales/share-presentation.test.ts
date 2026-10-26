import { describe, expect, it } from "vitest";
import { proposalShareMessage, shareState, shareTtlOptions } from "./share-presentation.ts";

describe("提案リンクの表示", () => {
  it("運営設定を超える選択肢と同じ期間の重複を出さない", () => {
    expect(shareTtlOptions(12)).toEqual([{ value: "", label: "既定：12時間" }]);
    expect(shareTtlOptions(24)).toEqual([{ value: "", label: "既定：1日" }]);
    expect(shareTtlOptions(72).map((o) => o.value)).toEqual(["", "24"]);
    expect(shareTtlOptions(336).map((o) => o.value)).toEqual(["", "24", "72", "168"]);
    for (const invalid of [0, -1, NaN, Infinity]) expect(shareTtlOptions(invalid)).toEqual([]);
  });
  it("期限ちょうどで失効し、取り消しを優先する。不正な期限を有効扱いしない", () => {
    const link = { expiresAt: "2026-10-17T00:00:00Z", revokedAt: null };
    expect(shareState(link, Date.parse(link.expiresAt) - 1)).toBe("active");
    expect(shareState(link, Date.parse(link.expiresAt))).toBe("expired");
    expect(shareState({ ...link, revokedAt: link.expiresAt }, 0)).toBe("revoked");
    expect(shareState({ ...link, expiresAt: "bad" }, 0)).toBe("expired");
  });
  it("案内文は日本時間の期限と非公式提案の説明を含み、送信済みとは扱わない", () => {
    const message = proposalShareMessage("https://example.test/s/sample/", "2026-10-17T00:00:00Z");
    expect(message).toContain("https://example.test/s/sample/");
    expect(message).toContain("2026/10/17 09:00（日本時間）");
    expect(message).toContain("非公式の改善提案");
  });
});
