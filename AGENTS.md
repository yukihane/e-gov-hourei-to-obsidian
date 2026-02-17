## 利用する外部APIについて
法令API: https://laws.e-gov.go.jp/api/2/swagger-ui/

エンドポイント定義の参照方法:
1. まず `https://laws.e-gov.go.jp/api/2/swagger-ui/swagger-initializer.js` を確認する。
2. `url` で指定されるOpenAPI定義（現時点では `/api/2/swagger-ui/lawapi-v2.yaml`）を正とする。
3. 実装時は上記YAMLの `paths` を参照し、推測でエンドポイント名を決めない。

本文取得API（v2）:
- 正: `GET /api/2/law_data/{law_id_or_num_or_revision_id}`
- 誤: `GET /api/2/law_contents`（存在しない）

## コーディング規約

- 関数や構造体には、言語の仕様に基づいたコメント書式でコメントを付与すること
- コメントは日本語で記述すること
- Rust では公開API（`pub` な構造体・関数）に `///` のドキュメントコメントを付与すること
- 非公開実装でも、処理意図が自明でない箇所（APIフォーマット変換、法令参照リンク解決、エラー回復分岐）には `//` で補足コメントを付与すること
- コメントには「何をしているか」だけでなく「なぜその処理が必要か」を記述すること
- 明白な代入や単純な制御構文への冗長コメント（例: `// 変数に代入する`）は付与しないこと
