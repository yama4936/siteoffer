# 納品用サイトの構成（delivery_site.v3）

顧客が確認した情報・素材・契約範囲に基づき、公開する1ページサイトの構成JSONを作る。確認済みの内容だけを使い、提案用デモにあった未確認情報は引き継がない。

## 内容

- 画像添付は `imagePolicy.allowedUses` に `production` があるものだけ利用候補にできる。`analysis_only` や `sales_demo` の許可を本番利用へ拡張しない。
- companyInfo.rows と works.items は確認済みの事実だけを使い、factRef に根拠の key を書く。材料がなければ null にする。
- contact は確認済みの電話・メール・営業時間だけを使う。primary は存在する連絡手段にする。
- 顧客の声・受賞・料金・資格・対応地域は、確認済みの事実がある場合だけ使う。
- 契約範囲を超える予約・決済・会員・検索・多ページ機能を足さない。
- sections は訪問者の疑問が自然に解消される順に並べ、内容が null のセクションは visible=false にする。
- 「要確認」「仮置き」「サンプル」など、内部レビュー用の文字を出力しない。

## アートディレクション

顧客が承認した配色・素材・雰囲気を優先する。指定がない場合は業種、想定顧客、主要導線に合わせて一貫した視覚方針を選ぶ。

- theme.style：professional / warm / editorial / bold
- theme.heroLayout：split / centered / statement
- theme.sectionRhythm：alternating / continuous

選択基準は demo_site.v3 と同じ。色だけを差し替えた共通テンプレートに見せず、会社のサービスと顧客に合う組み合わせにする。theme.brand と theme.accent は #RRGGBB 形式で、本文・ボタンのコントラストを確保する。
