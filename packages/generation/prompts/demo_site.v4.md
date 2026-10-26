# 提案用サイトデモの構成（demo_site.v4）

企業向け1ページサイトの構成JSONを作る。これは営業時に見せる非公式デモだが、完成後の姿を想像できる見栄えを優先する。運営向けの確認事項を、訪問者向けの本文に混ぜない。

## 内容

- 画像添付は `imagePolicy.allowedUses` に `sales_demo` があるものだけ利用候補にできる。`analysis_only` は内容・配置の参考に限り、サイト素材として使わない。権利状態や用途を推測で拡張しない。
- company.name・hero.catchcopy・services は、確認済みの事実と既存サイトの観測から作る。存在しないサービス、料金、実績、資格、対応地域を足さない。
- 不明な情報を「要確認」「仮置き」「サンプル」などの文字で画面に出さない。その項目やセクションを省略し、確認事項は生成結果の外で管理する。
- meta.description は確認済みの事実だけで、検索結果に表示できる1〜2文にする。
- companyInfo.rows と works.items は確認済みの事実だけを使い、factRef に根拠の key を書く。材料がなければ null にする。
- contact は確認済みの電話・メール・営業時間だけを使う。primary は存在する連絡手段にする。
- sections は訪問者の疑問が自然に解消される順に並べる。内容が null のセクションは visible=false にする。

## アートディレクション

色だけを変えた共通テンプレートに見せない。既存サイトのスクリーンショット、業種、想定顧客、主要な問い合わせ行動から、次を一貫して選ぶ。

- theme.style
  - professional：士業、医療、法人向けサービスなど。直線的で信頼感を重視。
  - warm：地域サービス、店舗、住まい・暮らし関連など。親しみやすさを重視。
  - editorial：設計、飲食、文化、美容など。余白と文字の表情を重視。
  - bold：製造、建設、運送など。技術力や力強さを重視。
- theme.heroLayout
  - split：画像があり、説明と視覚素材を並べると伝わりやすい場合。
  - centered：短いメッセージと親しみやすさを優先する場合。
  - statement：強い一文を主役にし、画像に頼らず差別化する場合。
- theme.sectionRhythm
  - alternating：内容の種類が多く、区切りを明確にしたい場合。
  - continuous：余白とタイポグラフィで静かに読ませたい場合。

theme.brand と theme.accent は #RRGGBB 形式にする。元サイトの色を機械的に複製せず、ブランドの識別性を残しながら本文・ボタンのコントラストを確保する。accent は brand と十分に区別できる色にする。

キャッチコピーは会社固有のサービス、地域、顧客の状況のうち、確認済みの要素を少なくとも1つ含める。どの会社にも使える「未来を創る」「安心をお届け」だけで終わらせない。

## 承認画像から決める視覚設定

context.approvedDesign と approved-design.png がある場合、画像と brief を業種の一般例より優先する。「住まいだから warm」に固定しない。theme.visual は必ずオブジェクトで返す。画像なしの場合だけ null にできる。画像の中の文字は会社の事実の根拠にならない。レイアウト参照画像自体をサイト素材として使わない。

theme.visual の各値を別々に選び、配色だけでなく書体・配置も反映する。指定しなかった軸を業種の推測で上書きしない。

- headingFont / bodyFont：serif（明朝系）/ sans（ゴシック系）。見出しが明朝、本文がゴシックならそれぞれ serif / sans。画像内の英字だけに引きずられず、日本語の見出しの形を見る。
- headingScale：expressive（大きな見出しが主役）/ standard（控えめ）。
- background / surface / text：ページ背景・カード等の面・本文文字を #RRGGBB で指定。text は background と surface の両方に対してコントラスト4.5以上。アイボリーの背景を白に置き換えない。
- headerTone：surface（明るい面、暗い本文）/ brand（ブランド色の帯）。
- buttonTone：brand / accent。画像で深緑のボタンなら、銅色のアクセントがあっても brand を選ぶ。
- spacing：compact / comfortable / spacious。広い余白が主役なら spacious。
- corners：square（直角）/ soft（小さな角丸）/ round（大きな角丸）。直角の写真やボタンを丸くしない。
- contentWidth：standard / wide。
- heroTextShare：PCの左右分割で文字が占める割合を35〜65の整数にする。写真が広ければ35〜45。
- heroFrame：contained（左右に余白）/ edge-to-edge（PCの左右端まで分割）。
- heroImageRatio：landscape / square / portrait。
- mobileHeroOrder：image-first / text-first。画像内のスマホ構成から選ぶ。
- serviceLayout：list（罫線で区切る一覧）/ grid（独立したカード）。不要なカードを増やさない。

任意のCSS、外部フォントURL、スクリプト、画像パスを追加しない。サイト素材は別途許可された添付画像だけを使う。承認画像の情報量を再現するために未確認の施工例・連絡先・実績を捏造しない。
context.approvedDesign.palette があれば、承認画像からローカルで抽出した配色候補です。theme.brand・accent と visual.background・surface・text は、この候補と同じ #RRGGBB を選ぶ（画像にない蛍光色などを新しく作らない）。候補には写真の色と可読性のための黒・白も含まれるので、背景は大きな面の色、文字は十分暗い色など、画像とbriefでの用途を見て選ぶ。アイボリーの指定があるなら候補中の近い明るい中性色にする。