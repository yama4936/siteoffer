import { ContentError, loadCompanyContentAccess } from "@siteoffer/core";
import Link from "next/link";
import { CompanyTeamManager } from "@/components/customer/team-manager";
import { getDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { inviteCompanyEditorAction, refreshCompanyTeamAction, revokeCompanyEditorAction } from "../actions";
export const metadata = { title: "担当者の管理 | SiteOffer" };
export default async function Page({ params }: { params: Promise<{ companyId: string }> }) {
  const user = await requireUser("customer"),
    { companyId } = await params;
  let team: Awaited<ReturnType<typeof loadCompanyContentAccess>>;
  try {
    // 他社・編集者・無効な companyId は core が ContentError で拒否する
    team = await loadCompanyContentAccess(getDb(), user.actor, companyId);
  } catch (e) {
    if (!(e instanceof ContentError)) throw e;
    return (
      <section className="rounded-xl border bg-white p-8">
        <h1 className="font-bold text-xl">この画面を見る権限がありません</h1>
        <p role="alert" className="mt-4 rounded-xl bg-red-50 p-4 text-sm leading-7 text-red-800">
          {e.message}
        </p>
        <p className="mt-4 leading-7">
          担当者の招待・解除は、各社の管理者だけが行えます。必要なときは、自社の管理者にご相談ください。
        </p>
        <Link href="/customer/content" className="mt-4 inline-block text-sm underline">
          記事の更新へ戻る
        </Link>
      </section>
    );
  }
  return (
    <>
      <header className="mb-6">
        <p className="mb-2 text-sm text-blue-700">{team.company.name}</p>
        <h1 className="font-bold text-2xl">担当者の管理</h1>
        <p className="mt-3 text-sm leading-7 text-slate-600">
          自社でお知らせ・ブログを更新する担当者（編集者）を招待したり、解除したりできます。管理者の追加・変更は運営にご依頼ください。
        </p>
      </header>
      <CompanyTeamManager
        initial={team}
        actions={{
          invite: inviteCompanyEditorAction,
          revoke: revokeCompanyEditorAction,
          refresh: refreshCompanyTeamAction,
        }}
      />
    </>
  );
}
