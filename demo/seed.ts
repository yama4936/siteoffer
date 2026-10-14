/**
 * デモ用のシード。何度実行しても増えない（同じメール・同じ版は作らない）。
 * - 運営1人・営業1人と仮の利用条件：開発用シード（packages/core/src/auth/seed.ts の seedDevUsers）をそのまま使う
 * - 営業2人目（担当の重複・権限の確認用）
 * - 販売条件・報酬条件の版（product_terms）：デモ用の仮値。ユーザーが決めた値ではない
 * パスワードは開発用シードと同じく乱数で作り、.data/demo/users.json（Git対象外・権限600）にだけ保存する。
 * 表示は `pnpm demo:users`（自分の端末で明示的に実行したときだけ）。
 *
 *   DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres node --import tsx demo/seed.ts
 *   node --import tsx demo/seed.ts --show
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { generatePassword } from "../packages/core/src/auth/crypto.ts";
import { type SeededUser, seedDevUsers } from "../packages/core/src/auth/seed.ts";
import { createUserBySystem } from "../packages/core/src/auth/users.ts";
import { type Clock, systemClock } from "../packages/core/src/common/clock.ts";
import { createDb } from "../packages/db/src/client.ts";
import type { DbOrTx } from "../packages/db/src/index.ts";
import { productTerms } from "../packages/db/src/schema/index.ts";
import { DEMO_PATHS } from "./paths.ts";

/** 開発用シードに足すデモ用の営業ユーザー。example.test は実在しないドメイン（RFC 6761） */
export const EXTRA_DEMO_USERS = [{ email: "sales2@example.test", displayName: "デモ用 営業2", role: "sales" }] as const;

/** デモ用の販売条件・報酬条件の版。値はデモ用の仮値で、ユーザーが決めた値ではない */
export const DEMO_TERMS = {
  version: "demo-2026-10",
  name: "デモ用の仮条件（ユーザーが決めた値ではない）",
  scope: {
    _note: "デモ用の仮値。ユーザーが決めた値ではない。本番の販売条件には使わない",
    pages: ["top", "about", "services", "works", "contact"],
    domain: "ドメイン希望の聞き取りまで（取得・移管は運営）",
  },
  price: 300_000,
  monthlyFee: 5_000,
  /** 販売価格の10%（万分率 1000）。デモ用の仮値 */
  rewardRule: { type: "rate", basisPoints: 1000 },
} as const;

export async function seedDemo(db: DbOrTx, clock: Clock): Promise<{ users: SeededUser[]; termsCreated: boolean }> {
  const users = await seedDevUsers(db, clock);
  for (const u of EXTRA_DEMO_USERS) {
    const password = generatePassword();
    const r = await createUserBySystem(db, clock, { ...u, password, job: "seed:demo-users" });
    if (r.ok) users.push({ email: u.email, role: u.role, password });
    else if (r.error === "email_taken") users.push({ email: u.email, role: u.role, password: null });
    else throw new Error(`シードに失敗した：${u.email} ${r.error}`);
  }
  const inserted = await db
    .insert(productTerms)
    .values({ ...DEMO_TERMS, scope: { ...DEMO_TERMS.scope }, rewardRule: { ...DEMO_TERMS.rewardRule } })
    .onConflictDoNothing({ target: productTerms.version })
    .returning({ id: productTerms.id });
  return { users, termsCreated: inserted.length > 0 };
}

/** 今回作ったユーザーのパスワードを既存のファイルに重ねて保存する（既存ユーザーの記録は残す） */
async function saveCredentials(users: SeededUser[]): Promise<void> {
  const fresh = users.filter((u) => u.password !== null);
  if (fresh.length === 0) return;
  await mkdir(DEMO_PATHS.data, { recursive: true, mode: 0o700 });
  let previous: SeededUser[] = [];
  try {
    previous = JSON.parse(await readFile(DEMO_PATHS.users, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const merged = [...previous.filter((p) => !fresh.some((f) => f.email === p.email)), ...fresh];
  await writeFile(DEMO_PATHS.users, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  await chmod(DEMO_PATHS.users, 0o600);
}

async function main() {
  if (process.argv.includes("--show")) {
    try {
      process.stdout.write(await readFile(DEMO_PATHS.users, "utf8"));
    } catch {
      console.error("デモ用アカウントの記録がない。先に pnpm demo を実行する");
      process.exitCode = 1;
    }
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL が設定されていない");
  const { db, close } = createDb(url);
  try {
    const { users, termsCreated } = await seedDemo(db, systemClock);
    await saveCredentials(users);
    const created = users.filter((u) => u.password !== null).map((u) => u.email);
    console.log(
      `[seed] デモ用アカウント ${users.length} 件を確認（今回作成：${created.length ? created.join("・") : "なし"}）。` +
        `販売条件・報酬条件の版 ${DEMO_TERMS.version}：${termsCreated ? "作成" : "既存"}。` +
        "ログイン情報は pnpm demo:users で表示できる",
    );
  } finally {
    await close();
  }
}

await main();
