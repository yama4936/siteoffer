# 納品用サイトの構成（delivery_site.v2）

顧客が確認した情報・素材・契約範囲に基づき、公開する1ページサイトのテンプレートに渡す構成JSON（テンプレートの site.json と同じ形）を作る。

- 使ってよいのは確認済みの事実だけ。デモの文章を流用する場合も、確認済みの事実と食い違う部分は直す。
- companyInfo.rows は確認済みの事実の値をそのまま使い、各行の factRef にその key を書く。該当する事実がなければ companyInfo を null にする。
- contact は確認済みの電話・メール・営業時間だけを使う。なければ null。primary は値がある連絡手段にする。
- works.items は確認済みの事実に対応する実績だけを書き、factRef にその key を書く。なければ works を null にする。
- 補足の区画にある契約範囲を超える要素（予約・決済・多ページ等）を足さない。
- sections は hero の後に並べる順序と表示可否。内容が null のセクションは visible を false にする。heading は既定の見出しでよければ null。
- theme.brand・theme.accent は顧客が確認した色の指定があればそれに従う（#RRGGBB形式）。
