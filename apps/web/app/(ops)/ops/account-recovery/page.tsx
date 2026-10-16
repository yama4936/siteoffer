import { AccountSecurityError, listPasswordRecoveries, systemClock } from "@siteoffer/core";
import { cookies } from "next/headers";
import Link from "next/link";
import { Forbidden } from "@/components/ops/ui";
import { PageHeader } from "@/components/ui/page";
import { getDb } from "@/lib/db";
import { requireUser, SESSION_COOKIE } from "@/lib/session";
import { RecoveryManager } from "./recovery-manager";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser("ops");
  const sp = await searchParams,
    history = sp.history === "1",
    raw = Number(sp.page ?? 0),
    page = Number.isSafeInteger(raw) && raw >= 0 ? Math.min(raw, 100000) : 0;
  let result: Awaited<ReturnType<typeof listPasswordRecoveries>>;
  try {
    result = await listPasswordRecoveries(getDb(), systemClock, (await cookies()).get(SESSION_COOKIE)?.value ?? "", {
      page,
      history,
    });
  } catch (error) {
    if (error instanceof AccountSecurityError) return <Forbidden />;
    throw error;
  }
  return (
    <>
      <PageHeader title="ログインの復旧" description="本人確認の後、営業・顧客のパスワード再設定をご案内します。" />
      <div className="mb-6 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-7">
        <strong>申請は本人確認前です。</strong>{" "}
        登録済みの連絡先や対面で本人を確認し、確認した本人だけに案内を渡してください。申請時に指定された新しい連絡先へ送らないでください。発行だけではパスワード・ログインは変わりません。
      </div>
      <div className="mb-5 flex gap-3 text-sm">
        <Link
          href="/ops/account-recovery"
          aria-current={!history ? "page" : undefined}
          className={!history ? "rounded-lg bg-blue-600 px-4 py-2 text-white" : "rounded-lg border bg-white px-4 py-2"}
        >
          未完了
        </Link>
        <Link
          href="/ops/account-recovery?history=1"
          aria-current={history ? "page" : undefined}
          className={history ? "rounded-lg bg-blue-600 px-4 py-2 text-white" : "rounded-lg border bg-white px-4 py-2"}
        >
          対応済み
        </Link>
      </div>
      <RecoveryManager key={`${history}:${page}`} initial={result} history={history} />
      <p className="mt-6 text-xs leading-6 text-slate-500">
        案内は30分間有効です。再発行すると以前の案内は使えなくなります。メールの自動送信はありません。運営アカウントの復旧は対象外です。
      </p>
    </>
  );
}
