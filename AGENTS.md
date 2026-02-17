法令API: https://laws.e-gov.go.jp/api/2/swagger-ui/

エンドポイント定義の参照方法:
1. まず `https://laws.e-gov.go.jp/api/2/swagger-ui/swagger-initializer.js` を確認する。
2. `url` で指定されるOpenAPI定義（現時点では `/api/2/swagger-ui/lawapi-v2.yaml`）を正とする。
3. 実装時は上記YAMLの `paths` を参照し、推測でエンドポイント名を決めない。

本文取得API（v2）:
- 正: `GET /api/2/law_data/{law_id_or_num_or_revision_id}`
- 誤: `GET /api/2/law_contents`（存在しない）
