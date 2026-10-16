import { AccountSecurityError, loadAccountSecurity, systemClock } from "@siteoffer/core";
import { ArrowLeft, KeyRound, ShieldCheck } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Brand } from "@/components/shell/brand";
import { getDb } from "@/lib/db";
import { homePathFor } from "@/lib/home";
import { requireUser, SESSION_COOKIE } from "@/lib/session";
import { PasswordForm } from "./password-form";
export const metadata = { title: "アカウントの安全設定 | SiteOffer", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
export default async function Page() {
  const user = await requireUser(),
    token = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  let security: Awaited<ReturnType<typeof loadAccountSecurity>>;
  try {
    security = await loadAccountSecurity(getDb(), systemClock, token);
  } catch (error) {
    if (error instanceof AccountSecurityError) redirect("/login");
    throw error;
  }
  return (
    <div className="min-h-dvh bg-slate-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 p-5">
          <Brand />
          <Link href={homePathFor(user.role)} className="inline-flex items-center gap-2 text-sm">
            <ArrowLeft size={16} />
            仕事に戻る
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8 sm:py-12">
        <div className="mb-8">
          <p className="mb-2 font-medium text-blue-700 text-sm">アカウント</p>
          <h1 className="font-bold text-2xl">安全設定</h1>
          <p className="mt-2 break-all text-slate-500 text-sm">{security.email}</p>
        </div>
        <div className="grid items-start gap-6 md:grid-cols-[1.6fr_1fr]">
          <section className="rounded-xl border bg-white p-5 shadow-sm sm:p-7">
            <h2 className="mb-6 flex items-center gap-2 font-semibold text-lg">
              <KeyRound size={20} />
              パスワードを変更
            </h2>
            <PasswordForm revision={security.credentialRevision} email={security.email} />
          </section>
          <aside className="space-y-5 rounded-xl border bg-white p-5 text-sm">
            <ShieldCheck className="text-blue-600" size={24} />
            <h2 className="font-semibold">変更後のログインについて</h2>
            <p className="leading-7 text-slate-600">
              この画面を含め、現在有効な<strong className="mx-1 text-slate-900">{security.activeLogins}件</strong>
              のログインを解除します。他のブラウザでも、新しいパスワードでのログインが必要になります。
            </p>
            <p className="leading-7 text-slate-600">
              保存済みの記事や案件はそのまま残ります。他の画面に入力途中の内容があれば、先に保存してください。
            </p>
          </aside>
        </div>
      </main>
    </div>
  );
}
