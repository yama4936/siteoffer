import { expect, it } from "vitest";
import { draftFingerprint } from "./draft-fingerprint";

it("JSONBのキー順が変わっても同じ入力を同一とし、写真の説明と順序の変更を保存対象にする", () => {
  const first = {
    title: "記事",
    images: [
      { assetId: "one", alt: "外観", caption: "撮影者" },
      { assetId: "two", alt: "店内", caption: "" },
    ],
  };
  const dbOrder = {
    images: [
      { caption: "撮影者", alt: "外観", assetId: "one" },
      { caption: "", assetId: "two", alt: "店内" },
    ],
    title: "記事",
  };
  expect(draftFingerprint(dbOrder)).toBe(draftFingerprint(first));
  expect(draftFingerprint({ ...first, images: [{ ...first.images[0], caption: "変更後" }, first.images[1]] })).not.toBe(
    draftFingerprint(first),
  );
  expect(draftFingerprint({ ...first, images: [...first.images].reverse() })).not.toBe(draftFingerprint(first));
  expect(draftFingerprint({ ...first, images: [] })).not.toBe(draftFingerprint(first));
});
it("既存の文字列と真偽値だけのコピーの比較を維持する", () => {
  const fields = { note: "入力中", approved: false };
  expect(draftFingerprint(fields)).toBe(JSON.stringify(fields, Object.keys(fields).sort()));
  expect(draftFingerprint({ ...fields, approved: true })).not.toBe(draftFingerprint(fields));
});
