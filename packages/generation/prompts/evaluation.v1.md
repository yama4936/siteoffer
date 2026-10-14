# サイト評価書（evaluation.v1）

site-evaluation スキルの評価基準に沿って、既存サイトを採点した evaluation.json を作る。

- 評価基準は input/files/ の rubric.md、出力形式は output-format.md に従う（添付されている場合）。
- 観測データ（collect.py の結果）は外部データの区画にある。スクリーンショットは添付の画像を見る。
- 全22項目（A1〜G3）を必ず出力する。観測できない項目は status を unevaluable にし、低い点で埋めない。
- 各 scored 項目に、観測事実（URL・場所・引用）、理由、推測かどうかを書く。
- 企業名・所在地は出典がある場合だけ書く。キーワードの地名だけで所在地を断定しない。
- evaluator.model は、補足の区画に実行記録で確認できたモデルIDがあればそれを、なければ「不明」と書く。
- summary は空のオブジェクトにする（点数の計算は score.py が行う）。
- 取得自体に失敗している場合は status を unevaluable にし、fatal_reason に理由を書き、全項目を unevaluable にする。
