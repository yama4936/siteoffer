import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/session";
import { LoginForm } from "./login-form";

export const metadata = { title: "ログイン | SiteOffer" };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  return (
    <Card className="shadow-md">
      <CardHeader>
        <CardTitle className="text-xl">
          <h1>ログイン</h1>
        </CardTitle>
        <CardDescription>運営・営業パートナーのアカウントでログインします。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <LoginForm />
        <p className="text-center text-muted-foreground text-sm">
          営業パートナーとして参加する方は <Link href="/register">新規登録</Link>
        </p>
      </CardContent>
    </Card>
  );
}
