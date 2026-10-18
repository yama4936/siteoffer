/** Normal and restored demos must never inherit a paid search key or enable real search. */
export function demoSearchEnv(env: NodeJS.ProcessEnv, realDiscovery: boolean): NodeJS.ProcessEnv {
  const provider = realDiscovery ? env.SITEOFFER_SEARCH_PROVIDER?.trim() || "none" : "fixture";
  return {
    SITEOFFER_SEARCH_PROVIDER: provider,
    TAVILY_API_KEY: realDiscovery && provider === "tavily" ? (env.TAVILY_API_KEY ?? "") : "",
  };
}
