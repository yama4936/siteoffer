import { redirect } from "next/navigation";
import { accountsHref, parseAccountsQuery } from "@/lib/ops/accounts-query";

/** 旧「ログインの復旧」画面。アカウント管理（/ops/accounts）にまとめたため、history・page を引き継いで転送する */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { history, page } = parseAccountsQuery(await searchParams);
  redirect(accountsHref({ history, page }, history || page > 0 ? "recovery" : undefined));
}
