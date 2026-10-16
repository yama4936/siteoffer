import type { discoveryAvailability } from "@siteoffer/discovery";
export function DiscoveryStatus({ capabilities }: { capabilities: Awaited<ReturnType<typeof discoveryAvailability>> }) {
  return (
    <section className="mb-6 rounded-lg border bg-white p-5" aria-label="収集ワーカーの状態">
      <h2 className="mb-3 font-semibold">収集ワーカーの状態</h2>
      <ul className="space-y-2 text-sm">
        {capabilities.map((p) => (
          <li key={p.provider}>
            <strong>
              {p.provider === "fixture" ? "架空企業の動作確認" : "国税庁の実データ収集"}：
              {p.ready ? "受付可能" : "利用不可"}
            </strong>
            <p className="text-muted-foreground">{p.reason}</p>
          </li>
        ))}
      </ul>
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer font-medium">実データ収集の設定方法と収集範囲</summary>
        <div className="mt-3 space-y-2">
          <p>
            国税庁Web-APIのアプリケーションIDを取得し、プロジェクト直下の .env に NTA_APPLICATION_ID
            を設定します。IDは画面や操作履歴には保存しません。
          </p>
          <p>
            Windowsでは start-discovery.cmd で実収集モードに切り替えます。通常環境では SITEOFFER_DISCOVERY_PROVIDERS=nta
            を設定し、pnpm dev:worker でワーカーを起動します。画面が「受付可能」になってから登録・再試行してください。
          </p>
          <p>
            法人名を指定しない場合は直近30日間に更新された法人が対象です。「名古屋市の全法人から50件」を保証する収集ではありません。業種・電話番号・公式サイトURLは国税庁APIからは取得できません。実収集モードでは法人情報の収集までを行います。公式サイトの確認・実診断・AI制作には別途設定が必要です。
          </p>
          <a
            className="text-primary underline"
            href="https://www.houjin-bangou.nta.go.jp/webapi/"
            target="_blank"
            rel="noreferrer"
          >
            国税庁Web-APIの利用手続き
          </a>
        </div>
      </details>
    </section>
  );
}
