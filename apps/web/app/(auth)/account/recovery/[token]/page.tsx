import { inspectPasswordRecovery, systemClock } from "@siteoffer/core";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { fmtDate } from "@/lib/ops/format";
import { RecoveryResetForm } from "../reset-form";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "パスワードの再設定 | SiteOffer",
  referrer: "no-referrer" as const,
  robots: { index: false, follow: false },
};
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params,
    info = await inspectPasswordRecovery(getDb(), systemClock, token);
  if (!info)
    return (
      <section className="space-y-4 rounded-xl border bg-white p-6">
        <h1 className="font-bold text-xl">この案内は利用できません</h1>
        <p className="text-sm leading-7">
          期限切れ、使用済み、または取り消された案内です。再設定が完了している場合は、新しいパスワードでログインしてください。
        </p>
        <Link href="/login" className="block underline">
          ログインへ
        </Link>
        <Link href="/account/recovery" className="block underline">
          復旧をあらためて依頼
        </Link>
      </section>
    );
  return (
    <section className="space-y-5 rounded-xl border bg-white p-6 shadow-sm">
      <h1 className="font-bold text-xl">新しいパスワードを設定</h1>
      <p className="text-sm leading-7 text-slate-600">
        設定すると、対象アカウントのすべてのログインを解除します。記事や案件のデータは残ります。
      </p>
      <p className="rounded-lg bg-slate-50 p-3 text-xs">有効期限：{fmtDate(info.expiresAt)}（日本時間）</p>
      <RecoveryResetForm token={token} />
    </section>
  );
}
