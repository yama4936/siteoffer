export type HttpSmokeCheck = { route: string; ok: boolean; status: number | null; message: string };
type SmokeResult =
  | { ok: false; refused: true; message: string }
  | { ok: boolean; refused: false; checks: HttpSmokeCheck[]; scope: "anonymous-http-only" };
const base = "http://127.0.0.1:3100";
const routes = [
  { route: "/login", public: true },
  { route: "/register", public: true },
  { route: "/ops", public: false },
  { route: "/sales/companies", public: false },
  { route: "/sales/assignments", public: false },
  { route: "/customer/content", public: false },
] as const;

/** A public smoke check must never approve proposals, claim work or issue bearer links. */
export async function runLocalHttpSmoke(
  args: readonly string[] = [],
  request: typeof fetch = fetch,
): Promise<SmokeResult> {
  if (args.length)
    return {
      ok: false,
      refused: true,
      message: args.includes("--finish")
        ? "旧 --finish は廃止しました。通常DBの承認・営業可能化・担当確保・共有リンク発行は行いません。通し確認は pnpm test:postgres:pipeline 等の専用DBで実行してください。"
        : "この確認コマンドは引数を取りません。pnpm test:http で匿名HTTPの読み取りだけを確認します。",
    };
  const checks = await Promise.all(
    routes.map(async ({ route, public: isPublic }): Promise<HttpSmokeCheck> => {
      let response: Response | undefined;
      try {
        response = await request(`${base}${route}`, {
          method: "GET",
          credentials: "omit",
          redirect: "manual",
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
        });
        if (isPublic) {
          const ok =
            response.status === 200 &&
            !!response.headers.get("content-type")?.includes("text/html") &&
            (await response.text()).includes("SiteOffer");
          return {
            route,
            ok,
            status: response.status,
            message: ok ? "公開入口を確認" : "公開入口の表示を確認できません",
          };
        }
        const location = response.headers.get("location");
        const target = location ? new URL(location, base) : null;
        const ok =
          [302, 303, 307, 308].includes(response.status) && target?.origin === base && target.pathname === "/login";
        return {
          route,
          ok,
          status: response.status,
          message: ok ? "匿名アクセスをログインへ戻すことを確認" : "匿名アクセスの制限を確認できません",
        };
      } catch {
        // Exception text can contain URLs or response bodies; never persist it in this report.
        return { route, ok: false, status: response?.status ?? null, message: "HTTPの読み取りを完了できません" };
      } finally {
        if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
      }
    }),
  );
  return { ok: checks.every((check) => check.ok), refused: false, checks, scope: "anonymous-http-only" };
}
