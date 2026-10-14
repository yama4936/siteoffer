import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/session";
import { logoutAction } from "../actions";

export const metadata = { title: "ログアウト | SiteOffer" };

/** ログアウトはPOST（Server Action）で行う。GETだけでセッションを消さない */
export default async function LogoutPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return (
    <Card className="shadow-md">
      <CardHeader>
        <CardTitle className="text-xl">
          <h1>ログアウト</h1>
        </CardTitle>
        <CardDescription>
          {user.displayName} さん（{user.role === "ops" ? "運営" : "営業"}）としてログイン中です。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={logoutAction}>
          <Button type="submit" className="w-full">
            ログアウトする
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
