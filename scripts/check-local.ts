import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createLocalAuthProvider } from "../packages/core/src/auth/local-provider.ts";
import type { SeededUser } from "../packages/core/src/auth/seed.ts";
import { systemClock } from "../packages/core/src/common/clock.ts";
import { createDb } from "../packages/db/src/client.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL が設定されていません");
const base = `http://127.0.0.1:${process.env.WEB_PORT ?? 3100}`;
const credentials: SeededUser[] = JSON.parse(
  await readFile(fileURLToPath(new URL("../.data/dev-users.json", import.meta.url)), "utf8"),
);
const { db, close } = createDb(process.env.DATABASE_URL);
const auth = createLocalAuthProvider({ db, clock: systemClock });
const paths = {
  ops: [
    "/ops",
    "/ops/discovery",
    "/ops/review",
    "/ops/assignments",
    "/ops/contracts",
    "/ops/delivery",
    "/ops/settings",
  ],
  sales: ["/sales/companies", "/sales/assignments", "/sales/earnings"],
};

try {
  for (const pathname of ["/login", "/register"]) {
    const response = await fetch(`${base}${pathname}`);
    assert.equal(response.status, 200, pathname);
  }
  for (const pathname of ["/ops", "/sales"]) {
    const response = await fetch(`${base}${pathname}`, { redirect: "manual" });
    assert.equal(response.status, 307, `未ログイン ${pathname}`);
    assert.equal(new URL(response.headers.get("location")!, base).pathname, "/login");
  }
  const preview = await fetch(`http://127.0.0.1:${process.env.PREVIEW_PORT ?? 3200}/`, {
    headers: { Cookie: "siteoffer_session=invalid-development-session" },
  });
  assert.equal(preview.status, 404, "共有リンクなしではプレビューを配信しない");
  assert.equal(preview.headers.get("set-cookie"), null, "プレビューはCookieを発行しない");
  assert(preview.headers.get("content-security-policy"), "プレビューのCSP");
  for (const role of ["ops", "sales"] as const) {
    const user = credentials.find((u) => u.role === role);
    assert(user?.password, `開発用 ${role} のログイン情報がありません。pnpm dev:seed を確認してください`);
    const login = await auth.login({ email: user.email, password: user.password });
    assert(login.ok, `${role} ログイン失敗`);
    try {
      const headers = { Cookie: `siteoffer_session=${login.value.token}` };
      if (role === "sales") {
        const home = await fetch(`${base}/sales`, { headers, redirect: "manual" });
        assert.equal(home.status, 307, "営業トップの転送");
        assert.equal(new URL(home.headers.get("location")!, base).pathname, "/sales/companies");
      }
      for (const pathname of paths[role]) {
        const response = await fetch(`${base}${pathname}`, { headers, redirect: "manual" });
        assert.equal(response.status, 200, `${role} ${pathname}`);
        assert((await response.text()).includes("SiteOffer"), `${pathname} の描画`);
      }
      const forbidden = role === "ops" ? "/sales" : "/ops";
      const response = await fetch(`${base}${forbidden}`, { headers, redirect: "manual" });
      assert.equal(response.status, 307, `${role} の役割境界`);
      assert.equal(new URL(response.headers.get("location")!, base).pathname, "/");
      console.log(`${role}: 実PostgreSQLの認証、各画面のHTTP応答、役割境界を確認`);
    } finally {
      await auth.logout(login.value.token);
    }
  }
  console.log("OK: ローカル起動確認（外部API呼び出しなし。ログインフォーム送信は対象外）");
} finally {
  await close();
}
