import { ArrowLeft, Database, ExternalLink } from "lucide-react";
import Link from "next/link";

export const metadata = {
  title: "企業情報の出典 | SiteOffer",
  robots: { index: false, follow: false },
};

export default function SourcesPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <Link
        className="inline-flex min-h-11 items-center gap-2 text-sm text-primary underline underline-offset-4"
        href="/"
      >
        <ArrowLeft size={16} aria-hidden="true" /> SiteOfferへ戻る
      </Link>
      <header className="mt-5 border-b pb-7">
        <div className="mb-4 flex items-center gap-3 text-sm font-semibold text-primary">
          <Database size={22} aria-hidden="true" /> SiteOffer
        </div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">企業情報の出典</h1>
        <p className="mt-3 text-sm leading-7 text-muted-foreground">
          掲載情報の取得元と、確認できている範囲についてご案内します。
        </p>
      </header>
      <div className="mt-7 space-y-5 text-sm leading-7">
        <section className="rounded-xl border bg-card p-5 sm:p-6" aria-labelledby="candidate-title">
          <h2 id="candidate-title" className="text-base font-semibold">
            掲載しているのは営業候補です
          </h2>
          <p className="mt-2 text-muted-foreground">
            運営が調査して用意する企業候補であり、企業からの発注や営業への同意、成約を保証するものではありません。一覧は、地域のすべての企業を網羅したものではありません。
          </p>
        </section>
        <section className="rounded-xl border bg-card p-5 sm:p-6" aria-labelledby="registry-title">
          <h2 id="registry-title" className="text-base font-semibold">
            法人番号・名称・所在地
          </h2>
          <p className="mt-2 text-muted-foreground">
            国税庁法人番号システムの情報などを利用します。企業ごとの出典・所在地・公式サイトの確認状態は、企業詳細で確認してください。公式サイトや連絡先は、法人の基本情報とは分けて確認します。
          </p>
          <div className="mt-4 rounded-lg bg-muted px-4 py-3">
            <p className="font-medium">国税庁Web-API由来の情報を利用する場合について</p>
            <p className="mt-2">
              このサービスは、国税庁法人番号システムのWeb-API機能を利用して取得した情報をもとに作成しているが、サービスの内容は国税庁によって保証されたものではない
            </p>
          </div>
          <a
            className="mt-3 inline-flex min-h-11 items-center gap-2 text-primary underline underline-offset-4"
            href="https://www.houjin-bangou.nta.go.jp/webapi/"
            target="_blank"
            rel="noreferrer"
          >
            国税庁のWeb-API案内 <ExternalLink size={14} aria-hidden="true" />
          </a>
        </section>
        <section className="rounded-xl border bg-card p-5 sm:p-6" aria-labelledby="review-title">
          <h2 id="review-title" className="text-base font-semibold">
            公式サイト・診断・提案
          </h2>
          <p className="mt-2 text-muted-foreground">
            検索で見つかったURLは、公式サイトの候補です。同名の別企業や第三者の紹介ページの場合もあるため、検索結果だけで公式と確定しません。
          </p>
          <p className="mt-3 text-muted-foreground">
            会社情報の確認、サイトの診断、デザインや提案の承認はそれぞれ別の確認です。取得日時や根拠を確認し、現在の企業情報と異なる場合は運営へ相談してください。
          </p>
        </section>
        <section
          className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-amber-950 sm:p-6"
          aria-labelledby="demo-title"
        >
          <h2 id="demo-title" className="text-base font-semibold">
            デモの架空データについて
          </h2>
          <p className="mt-2">
            デモには架空の企業や、動作確認用の診断・画像・提案が含まれます。実企業の調査結果や、実際の制作実績・品質の承認を示すものではありません。
          </p>
        </section>
      </div>
    </main>
  );
}
