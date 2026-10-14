import { systemClock } from "@siteoffer/core";
import { DecisionForm } from "@/components/customer/decision-form";
import { CUSTOMER_COMMENT_MAX } from "@/lib/customer/core";
import { formatJst, INVALID_LINK_MESSAGE, loadCustomerReview } from "@/lib/customer/review";
import { getDb } from "@/lib/db";
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
      <main>
        <h1>制作サイトのご確認</h1>
        <p className="note">{INVALID_LINK_MESSAGE}</p>
      </main>
    );
  }

  return (
    <main>
      <h1>制作サイトのご確認</h1>
      <p>
        {view.companyName} 様
        <br />
        ご契約いただいたサイトの制作版（第{view.versionNumber}版）をご確認ください。
      </p>
      <p className="muted">
        このリンクの有効期限：{formatJst(view.linkExpiresAt)}
        まで。リンクはご担当者様のみで扱い、第三者への転送はお控えください。
      </p>

      <h2>制作版の表示</h2>
      <div className="preview-tabs">
        <a href={view.previewUrl} target="_blank" rel="noopener noreferrer">
          新しいタブで開く（スマートフォン表示の確認にもお使いください）
        </a>
      </div>
      <iframe
        className="preview-frame"
        src={view.previewUrl}
        title={`制作版 第${view.versionNumber}版`}
        sandbox="allow-scripts allow-popups"
        referrerPolicy="no-referrer"
      />
      <p className="muted">
        確認用の表示です。まだ一般には公開されていません。文章・写真・連絡先などに誤りがないかをご確認ください。
      </p>

      <h2>承認・修正のご依頼</h2>
      <Decision view={view} token={token} />

      <p className="muted note">
        承認いただいた版を公開の対象として記録します。公開の日程・手順は担当窓口からご案内します。
        サイトの公開は、お問い合わせや売上などの成果を保証するものではありません。
      </p>
    </main>
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
          commentMax={CUSTOMER_COMMENT_MAX}
        />
      );
    case "approved":
      return (
        <p className="msg msg-ok">
          この版は承認済みです
          {view.lastDecision ? `（${formatJst(view.lastDecision.decidedAt)}）` : ""}
          。公開に向けた準備を進めています。
        </p>
      );
    case "changes_requested":
      return (
        <div className="note">
          <p>
            修正のご依頼を受け付けました
            {view.lastDecision ? `（${formatJst(view.lastDecision.decidedAt)}）` : ""}
            。修正版の準備ができましたら、あらためてご案内します。
          </p>
          {view.lastDecision?.comment ? (
            <p className="muted" style={{ whiteSpace: "pre-wrap" }}>
              ご依頼の内容：{view.lastDecision.comment}
            </p>
          ) : null}
        </div>
      );
    case "closed":
      return <p className="note">この版の確認の受付は終了しました。最新のご案内に記載のリンクをご確認ください。</p>;
  }
}
