import { fixedClock } from "@siteoffer/core";
import { expect, it, vi } from "vitest";
import { TavilySearchProvider } from "../src/providers/tavily.ts";

const clock = fixedClock("2026-10-18T10:00:00Z"),
  key = "test-only-private-key";
const company = {
  name: "架空工務店",
  prefecture: "愛知県",
  city: "名古屋市",
  address: null,
  corporateNumber: "1234567890123",
};
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
it("uses one bounded basic request, keeps credentials out of serializable state and does not infer identity from search text", async () => {
  const transport = vi.fn(async () =>
    json({
      answer: key,
      results: [
        {
          url: "https://www.example.test/?utm_source=x",
          title: "架空工務店",
          content: "1234567890123 愛知県名古屋市",
          score: 1,
          raw_content: key,
        },
      ],
    }),
  );
  const provider = new TavilySearchProvider({ apiKey: key, fetch: transport });
  const r = await provider.findOfficialSite(company, { clock });
  expect(transport).toHaveBeenCalledTimes(1);
  const [endpoint, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
  expect(endpoint).toBe("https://api.tavily.com/search");
  expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: `Bearer ${key}` } });
  expect(JSON.parse(init.body as string)).toMatchObject({
    search_depth: "basic",
    auto_parameters: false,
    max_results: 5,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
  });
  expect(r).toMatchObject({
    ok: true,
    value: [
      {
        provider: "tavily",
        evidence: { companyName: null, address: null, corporateNumber: null },
        sourceUrl: endpoint,
        fetchedAt: clock.now(),
      },
    ],
  });
  expect(JSON.stringify([provider, r])).not.toContain(key);
});
it("filters unsafe URLs, deduplicates normalized URLs, labels third parties and caps retained results", async () => {
  const urls = [
    "http://localhost/",
    "http://127.0.0.1/",
    "https://user:pass@example.test/",
    "https://example.test:444/",
    "https://example.test/?id_token=private",
    "https://example.test/%0a",
    "https://example.test/#secret",
    "https://example.test/%ZZ",
    `https://example.test/${key}`,
    "ftp://example.test/",
    "https://example.test/",
    "http://www.example.test/?utm_source=duplicate",
    "https://facebook.com/company",
    ...Array.from({ length: 5 }, (_, i) => `https://company${i}.example.test/`),
  ];
  const r = await new TavilySearchProvider({
    apiKey: key,
    fetch: async () => json({ results: urls.map((url) => ({ url, title: key })) }),
  }).findOfficialSite(company, { clock });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value).toHaveLength(5);
  expect(r.value[0]?.url).toBe("https://example.test/");
  expect(r.value.every((row) => row.title === null)).toBe(true);
  expect(r.value.find((row) => row.url.includes("facebook"))?.thirdParty).toBe(true);
});
it.each([
  [401, "search_unavailable"],
  [403, "search_unavailable"],
  [429, "search_rate_limited"],
  [432, "search_rate_limited"],
  [433, "search_rate_limited"],
  [500, "search_failed"],
])("maps status %s without retaining response secrets or retrying", async (status, error) => {
  const transport = vi.fn(async () => new Response(key, { status: Number(status) }));
  const r = await new TavilySearchProvider({ apiKey: key, fetch: transport }).findOfficialSite(company, { clock });
  expect(r).toMatchObject({ ok: false, error });
  expect(JSON.stringify(r)).not.toContain(key);
  expect(transport).toHaveBeenCalledTimes(1);
});
it("does not fetch with missing configuration, an invalid query or an aborted parent", async () => {
  const transport = vi.fn(async () => json({ results: [] }));
  for (const [apiKey, query, signal] of [
    ["", company, undefined],
    [key, { ...company, name: "" }, undefined],
    [key, company, AbortSignal.abort()],
  ] as const) {
    expect(
      (await new TavilySearchProvider({ apiKey, fetch: transport }).findOfficialSite(query, { clock, signal })).ok,
    ).toBe(false);
  }
  expect(transport).not.toHaveBeenCalled();
});
it("rejects malformed, non-JSON, oversized and invalid UTF-8 responses", async () => {
  for (const response of [
    json({}),
    new Response("bad", { headers: { "content-type": "application/json" } }),
    new Response("<html>"),
    new Response("{}", { headers: { "content-type": "application/json", "content-length": "2000000" } }),
    new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } }),
    new Response("x".repeat(1_048_577), { headers: { "content-type": "application/json" } }),
  ]) {
    expect(
      await new TavilySearchProvider({ apiKey: key, fetch: async () => response }).findOfficialSite(company, { clock }),
    ).toMatchObject({ ok: false, error: "search_failed" });
  }
});
it("an absolute deadline ends fetches that ignore AbortSignal and cancels a stalled body", async () => {
  let signal: AbortSignal | undefined;
  const r = await new TavilySearchProvider({
    apiKey: key,
    timeoutMs: 20,
    fetch: async (_, init) => {
      signal = init.signal!;
      return new Promise(() => {});
    },
  }).findOfficialSite(company, { clock });
  expect(r.ok).toBe(false);
  expect(signal?.aborted).toBe(true);
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"results":['));
    },
    cancel,
  });
  expect(
    (
      await new TavilySearchProvider({
        apiKey: key,
        timeoutMs: 20,
        fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
      }).findOfficialSite(company, { clock })
    ).ok,
  ).toBe(false);
  expect(cancel).toHaveBeenCalledTimes(1);
});
it("parent cancellation aborts an in-flight fetch without echoing its failure", async () => {
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  const provider = new TavilySearchProvider({
    apiKey: key,
    fetch: async (_, init) => {
      signal = init.signal!;
      controller.abort();
      throw new Error(key);
    },
  });
  const r = await provider.findOfficialSite(company, { clock, signal: controller.signal });
  expect(signal?.aborted).toBe(true);
  expect(r.ok).toBe(false);
  expect(JSON.stringify(r)).not.toContain(key);
});
