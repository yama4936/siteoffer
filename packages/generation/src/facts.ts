import { foldNumericWidth, numericClaims } from "./numeric-claims.ts";
import { type GenerationInput, type GenerationPurpose, markerRegex, NEEDS_REVIEW_MARKERS } from "./schemas.ts";
import { checkSiteFacts } from "./site-facts.ts";

/**
 * 生成物の事実検査（10.2）。
 * 要確認マーカー（`{{要確認:説明}}`。表記はテンプレートの lib/markers.ts に統一）・仮置きの語の残存、未確認の値の流用、入力に根拠のない数値の主張・実績系の語を検出する。
 * 機械的な検査であり、すべての無根拠な主張を見つけられるわけではない（公開前の人の確認は別に必要）。
 */
export interface FactViolation {
  kind:
    | "marker"
    | "needs_review_value"
    | "unsupported_claim"
    | "unknown_fact_ref"
    | "unconfirmed_fact_ref"
    | "identity_mismatch"
    | "fact_value_mismatch";
  /** 出力JSON内の位置（例：measures.0.current） */
  path: string;
  detail: string;
}

/** 用途ごとの検査の強さ */
const CLAIM_CHECK: Record<GenerationPurpose, { numericClaims: boolean; claimWords: boolean }> = {
  // 評価書は既存サイトの観測を引用するため、数値・語の検査は外部データとの照合で足りる
  evaluation: { numericClaims: false, claimWords: false },
  proposal_text: { numericClaims: true, claimWords: false },
  call_script: { numericClaims: true, claimWords: false },
  faq: { numericClaims: true, claimWords: false },
  demo_site: { numericClaims: true, claimWords: true },
  delivery_site: { numericClaims: true, claimWords: true },
};

/** サイト掲載物で、確認済み事実に同じ語がない限り使ってはいけない語 */
const CLAIM_WORDS = [
  "受賞",
  "認定",
  "資格",
  "免許",
  "許可",
  "お客様の声",
  "顧客の声",
  "口コミ",
  "実績",
  "保証",
  "特許",
  "表彰",
];

/** 照合用の正規化：全角英数字→半角、空白・桁区切りを除く */
export function normalizeForMatch(s: string): string {
  return foldNumericWidth(s)
    .replace(/[\s,，、]/g, "")
    .toLowerCase();
}

function* walkStrings(value: unknown, path: string[] = []): Generator<{ path: string; text: string }> {
  if (typeof value === "string") {
    yield { path: path.join("."), text: value };
  } else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* walkStrings(v, [...path, String(i)]);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) yield* walkStrings(v, [...path, k]);
  }
}

function* walkFactRefs(value: unknown, path: string[] = []): Generator<{ path: string; key: string }> {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* walkFactRefs(v, [...path, String(i)]);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "factRef" && typeof v === "string") yield { path: [...path, k].join("."), key: v };
      else if (k === "factRefs" && Array.isArray(v)) {
        for (const [i, r] of v.entries())
          if (typeof r === "string") yield { path: [...path, k, String(i)].join("."), key: r };
      } else yield* walkFactRefs(v, [...path, k]);
    }
  }
}

export function checkFacts(purpose: GenerationPurpose, input: GenerationInput, output: unknown): FactViolation[] {
  const violations: FactViolation[] = [];
  const policy = CLAIM_CHECK[purpose];

  const confirmed = input.facts.filter((f) => f.status === "confirmed");
  const needsReview = input.facts.filter((f) => f.status === "needs_review");
  const confirmedText = normalizeForMatch(confirmed.map((f) => f.value).join("\n"));
  // 数値の根拠には確認済み事実と外部データ（既存サイトの観測）を使う
  const supportClaims = new Set(
    [...confirmed.map((f) => f.value), ...input.externalData.map((d) => d.content), JSON.stringify(input.context)]
      .flatMap(numericClaims)
      .map(normalizeForMatch),
  );

  for (const { path, text } of walkStrings(output)) {
    const norm = normalizeForMatch(text);

    // 要確認マーカー（テンプレートと同じ表記 `{{要確認:説明}}`）。生成物には入れさせない
    for (const m of text.matchAll(markerRegex())) {
      violations.push({ kind: "marker", path, detail: `要確認マーカー「${m[0]}」が残っている` });
    }
    // マーカーの形になっていない仮置きの語（マーカーとして数えた部分は除く）
    const loose = normalizeForMatch(text.replace(markerRegex(), ""));
    for (const m of NEEDS_REVIEW_MARKERS) {
      if (loose.includes(normalizeForMatch(m))) {
        violations.push({ kind: "marker", path, detail: `「${m}」が残っている` });
      }
    }

    for (const f of needsReview) {
      const v = normalizeForMatch(f.value);
      // 1文字の値は誤検出が多いため対象外
      if (v.length >= 2 && norm.includes(v)) {
        violations.push({ kind: "needs_review_value", path, detail: `未確認の事実「${f.label}」の値が使われている` });
      }
    }

    if (policy.numericClaims) {
      for (const claim of numericClaims(text)) {
        if (!supportClaims.has(normalizeForMatch(claim))) {
          violations.push({ kind: "unsupported_claim", path, detail: `入力に根拠のない数値表現「${claim}」` });
        }
      }
    }

    if (policy.claimWords) {
      for (const w of CLAIM_WORDS) {
        if (text.includes(w) && !confirmedText.includes(normalizeForMatch(w))) {
          violations.push({ kind: "unsupported_claim", path, detail: `確認済み事実にない「${w}」の記述` });
        }
      }
    }
  }

  const byKey = new Map(input.facts.map((f) => [f.key, f]));
  for (const { path, key } of walkFactRefs(output)) {
    const f = byKey.get(key);
    if (!f) violations.push({ kind: "unknown_fact_ref", path, detail: `入力にない事実キー「${key}」` });
    else if (f.status !== "confirmed")
      violations.push({ kind: "unconfirmed_fact_ref", path, detail: `未確認の事実「${f.label}」を参照している` });
  }

  if (purpose === "demo_site" || purpose === "delivery_site") violations.push(...checkSiteFacts(input, output));
  return violations;
}
