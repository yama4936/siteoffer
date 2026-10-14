import { getLatestTerms } from "@siteoffer/core/auth";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getDb } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { RegisterForm } from "./register-form";

export const metadata = { title: "営業パートナー登録 | SiteOffer" };

export default async function RegisterPage() {
  if (await getCurrentUser()) redirect("/");
  const terms = await getLatestTerms(getDb());
  return (
    <Card className="shadow-md">
      <CardHeader>
        <CardTitle className="text-xl">
          <h1>営業パートナー登録</h1>
        </CardTitle>
        <CardDescription>利用条件を確認し、同意のうえで登録してください。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {terms ? (
          <>
            <section aria-labelledby="terms-heading" className="space-y-2">
              <h2 id="terms-heading" className="font-medium text-sm">
                利用条件（版：{terms.version}）
              </h2>
              <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/50 p-3 font-sans text-muted-foreground text-xs leading-relaxed">
                {terms.body}
              </pre>
            </section>
            <RegisterForm termsVersionId={terms.id} />
          </>
        ) : (
          <Alert variant="warning">
            <AlertDescription>利用条件が準備中のため、現在は登録できません。</AlertDescription>
          </Alert>
        )}
        <p className="text-center text-muted-foreground text-sm">
          登録済みの方は <Link href="/login">ログイン</Link>
        </p>
      </CardContent>
    </Card>
  );
}
