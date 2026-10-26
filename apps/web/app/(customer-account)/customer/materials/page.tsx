import { ContentError, listCustomerContentCompanies, listCustomerImages } from "@siteoffer/core";
import { notFound } from "next/navigation";
import { CustomerMaterials } from "@/components/materials/customer-materials";
import { getDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
export const metadata = { title: "写真・ロゴの提出 | SiteOffer" };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser("customer"),
    db = getDb(),
    companies = await listCustomerContentCompanies(db, user.actor),
    sp = await searchParams,
    companyId = typeof sp.company === "string" ? sp.company : companies[0]?.id,
    raw = Number(sp.page ?? 0),
    page = Number.isSafeInteger(raw) && raw >= 0 ? Math.min(raw, 100000) : 0;
  if (!companies.length || !companyId)
    return (
      <section className="rounded-xl border bg-white p-8">
        <h1 className="font-bold text-xl">素材を提出できる会社がありません</h1>
        <p className="mt-4 leading-7">運営からの利用案内、または利用権限をご確認ください。</p>
      </section>
    );
  const company = companies.find((c) => c.id === companyId);
  if (!company) notFound();
  try {
    const listing = await listCustomerImages(db, user.actor, companyId, page);
    return (
      <>
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="mb-2 text-sm text-blue-700">{company.name}</p>
            <h1 className="font-bold text-2xl">写真・ロゴを提出</h1>
            <p className="mt-3 text-sm leading-7 text-slate-600">使ってほしい画像と、その使用許可を運営に伝えます。</p>
          </div>
          {companies.length > 1 && (
            <form className="flex flex-wrap gap-2">
              <label className="text-sm">
                提出先の会社
                <select
                  name="company"
                  aria-label="提出先の会社"
                  defaultValue={companyId}
                  className="ml-2 rounded border bg-white p-2"
                >
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="rounded border bg-white px-4 text-sm">
                切り替え
              </button>
            </form>
          )}
        </header>
        <CustomerMaterials key={`${companyId}:${page}`} companyId={companyId} page={page} initial={listing} />
      </>
    );
  } catch (e) {
    if (e instanceof ContentError) notFound();
    throw e;
  }
}
