import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { logoutAction } from "../actions";

export const metadata = { title: "ログアウト | SiteOffer" };

/** ログアウトはPOST（Server Action）で行う。GETだけでセッションを消さない */
export default async function LogoutPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return (
    <main>
      <h1>ログアウト</h1>
      <p>
        {user.displayName} さん（{user.role === "ops" ? "運営" : "営業"}）としてログイン中です。
      </p>
      <form action={logoutAction}>
        <button type="submit">ログアウトする</button>
      </form>
    </main>
  );
}
