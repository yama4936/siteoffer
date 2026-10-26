import { systemClock } from "@siteoffer/core";
import { CircleCheck, Clock, ExternalLink, Info, LinkIcon } from "lucide-react";
import { DecisionForm } from "@/components/customer/decision-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CUSTOMER_COMMENT_MAX } from "@/lib/customer/core";
import { formatJst, INVALID_LINK_MESSAGE, loadCustomerReview } from "@/lib/customer/review";
import { getDb } from "@/lib/db";
import { cn } from "@/lib/utils";
import { customerDecisionAction } from "../../actions";

/**
 * 制作サイトのご確認（顧客向け・5.3・AC-18）。
 * 運営が発行した期限付きリンク（/review/<token>）で開く。ログインやアプリのセッションCookieは使わない。
 * 制作版は別オリジンのプレビュー配信（apps/preview）で表示する。
 */
export default async function CustomerReviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await loadCustomerReview({ db: getDb(), clock: systemClock }, token);

  if (!view) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <Card>
          <CardHeader>
            <CardTitle>
              <h1 className="font-semibold text-2xl tracking-tight">制作サイトのご確認</h1>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Alert>
              <LinkIcon />
              <AlertDescription>{INVALID_LINK_MESSAGE}</AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <Badge variant="info">第{view.versionNumber}版</Badge>
        <h1 className="font-semibold text-2xl tracking-tight sm:text-3xl">制作サイトのご確認</h1>
        <p className="text-base leading-relaxed">
          <span className="font-semibold text-lg">{view.companyName} 様</span>
          <br />
          ご契約いただいたサイトの制作版（第{view.versionNumber}版）をご確認ください。
        </p>
        <p className="flex items-start gap-1.5 text-muted-foreground text-sm">
          <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            このリンクの有効期限：{formatJst(view.linkExpiresAt)}
            まで。リンクはご担当者様のみで扱い、第三者への転送はお控えください。
          </span>
        </p>
      </header>

      <nav aria-label="確認の手順" className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4 text-sm">
        <span>1. 制作サイトを確認</span>
        <span aria-hidden="true">→</span>
        <a href="#customer-decision" className="font-medium text-primary underline">
          2. 承認・修正の内容を入力
        </a>
        <span aria-hidden="true">→</span>
        <span>3. 内容を確認して送信</span>
      </nav>
      <section className="space-y-3" aria-labelledby="preview-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="preview-heading" className="font-semibold text-lg tracking-tight">
            制作版の表示
          </h2>
          <a
            href={view.previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "h-auto max-w-full whitespace-normal py-1.5",
            )}
          >
            <ExternalLink />
            <span className="min-w-0 whitespace-normal">
              新しいタブで開く（スマートフォン表示の確認にもお使いください）
            </span>
          </a>
        </div>
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <iframe
            className="block h-[70vh] min-h-[480px] w-full border-0 bg-white"
            src={view.previewUrl}
            title={`制作版 第${view.versionNumber}版`}
            sandbox="allow-scripts allow-popups"
            referrerPolicy="no-referrer"
          />
        </div>
        <p className="flex items-start gap-1.5 text-muted-foreground text-sm">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            確認用の表示です。まだ一般には公開されていません。文章・写真・連絡先などに誤りがないかをご確認ください。
          </span>
        </p>
      </section>

      <Card id="customer-decision" className="mx-auto max-w-2xl scroll-mt-6">
        <CardHeader>
          <CardTitle>
            <h2 className="font-semibold text-lg tracking-tight">承認・修正のご依頼</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Decision view={view} token={token} />
        </CardContent>
      </Card>

      <p className="mx-auto max-w-2xl text-muted-foreground text-xs leading-relaxed">
        承認いただいた版を公開の対象として記録します。公開の日程・手順は担当窓口からご案内します。
        サイトの公開は、お問い合わせや売上などの成果を保証するものではありません。
      </p>
    </div>
  );
}

function Decision({
  view,
  token,
}: {
  view: NonNullable<Awaited<ReturnType<typeof loadCustomerReview>>>;
  token: string;
}) {
  switch (view.state) {
    case "awaiting":
      return (
        <DecisionForm
          action={customerDecisionAction}
          token={token}
          versionId={view.versionId}
          versionNumber={view.versionNumber}
          commentMax={CUSTOMER_COMMENT_MAX}
        />
      );
    case "approved":
      return (
        <Alert variant="success">
          <CircleCheck />
          <AlertDescription>
            <p>
              この版は承認済みです
              {view.lastDecision ? `（${formatJst(view.lastDecision.decidedAt)}）` : ""}
              。公開に向けた準備を進めています。
            </p>
          </AlertDescription>
        </Alert>
      );
    case "changes_requested":
      return (
        <Alert variant="info">
          <Info />
          <AlertDescription>
            <p>
              修正のご依頼を受け付けました
              {view.lastDecision ? `（${formatJst(view.lastDecision.decidedAt)}）` : ""}
              。修正版の準備ができましたら、あらためてご案内します。
            </p>
            {view.lastDecision?.comment ? (
              <p className="whitespace-pre-wrap break-words text-muted-foreground">
                ご依頼の内容：{view.lastDecision.comment}
              </p>
            ) : null}
          </AlertDescription>
        </Alert>
      );
    case "closed":
      return (
        <Alert>
          <Info />
          <AlertDescription>
            この版の確認の受付は終了しました。最新のご案内に記載のリンクをご確認ください。
          </AlertDescription>
        </Alert>
      );
  }
}
