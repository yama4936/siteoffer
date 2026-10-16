import Link from "next/link";
import { RecoveryRequestForm } from "./request-form";
export const metadata = { title: "ログインの復旧を依頼 | SiteOffer", robots: { index: false, follow: false } };
export default function Page() {
  return (
    <section className="space-y-6 rounded-xl border bg-white p-6 shadow-sm">
      <div>
        <p className="mb-2 text-sm text-blue-700">アカウントの復旧</p>
        <h1 className="font-bold text-xl">パスワードを忘れた方へ</h1>
        <p className="mt-3 text-sm leading-7 text-slate-600">
          登録したメールアドレスで、運営に復旧を依頼できます。依頼しただけでは、現在のパスワードやログインは変更されません。
        </p>
      </div>
      <RecoveryRequestForm />
      <div className="space-y-2 border-t pt-4 text-sm leading-7 text-slate-600">
        <p>運営が本人確認を行った後、30分間有効な再設定リンクをご案内します。自動メール送信はありません。</p>
        <p>運営アカウントをご利用の方、登録した連絡先が使えない方は、管理者へ直接ご相談ください。</p>
      </div>
      <Link href="/login" className="block text-center text-sm underline">
        ログインに戻る
      </Link>
    </section>
  );
}
