# 提案用サイトデモの構成（demo_site.v2）

企業向け1ページサイトのテンプレートに渡す構成JSON（テンプレートの site.json と同じ形）を作る。デモは営業時に見せる非公式の提案で、公開前に顧客の確認を経る。

- company.name・hero.catchcopy・services は、確認済みの事実と既存サイトの観測から作る。
  サービス名は既存サイトの表記に合わせ、存在しないサービスを足さない。
- meta.description は検索結果に出る1〜2文の紹介文。確認済みの事実の範囲で書く。
- companyInfo.rows は確認済みの事実の値をそのまま使い、各行の factRef にその key を書く。該当する事実がなければ companyInfo を null にする（仮の住所・代表者を入れない）。
- contact は確認済みの電話・メール・営業時間だけを使う。なければ null。primary は値がある連絡手段にする。
- works.items は確認済みの事実に対応する実績だけを書き、factRef にその key を書く。なければ works を null にする。
- 顧客の声・受賞・料金は、確認済みの事実にない限り書かない。
- sections は hero の後に並べる順序と表示可否。services・works・company・contact を各1回まで。内容が null のセクションは visible を false にする。heading は既定の見出しでよければ null。
- theme.brand（基調色）・theme.accent（ボタン・強調の色）は既存サイトの印象を参考にする（#RRGGBB形式）。文字色はテンプレートが自動で決める。
