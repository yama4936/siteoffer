import { err, ok, type Result } from "@siteoffer/core";
import {
  type CompanyCandidate,
  companyCandidateSchema,
  type DiscoveryCriteria,
  discoveryCriteriaSchema,
} from "../schemas.ts";
import type { DiscoveryProvider, DiscoveryProviderError, ProviderContext } from "./types.ts";

/**
 * 国税庁法人番号システムWeb-APIのクライアント（24.6）。
 *
 * 仕様の出典：「Web-APIのリクエストの設定方法及び提供データの内容について（概要編）1.2版」
 * （https://www.houjin-bangou.nta.go.jp/webapi/ からリンクされるPDF）と、同PDF内の別紙１リソース定義書・別紙２エラー一覧。
 * - 取得期間指定：GET https://api.houjin-bangou.nta.go.jp/{ver}/diff?id=&from=&to=&type=&address=&kind=&divide=
 *   取得期間は最大50日。所在地（address）は都道府県コード2桁、または都道府県＋市区町村コード5桁。
 * - 法人名指定：GET https://api.houjin-bangou.nta.go.jp/{ver}/name?id=&name=&type=&mode=&target=&address=&kind=&change=&close=&divide=
 * - 応答は type=12 で XML（UTF-8）。<corporations> の下にヘッダー4項目と <corporation> の繰り返し。
 *   2,000件を超えると分割され、divideSize まで divide を進めて取得する。
 * - エラーは HTTP ステータス（400/403/404/500）と、400のときCSV形式のエラーコード・メッセージ。
 *
 * 法人番号APIは「所在地だけ」で検索する機能を持たない。所在地での収集は取得期間指定（更新があった法人）で行い、
 * キーワードがある場合は法人名指定（部分一致）に所在地を組み合わせる。業種・公式サイトURLは含まれない。
 *
 * アプリケーションIDは環境変数 NTA_APPLICATION_ID から読む。保存する出典URLにはIDを含めない。
 */

export const NTA_API_BASE = "https://api.houjin-bangou.nta.go.jp";
export const NTA_API_VERSION = "4";

/** 都道府県コード（JIS X 0401） */
export const PREFECTURE_CODES: Record<string, string> = {
  北海道: "01",
  青森県: "02",
  岩手県: "03",
  宮城県: "04",
  秋田県: "05",
  山形県: "06",
  福島県: "07",
  茨城県: "08",
  栃木県: "09",
  群馬県: "10",
  埼玉県: "11",
  千葉県: "12",
  東京都: "13",
  神奈川県: "14",
  新潟県: "15",
  富山県: "16",
  石川県: "17",
  福井県: "18",
  山梨県: "19",
  長野県: "20",
  岐阜県: "21",
  静岡県: "22",
  愛知県: "23",
  三重県: "24",
  滋賀県: "25",
  京都府: "26",
  大阪府: "27",
  兵庫県: "28",
  奈良県: "29",
  和歌山県: "30",
  鳥取県: "31",
  島根県: "32",
  岡山県: "33",
  広島県: "34",
  山口県: "35",
  徳島県: "36",
  香川県: "37",
  愛媛県: "38",
  高知県: "39",
  福岡県: "40",
  佐賀県: "41",
  長崎県: "42",
  熊本県: "43",
  大分県: "44",
  宮崎県: "45",
  鹿児島県: "46",
  沖縄県: "47",
};

export type FetchLike = (
  url: string,
  init?: { signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface NtaOptions {
  /** 既定は process.env。テストで差し替える */
  env?: Record<string, string | undefined>;
  requestTimeoutMs?: number;
  /** 既定は globalThis.fetch。テストでは記録済み応答を返す関数を渡す */
  fetch?: FetchLike;
  /** 取得期間指定のときに遡る日数（最大50。仕様の上限） */
  diffWindowDays?: number;
  /** 法人種別。既定は 03（設立登記法人） */
  kinds?: string[];
  /** 分割された応答を最大何ファイルまで取りに行くか */
  maxDivides?: number;
}

/** <corporation> の1件（必要な項目だけ） */
export interface NtaCorporation {
  sequenceNumber: string;
  corporateNumber: string;
  process: string;
  updateDate: string;
  name: string;
  kind: string;
  prefectureName: string;
  cityName: string;
  streetNumber: string;
  prefectureCode: string;
  cityCode: string;
  postCode: string;
  closeDate: string;
  latest: string;
  furigana: string;
  hihyoji: string;
}

export interface NtaResponse {
  lastUpdateDate: string;
  count: number;
  divideNumber: number;
  divideSize: number;
  corporations: NtaCorporation[];
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>|<${name}\\s*/>`));
  return m?.[1] !== undefined ? decodeXml(m[1].trim()) : "";
}

/** 応答XML（type=12）を解析する。要素は平坦なので、要素名で取り出す */
export function parseNtaXml(xml: string): Result<NtaResponse, "nta_unexpected_response"> {
  if (!/<corporations>/.test(xml)) return err("nta_unexpected_response", "<corporations> がない応答");
  const head = xml.split(/<corporation>/)[0] ?? "";
  const corporations = [...xml.matchAll(/<corporation>([\s\S]*?)<\/corporation>/g)].map((m) => {
    const b = m[1] ?? "";
    return {
      sequenceNumber: tag(b, "sequenceNumber"),
      corporateNumber: tag(b, "corporateNumber"),
      process: tag(b, "process"),
      updateDate: tag(b, "updateDate"),
      name: tag(b, "name"),
      kind: tag(b, "kind"),
      prefectureName: tag(b, "prefectureName"),
      cityName: tag(b, "cityName"),
      streetNumber: tag(b, "streetNumber"),
      prefectureCode: tag(b, "prefectureCode"),
      cityCode: tag(b, "cityCode"),
      postCode: tag(b, "postCode"),
      closeDate: tag(b, "closeDate"),
      latest: tag(b, "latest"),
      furigana: tag(b, "furigana"),
      hihyoji: tag(b, "hihyoji"),
    } satisfies NtaCorporation;
  });
  const num = (s: string, d: number) => (s === "" || Number.isNaN(Number(s)) ? d : Number(s));
  return ok({
    lastUpdateDate: tag(head, "lastUpdateDate"),
    count: num(tag(head, "count"), corporations.length),
    divideNumber: num(tag(head, "divideNumber"), 1),
    divideSize: num(tag(head, "divideSize"), 1),
    corporations,
  });
}

function ymd(d: Date): string {
  // 法人番号の日付は日本時間の暦日
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

export class NtaCorporateNumberProvider implements DiscoveryProvider {
  readonly name = "nta-corporate-number";
  private readonly env: Record<string, string | undefined>;
  private readonly fetchFn: FetchLike | undefined;
  private readonly diffWindowDays: number;
  private readonly kinds: string[];
  private readonly maxDivides: number;
  private readonly requestTimeoutMs: number;

  constructor(options: NtaOptions = {}) {
    this.env = options.env ?? process.env;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.fetchFn = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    this.diffWindowDays = Math.min(Math.max(options.diffWindowDays ?? 30, 1), 50);
    this.kinds = options.kinds ?? ["03"];
    this.maxDivides = options.maxDivides ?? 5;
  }

  /** リクエストURLの組み立て（IDを含む。ログや保存には publicUrl を使う） */
  buildRequests(criteria: DiscoveryCriteria, now: Date): Result<URLSearchParams[], DiscoveryProviderError> {
    let address: string | undefined;
    if (criteria.cityCode) {
      address = criteria.cityCode;
    } else if (criteria.prefecture) {
      address = PREFECTURE_CODES[criteria.prefecture];
      if (!address)
        return err("nta_unknown_prefecture", `都道府県名を都道府県コードに変換できない：${criteria.prefecture}`);
    }
    const common: [string, string][] = [["type", "12"]];
    if (address) common.push(["address", address]);
    if (this.kinds.length) common.push(["kind", this.kinds.join(",")]);

    if (criteria.keywords.length > 0) {
      return ok(
        criteria.keywords.map(
          (k) =>
            new URLSearchParams([
              ["endpoint", "name"],
              ["name", k],
              ...common,
              ["mode", "2"], // 部分一致
              ["target", "1"], // JIS第一・第二水準（あいまい検索）
              ["change", "0"],
              ["close", "0"], // 登記記録の閉鎖等を含めない
            ]),
        ),
      );
    }
    if (!address) {
      return err("nta_prefecture_required", "キーワードなしの収集（取得期間指定）には都道府県の指定が必要");
    }
    const to = ymd(now);
    const from = ymd(new Date(now.getTime() - (this.diffWindowDays - 1) * 24 * 60 * 60 * 1000));
    return ok([new URLSearchParams([["endpoint", "diff"], ["from", from], ["to", to], ...common])]);
  }

  private urlFor(params: URLSearchParams, divide: number, withId: string | null): string {
    const p = new URLSearchParams(params);
    const endpoint = p.get("endpoint");
    p.delete("endpoint");
    if (divide > 1) p.set("divide", String(divide));
    const qs = withId ? `id=${encodeURIComponent(withId)}&${p.toString()}` : p.toString();
    return `${NTA_API_BASE}/${NTA_API_VERSION}/${endpoint}?${qs}`;
  }

  async discover(input: unknown, ctx: ProviderContext): Promise<Result<CompanyCandidate[], DiscoveryProviderError>> {
    const parsed = discoveryCriteriaSchema.safeParse(input);
    if (!parsed.success) return err("invalid_criteria", parsed.error.message);
    const criteria = parsed.data;

    const appId = this.env.NTA_APPLICATION_ID?.trim();
    if (!appId) {
      return err(
        "nta_application_id_missing",
        "環境変数 NTA_APPLICATION_ID が未設定。国税庁法人番号システムWeb-APIのアプリケーションIDの発行が必要",
      );
    }
    if (!this.fetchFn) return err("network_error", "fetch が使えない環境");

    const requests = this.buildRequests(criteria, ctx.clock.now());
    if (!requests.ok) return requests;

    const byNumber = new Map<string, CompanyCandidate>();
    for (const params of requests.value) {
      for (let divide = 1; divide <= this.maxDivides; divide++) {
        const res = await this.fetchOne(this.urlFor(params, divide, appId));
        if (!res.ok) return res;
        const fetchedAt = ctx.clock.now();
        const sourceUrl = this.urlFor(params, divide, null);
        for (const c of res.value.corporations) {
          if (byNumber.size >= criteria.limit) break;
          const cand = this.toCandidate(c, criteria, sourceUrl, fetchedAt);
          if (cand && !byNumber.has(cand.corporateNumber!)) byNumber.set(cand.corporateNumber!, cand);
        }
        if (byNumber.size >= criteria.limit || divide >= res.value.divideSize) break;
      }
      if (byNumber.size >= criteria.limit) break;
    }
    return ok([...byNumber.values()]);
  }

  /** アプリケーションIDが設定されているか（未設定なら番号照会はできない） */
  hasApplicationId(): boolean {
    return !!this.env.NTA_APPLICATION_ID?.trim();
  }

  /**
   * 法人番号指定（GET /{ver}/num?id=&number=&type=12&history=0）で最新の1件を照会する。
   * 該当がなければ corporation は null。sourceUrl はIDを含まない出典URL。
   */
  async lookupNumber(
    corporateNumber: string,
  ): Promise<Result<{ corporation: NtaCorporation | null; sourceUrl: string }, DiscoveryProviderError>> {
    const appId = this.env.NTA_APPLICATION_ID?.trim();
    if (!appId) return err("nta_application_id_missing", "環境変数 NTA_APPLICATION_ID が未設定");
    if (!this.fetchFn) return err("network_error", "fetch が使えない環境");
    if (!/^\d{13}$/.test(corporateNumber)) return err("nta_bad_request", "法人番号は13桁の数字");
    const params = new URLSearchParams([
      ["endpoint", "num"],
      ["number", corporateNumber],
      ["type", "12"],
      ["history", "0"],
    ]);
    const res = await this.fetchOne(this.urlFor(params, 1, appId));
    if (!res.ok) return res;
    const corporation = res.value.corporations.find((c) => c.corporateNumber === corporateNumber) ?? null;
    return ok({ corporation, sourceUrl: this.urlFor(params, 1, null) });
  }

  private async fetchOne(url: string): Promise<Result<NtaResponse, DiscoveryProviderError>> {
    let status: number;
    let body: string;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        (async () => {
          const res = await this.fetchFn!(url, { signal: controller.signal });
          return { status: res.status, body: await res.text() };
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("timeout"));
          }, this.requestTimeoutMs);
        }),
      ]);
      status = result.status;
      body = result.body;
    } catch {
      return err(
        "network_error",
        "国税庁APIへの接続に失敗、または制限時間を超過しました。通信環境を確認して再試行してください",
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (status === 200) return parseNtaXml(body);
    if (status === 400) {
      // エラーコード・メッセージがCSVで返る（列の並びは仕様書で例示されていないため、そのまま要約して残す）
      return err(
        "nta_bad_request",
        "国税庁APIがリクエストを拒否しました（400）。所在地・法人名の条件を確認してください",
      );
    }
    if (status === 403) return err("nta_rate_limited", "国税庁APIのアクセス制限（403）。間隔を空けて再試行する");
    if (status === 404) return err("nta_invalid_application_id", "アプリケーションIDが未登録または無効（404）");
    if (status >= 500) return err("nta_server_error", `国税庁APIの障害（${status}）`);
    return err("nta_unexpected_response", `想定外のHTTPステータス：${status}`);
  }

  private toCandidate(
    c: NtaCorporation,
    criteria: DiscoveryCriteria,
    sourceUrl: string,
    fetchedAt: Date,
  ): CompanyCandidate | null {
    if (!/^\d{13}$/.test(c.corporateNumber)) return null;
    if (c.latest !== "" && c.latest !== "1") return null; // 過去の履歴
    if (c.hihyoji === "1") return null; // 検索対象除外
    if (c.closeDate !== "") return null; // 登記記録の閉鎖等
    // 所在地コードで絞れなかった市区町村は、出典の市区町村名で絞る
    if (criteria.city && !criteria.cityCode && !c.cityName.startsWith(criteria.city)) return null;
    return companyCandidateSchema.parse({
      provider: this.name,
      externalId: c.corporateNumber,
      sourceUrl,
      fetchedAt,
      name: c.name,
      corporateNumber: c.corporateNumber,
      prefecture: c.prefectureName || null,
      city: c.cityName || null,
      address: c.streetNumber || null,
      addressSourceUrl: c.prefectureName ? sourceUrl : null,
      industry: null,
      representativePhone: null,
      raw: c,
    });
  }
}
