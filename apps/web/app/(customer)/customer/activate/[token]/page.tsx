import { inspectContentInvitation, systemClock } from "@siteoffer/core";
import Link from "next/link";
import { CustomerActivation } from "@/components/customer/activation";
import { getDb } from "@/lib/db";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "記事更新の利用開始 | SiteOffer",
  referrer: "no-referrer" as const,
  robots: { index: false, follow: false },
};
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params,
    invitation = await inspectContentInvitation(getDb(), systemClock, token);
  if (!invitation)
    return (
      <section className="mx-auto max-w-xl rounded-xl border bg-white p-8">
        <h1 className="text-xl font-bold">この案内は利用できません</h1>
        <p className="my-4 leading-7">
          有効期限が過ぎたか、運営が案内を取り消しました。新しい案内を運営にご依頼ください。
        </p>
        <Link className="text-blue-700 underline" href="/login">
          利用開始済みの方はログイン
        </Link>
      </section>
    );
  return <CustomerActivation token={token} invitation={invitation} />;
}
