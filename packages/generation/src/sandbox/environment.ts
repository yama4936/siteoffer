export const CODEX_PROXY_ENV = "SITEOFFER_CODEX_HTTPS_PROXY";

export function isInternalProxyNetwork(value: string): boolean {
  try {
    const network: unknown = JSON.parse(value);
    return (
      !!network &&
      typeof network === "object" &&
      (network as { Driver?: unknown }).Driver === "bridge" &&
      (network as { Internal?: unknown }).Internal === true
    );
  } catch {
    return false;
  }
}

/** Explicit CONNECT proxy only. Credentials and arbitrary URL components never enter Docker arguments. */
export function codexProxyUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (
      !/^http:\/\/[^/?#]+\/?$/.test(raw) ||
      /[^\x21-\x7e]/.test(raw) ||
      url.protocol !== "http:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.port === "0"
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error("生成用プロキシは認証情報・パス・クエリを含まないhttp://ホスト:ポートで指定してください。");
  }
}

/** SDK env replaces inheritance. Host/global proxy variables and NO_PROXY must not bypass the explicit setting. */
export function buildCodexProcessEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "CODEX_HOME", "LANG", "TZ"]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  const proxy = codexProxyUrl(source[CODEX_PROXY_ENV]);
  if (proxy) {
    env.HTTPS_PROXY = proxy;
    env.HTTP_PROXY = proxy;
  }
  return env;
}
