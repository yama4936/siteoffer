import { getLatestTerms } from "@siteoffer/core/auth";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { RegisterForm } from "./register-form";

export const metadata = { title: "営業パートナー登録 | SiteOffer" };

export default async function RegisterPage() {
  if (await getCurrentUser()) redirect("/");
  const terms = await getLatestTerms(getDb());
  return (
    <main>
      <h1>営業パートナー登録</h1>
      {terms ? (
        <>
          <section aria-labelledby="terms-heading">
            <h2 id="terms-heading">利用条件（版：{terms.version}）</h2>
            <pre style={{ whiteSpace: "pre-wrap" }}>{terms.body}</pre>
          </section>
          <RegisterForm termsVersionId={terms.id} />
        </>
      ) : (
        <p>利用条件が準備中のため、現在は登録できません。</p>
      )}
      <p>
        登録済みの方は <Link href="/login">ログイン</Link>
      </p>
    </main>
  );
}
