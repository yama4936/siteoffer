import { err, ok, type Result } from "@siteoffer/core";
import { isThirdPartyDomain } from "../judge.ts";
import type { SiteCandidate } from "../schemas.ts";
import { normalizeUrl } from "../url.ts";
import type { ProviderContext, SearchProvider, SearchProviderError, SiteQuery } from "./types.ts";

const ENDPOINT = "https://api.tavily.com/search",
  MAX_BYTES = 1_048_576;
type FetchSearch = (url: string, init: RequestInit) => Promise<Response>;
/** Optional real provider. One basic query per company; no inferred identity evidence. */
export class TavilySearchProvider implements SearchProvider {
  readonly name = "tavily";
  #key: string;
  #fetch: FetchSearch;
  #timeout: number;
  constructor(options: { apiKey?: string; fetch?: FetchSearch; timeoutMs?: number } = {}) {
    this.#key = (options.apiKey ?? process.env.TAVILY_API_KEY ?? "").trim();
    this.#fetch = options.fetch ?? fetch;
    this.#timeout = options.timeoutMs ?? 15000;
    if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 30000)
      throw new Error("検索の制限時間が不正です");
  }
  async findOfficialSite(
    company: SiteQuery,
    ctx: ProviderContext,
  ): Promise<Result<SiteCandidate[], SearchProviderError>> {
    if (ctx.signal?.aborted) return err("search_failed", "検索が中断されました");
    if (!this.#key || /[\r\n]/.test(this.#key)) return err("search_unavailable", "検索APIの認証が設定されていません");
    if (typeof company.name !== "string" || !company.name.trim() || company.name.length > 300)
      return err("search_failed", "検索する企業名を確認してください");
    const query = [company.name, company.prefecture, company.city, company.corporateNumber, "公式サイト"]
      .filter((value) => typeof value === "string" && value.trim())
      .join(" ")
      .slice(0, 500);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let abort: () => void = () => {};
    const stopped = new Promise<never>((_, reject) => {
      abort = () => {
        controller.abort();
        void reader?.cancel().catch(() => {});
        reject(Error("deadline"));
      };
      timer = setTimeout(abort, this.#timeout);
      ctx.signal?.addEventListener("abort", abort, { once: true });
    });
    try {
      const response = await Promise.race([
        this.#fetch(ENDPOINT, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.#key}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            query,
            topic: "general",
            search_depth: "basic",
            max_results: 5,
            auto_parameters: false,
            include_answer: false,
            include_raw_content: false,
            include_images: false,
            include_favicon: false,
            chunks_per_source: 1,
          }),
        }).then((response) => {
          if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
          return response;
        }),
        stopped,
      ]);
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        return response.status === 429 || response.status === 432 || response.status === 433
          ? err("search_rate_limited", "検索APIの利用上限または混雑です。設定と使用量を確認してください")
          : response.status === 401 || response.status === 403
            ? err("search_unavailable", "検索APIの認証または利用権限を確認してください")
            : err("search_failed", "検索APIの応答を確認できません");
      }
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (
        declared > MAX_BYTES ||
        !response.headers.get("content-type")?.toLowerCase().includes("application/json") ||
        !response.body
      ) {
        void response.body?.cancel().catch(() => {});
        return err("search_failed", "検索APIの応答形式または容量を確認してください");
      }
      reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const item = await Promise.race([reader.read(), stopped]);
        if (item.done) break;
        size += item.value.byteLength;
        if (size > MAX_BYTES) {
          void reader.cancel().catch(() => {});
          return err("search_failed", "検索APIの応答が容量の上限を超えました");
        }
        parts.push(item.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results))
        return err("search_failed", "検索APIの結果を読み取れません");
      const candidates: SiteCandidate[] = [],
        seen = new Set<string>();
      for (const raw of (data as { results: unknown[] }).results.slice(0, 20)) {
        if (!raw || typeof raw !== "object") continue;
        const row = raw as { url?: unknown; title?: unknown };
        if (typeof row.url !== "string" || row.url.length > 2048 || !/^https?:\/\//i.test(row.url)) continue;
        let normalized: ReturnType<typeof normalizeUrl>;
        try {
          const url = new URL(row.url),
            decoded = decodeURIComponent(row.url);
          if (
            url.hash ||
            url.username ||
            url.password ||
            (url.port && !["80", "443"].includes(url.port)) ||
            Array.from(decoded).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
            decoded.includes(this.#key) ||
            /(?:sk-(?:proj-)?[a-z0-9_-]{20,}|ghp_[a-z0-9]{30,})/i.test(decoded) ||
            [...url.searchParams.keys()].some((key) =>
              /^(?:token|access_?token|refresh_?token|id_token|password|secret|api_?key|auth|authorization|session|sessionid|sid|signature|sig|key)$/i.test(
                key,
              ),
            )
          )
            continue;
          normalized = normalizeUrl(row.url);
        } catch {
          continue;
        }
        if (!normalized.ok || seen.has(normalized.value.normalizedUrl)) continue;
        seen.add(normalized.value.normalizedUrl);
        candidates.push({
          provider: this.name,
          externalId: normalized.value.normalizedUrl,
          url: row.url,
          title: typeof row.title === "string" && !row.title.includes(this.#key) ? row.title.slice(0, 300) : null,
          sourceUrl: ENDPOINT,
          fetchedAt: ctx.clock.now(),
          thirdParty: isThirdPartyDomain(normalized.value.domain),
          evidence: { companyName: null, address: null, corporateNumber: null },
        });
        if (candidates.length === 5) break;
      }
      return ok(candidates);
    } catch {
      return err("search_failed", "検索APIの接続・応答を確認できません。時間をおいて再試行してください");
    } finally {
      if (timer) clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", abort);
      try {
        reader?.releaseLock();
      } catch {}
    }
  }
}
