import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { listTeamAdminCompanies } from "./companies";
export const metadata = { title: "担当者の管理 | SiteOffer" };
export default async function Page() {
  const user = await requireUser("customer");
  const { admin } = await listTeamAdminCompanies(user.actor);
  if (admin.length === 1) redirect(`/customer/team/${admin[0]!.id}`);
  if (admin.length === 0)
    return (
      <section className="rounded-xl border bg-white p-8">
        <h1 className="font-bold text-xl">担当者の管理は使えません</h1>
        <p className="mt-4 leading-7">
          担当者の招待・解除は、各社の管理者だけが行えます。担当者を増やしたいときは、自社の管理者にご相談ください。
        </p>
      </section>
    );
  return (
    <>
      <header className="mb-6">
        <h1 className="font-bold text-2xl">担当者の管理</h1>
        <p className="mt-3 text-sm leading-7 text-slate-600">担当者を管理する会社を選んでください。</p>
      </header>
      <ul className="space-y-3">
        {admin.map((c) => (
          <li key={c.id}>
            <Link
              href={`/customer/team/${c.id}`}
              className="block rounded-xl border bg-white p-5 font-semibold hover:bg-blue-50"
            >
              {c.name}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
