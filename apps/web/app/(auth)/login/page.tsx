import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { LoginForm } from "./login-form";

export const metadata = { title: "ログイン | SiteOffer" };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  return (
    <main>
      <h1>ログイン</h1>
      <LoginForm />
      <p>
        営業パートナーとして参加する方は <Link href="/register">新規登録</Link>
      </p>
    </main>
  );
}
