/**
 * 開発用の初期ユーザー（運営1・営業1）と仮の利用条件を作る。
 * パスワードは実行時に乱数で生成して表示する。リポジトリやファイルには書かない。
 * 既に同じメールのユーザーがいれば作らない（パスワードも変えない）。
 *
 *   DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres pnpm exec tsx packages/core/src/auth/seed.ts
 */
import { pathToFileURL } from "node:url";
import { createDb, type DbOrTx } from "@siteoffer/db";
import { type Clock, systemClock } from "../common/clock.ts";
import { generatePassword } from "./crypto.ts";
import { ensureTermsVersion, PLACEHOLDER_TERMS } from "./terms.ts";
import { createUserBySystem } from "./users.ts";

/** 開発用の宛先。example.test は実在しないドメイン（RFC 6761） */
export const DEV_USERS = [
  { email: "ops@example.test", displayName: "開発用 運営", role: "ops" },
  { email: "sales@example.test", displayName: "開発用 営業", role: "sales" },
] as const;

export interface SeededUser {
  email: string;
  role: "sales" | "ops";
  /** 今回作ったときだけ入る。既存ユーザーは null */
  password: string | null;
}

export async function seedDevUsers(db: DbOrTx, clock: Clock): Promise<SeededUser[]> {
  await ensureTermsVersion(db, clock, PLACEHOLDER_TERMS);
  const out: SeededUser[] = [];
  for (const u of DEV_USERS) {
    const password = generatePassword();
    const r = await createUserBySystem(db, clock, { ...u, password, job: "seed:dev-users" });
    if (r.ok) out.push({ email: u.email, role: u.role, password });
    else if (r.error === "email_taken") out.push({ email: u.email, role: u.role, password: null });
    else throw new Error(`seed に失敗しました: ${u.email} ${r.error}`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL が設定されていません");
    process.exit(1);
  }
  const { db, close } = createDb(url);
  try {
    const result = await seedDevUsers(db, systemClock);
    console.log("開発用ユーザー（パスワードはこの表示限り。保存が必要なら各自で控える）");
    for (const u of result) {
      console.log(`  ${u.role}\t${u.email}\t${u.password ?? "（既存のため変更なし）"}`);
    }
  } finally {
    await close();
  }
}
