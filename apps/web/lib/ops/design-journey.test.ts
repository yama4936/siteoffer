import { describe, expect, it } from "vitest";
import { type DesignJourneyInput, designJourney } from "./design-journey";

const base: DesignJourneyInput = { companyId: "company-one", canCreate: true, configured: false };
const design = { id: "design-one", status: "approved" as const, imageSha256: "image", buildRequestedAt: null };
describe("design journey", () => {
  it("routes an unqualified new design to diagnosis while allowing an existing approved version to continue", () => {
    expect(designJourney({ ...base, canCreate: false }).href).toBe("/ops/companies/company-one");
    expect(designJourney({ ...base, canCreate: false, design }).href).toBe("#design-build");
  });
  it("explains the available image input instead of sending an unconfigured user to generation", () => {
    expect(designJourney(base).description).toContain("取り込む版を作成");
    expect(designJourney({ ...base, configured: true }).description).toContain("画像を生成");
  });
  it.each(["queued", "generating"] as const)(
    "keeps %s at the image step and points to processing history",
    (status) => {
      expect(designJourney({ ...base, design: { ...design, status } })).toMatchObject({
        step: 1,
        waiting: true,
        href: "/ops/companies/company-one",
      });
    },
  );
  it.each(["failed", "rejected"] as const)("does not treat an image in %s as approved", (status) => {
    expect(designJourney({ ...base, design: { ...design, status } })).toMatchObject({
      step: 1,
      waiting: false,
      href: "#design-brief",
    });
  });
  it("separates upload, image review, and site build", () => {
    for (const [status, step, href] of [
      ["draft", 1, "#design-upload"],
      ["in_review", 2, "#design-review"],
      ["approved", 3, "#design-build"],
    ] as const)
      expect(designJourney({ ...base, design: { ...design, status } })).toMatchObject({ step, href, waiting: false });
  });
  it("a build request without a proposal is waiting, never completed", () => {
    expect(designJourney({ ...base, design: { ...design, buildRequestedAt: new Date() } })).toMatchObject({
      step: 3,
      waiting: true,
    });
  });
  it.each(["generating", "in_review", "failed", "rejected", "approved"] as const)(
    "uses the exact selected proposal in %s",
    (status) => {
      const result = designJourney({ ...base, design, proposal: { id: "proposal-exact", version: 2, status } });
      expect(result.step).toBe(["in_review", "approved"].includes(status) ? 4 : 3);
      expect(result.waiting).toBe(status === "generating");
      if (status !== "generating")
        expect(new URL(result.href, "http://localhost").searchParams.get("version")).toBe("proposal-exact");
      if (status === "approved") expect(result.description).toContain("販売条件");
    },
  );
});
