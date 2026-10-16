import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/session";
import { LoginForm } from "./login-form";

export const metadata = { title: "ログイン | SiteOffer" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ passwordChanged?: string }> }) {
  const { passwordChanged } = await searchParams;
  if (await getCurrentUser()) redirect("/");
  return (
    <Card className="shadow-md">
      <CardHeader>
        <CardTitle className="text-xl">
          <h1>ログイン</h1>
        </CardTitle>
        <CardDescription>運営・営業パートナー・顧客のアカウントでログインします。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {passwordChanged === "1" && (
          <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm">
            <p className="font-semibold">パスワードを変更しました</p>
            <p className="mt-2">すべてのログインを解除しました。新しいパスワードでログインしてください。</p>
          </div>
        )}
        <LoginForm />
        <Link href="/account/recovery" className="block text-center text-sm underline">
          パスワードを忘れた方へ
        </Link>
        <p className="text-center text-muted-foreground text-sm">
          営業パートナーとして参加する方は <Link href="/register">新規登録</Link>
        </p>
      </CardContent>
    </Card>
  );
}
