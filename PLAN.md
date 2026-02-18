# Playwrightベース全面移行計画（e-Gov法令検索スクレイピング）

## 概要

`e-gov-jobun-to-obsidian` を Rust + API 依存構成から、Node.js + Playwright のスクレイピング主軸へ移行する。  
API利用は法令名から `law_id` を取得する用途に限定する。

取得対象は `https://laws.e-gov.go.jp/law/{law_id}` の実DOM（JS実行後）とし、本文・見出しアンカー・参照リンクを抽出して Obsidian 向け Markdown を生成する。

## 実測で確認済みの事実（PoC）

- 実行スクリプト: `scripts/poc_fetch_law.mjs`
- 対象法令: `334AC0000000121`（特許法）
- ダンプ保存先:
1. `data/scrape_dumps/334AC0000000121/page.html`
2. `data/scrape_dumps/334AC0000000121/summary.json`

- 確認結果:
1. `title`: `特許法 | e-Gov 法令検索`
2. `textLength`: `124859`
3. `hrefCount`: `2415`
4. `第一条` / `附則` を本文テキストとして検出済み

上記により「SPA実行後DOMから本文とリンクを取得可能」を前提として確定する。

## 目的

1. API本文（リンクなし）を基準にした推測リンク解決を廃止する。
2. e-Gov画面の実リンク情報を利用し、リンク精度を改善する。
3. ダンプを残し、再現可能な検証サイクルを確立する。

## アーキテクチャ変更

- 旧:
1. Rust CLI (`reqwest`) で `/api/2/laws` `/api/2/law_data` を呼び出し
2. JSON構造を解析してMarkdown化

- 新:
1. Node CLI（TypeScript）を新規作成
2. Playwright で `/law/{law_id}` を開く
3. 実DOMから本文・見出しID・リンクを抽出
4. Markdownレンダラで `laws/*.md` を出力
5. 未解決参照ログを `data/unresolved_refs.json` に追記

## 公開インターフェース（CLI）仕様

1. `node dist/cli.js --law-id <law_id> [--max-depth 1] [--retry 3] [--timeout-ms 30000]`
2. `node dist/cli.js "<法令名>" [--max-depth 1] [--retry 3] [--timeout-ms 30000]`
3. `node dist/cli.js --build-dictionary [--dictionary data/law_dictionary.json]`
4. `node dist/cli.js --law-id <law_id> [--max-depth 1] [--dictionary data/law_dictionary.json] [--dictionary-autoupdate]`
5. `node dist/cli.js "<法令名>" [--max-depth 1] [--dictionary data/law_dictionary.json] [--dictionary-autoupdate]`

Dockerでの実行コマンド（正式手順）:
1. `docker compose run --rm law-scraper --law-id 334AC0000000121`
2. `docker compose run --rm law-scraper "特許法"`
3. `docker compose run --rm law-scraper --build-dictionary`

法令名入力時の動作:
1. API `/api/2/laws?law_title=...` で候補取得
2. 一意なら続行
3. 複数候補なら候補一覧を機械可読JSONで標準出力し終了（対話問い合わせしない）
4. このとき終了コードは `2`

`--max-depth` の動作:
1. 深さ `0`: 指定法令のみ取得
2. 深さ `1`（既定値）: 指定法令 + 参照先法令を1段まで取得
3. 深さ `N`: 参照リンクを幅優先で最大 `N` 段まで再帰取得
4. 同一 `law_id` は再取得しない（訪問済み集合で重複除去）

辞書関連オプションの動作:
1. `--build-dictionary`:
- `/api/2/laws` を全件走査し `data/law_dictionary.json` を再生成する
- ページングは `limit=100` / `offset` 増分で実装し、取得件数が 0 件になった時点で終了する
2. `--dictionary-autoupdate`:
- 参照リンク解決中に未知の `law_id` が出たらAPIで都度取得し辞書へ追記する
- 追記失敗時は `law_<law_id>.md` へフォールバックし `unresolved_refs` に記録する
3. `--dictionary`:
- 辞書ファイルの入出力パスを切り替える

`--dictionary-autoupdate` を付けない場合:
1. 未知の `law_id` はAPI照会せず、`law_<law_id>.md` へフォールバックする
2. 同時に `data/unresolved_refs.json` へ `reason=target_not_built` で記録する

## データ仕様

### laws/<safe_title>_<law_id>.md

1. YAMLフロントマター:
- `law_id`
- `title`
- `source_url`
- `fetched_at`
2. 本文はe-Gov DOMの論理構造（章/条/項）に沿って見出し化
3. アンカーはe-Govの `id` を優先利用
4. 参照リンクはObsidianリンクへ変換

### data/unresolved_refs.json

追記配列形式。1要素は次のキーを必須にする。
1. `timestamp`
2. `root_law_id`
3. `root_law_title`
4. `from_anchor`
5. `raw_text`
6. `href`（存在すれば）
7. `reason`（`target_not_built` / `unknown_format` / `depth_limit`）

`reason` の使用条件:
1. `target_not_built`: 参照先 `law_id` は判明したが、辞書未登録または参照先ノート未生成
2. `unknown_format`: `href` が想定形式（`#...` / `/law/{law_id}` / 外部URL）に一致しない
3. `depth_limit`: `law_id` は判明したが、`--max-depth` の上限に達して取得対象外

重複判定キー: `root_law_id + from_anchor + raw_text + href`

### data/law_dictionary.json

`law_id` をキーに、リンク解決とファイル名生成に必要な最小情報を持つ。

1. キー: `law_id`
2. 値の必須キー:
- `title`（現行法令名）
- `safe_title`（ファイル名用に正規化・短縮済み）
- `file_name`（`<safe_title>_<law_id>.md`）
- `updated_at`（辞書更新日時）

例:
```json
{
  "334AC0000000121": {
    "title": "特許法",
    "safe_title": "特許法",
    "file_name": "特許法_334AC0000000121.md",
    "updated_at": "2026-02-18T12:00:00Z"
  }
}
```

## 取得・解析フロー（決定版）

1. 入力受理（法令名 or `--law-id`）
2. 法令名ならAPIで `law_id` 解決
3. ルート法令を深さ `0` としてキューへ投入する
4. キュー処理（幅優先）で法令を順に取得し、`depth <= max-depth` のものだけ処理する
5. Playwrightで `https://laws.e-gov.go.jp/law/{law_id}` へ遷移
6. 待機順序:
1. `domcontentloaded`
2. `networkidle`
3. 本文ルート候補セレクタのいずれか検出

7. 抽出セレクタ方針（優先順）:
1. 本文ルート: `#MainProvision` → `#provisionview` → `main.main-content`
2. 条文ブロック: `article.article[id]`
3. 見出し: `.articleheading`, `.paragraphtitle`, `.istitle`
4. 本文行: `p.sentence`
5. 補助IDパターン: `[id^=\"Mp-\"]`, `[id^=\"Sup-\"]`, `[id^=\"App-\"]`, `[id^=\"Ap-\"]`, `[id^=\"Enf-\"]`
6. リンク: `a[href]`

8. リンク正規化:
1. `href^=\"#Mp-\"` を最優先で同一ノート内アンカーへ
2. `href=\"#TOC\"` `href=\"#MainProvision\"` も同一ノート内アンカーへ
3. `href=\"/law/{law_id}\"` は `laws/<target>.md` へ
4. それ以外は外部リンクとして残す
5. 解決不能はプレーンテキスト化して `unresolved_refs` へ記録
6. `a[href]` を持たない参照文言は推測リンク化しない（プレーンテキストのまま出力）

`href=\"/law/{law_id}\"` の `<target>` 決定規則:
1. まず `data/law_dictionary.json` を参照し、`file_name` を採用
2. 未登録 `law_id` は `law_<law_id>.md` へフォールバック
3. 参照先 `law_id` の深さが `max-depth` 以下なら取得キューへ追加する
4. 参照先 `law_id` の深さが `max-depth` を超える場合でもリンクは生成し、`reason=depth_limit` で記録する
5. 未生成・未登録の場合は `data/unresolved_refs.json` に `reason=target_not_built` で追記する

`href=\"/law/{law_id}#<anchor>\"` の変換規則:
1. `law_id` と `anchor` を分離して解釈する
2. 参照先ノートは上記 `<target>` 決定規則に従って決定する
3. Obsidianリンクは `[[laws/<file_name>#<anchor>|表示文言]]` へ変換する

補足:
1. 非リンク文言（`a[href]` を持たない条文内参照）は `law_id` を確定できないため、リンク生成対象外とする。
2. 本実装では非リンク文言に対して形態素解析や推測補完を行わない。

9. 出力:
1. `laws/<safe_title>_<law_id>.md` を上書き再生成
2. `data/unresolved_refs.json` は追記

## エラー処理・再試行

1. リトライ対象: タイムアウト、ナビゲーション失敗、本文セレクタ未検出
2. 既定 `--retry=3`
3. バックオフ: 1s, 2s, 4s
4. 全失敗時は終了コード `1`
5. 部分成功（本文生成済みで未解決リンクあり）は終了コード `0`

## ファイル名長対策

1. `safe_title` は正規化し最大80文字
2. 超過時は `<truncated>_<law_id>.md`
3. 衝突時は `law_id` 優先で一意化

## テスト計画

### 単体テスト
1. DOM断片から条文構造抽出
2. `href` 正規化（内部/法令ページ/外部/未解決）
3. ファイル名正規化
4. 未解決重複判定

### フィクスチャテスト
1. `data/scrape_dumps/334AC0000000121/page.html` からMarkdown生成
2. 最低要件アサート:
- `第一条` を含む
- 内部アンカーリンクが1件以上
- フロントマター必須キーが揃う

### E2E（Docker）
1. `--law-id 334AC0000000121 --max-depth 1` で `laws/*.md` 生成
2. 同入力2回で出力安定（不要差分なし）

## 移行手順

1. Node/TS雛形（`package.json`, `tsconfig`, `src/`）整備
2. Docker実行基盤整備（Playwrightイメージ）
3. 辞書生成機能を実装（`--build-dictionary` で `/api/2/laws` から `data/law_dictionary.json` を構築）
4. 抽出・変換・出力を順に実装
5. 受け入れ基準を満たすまでRust CLIは併存
6. 基準達成後にRust CLI削除

Docker実行基盤の固定値:
1. `docker-compose.yml` のサービス名は `law-scraper`
2. ベースイメージは `mcr.microsoft.com/playwright:v1.58.2-jammy`（Ubuntu 22.04）
3. エントリポイントは `node dist/cli.js` とし、`docker compose run` から引数のみ渡す

## Rust削除の受け入れ基準

1. 特許法のE2Eが連続3回成功
2. Markdownの主要セクション欠落がない
3. 未解決ログが重複追記しない
4. Docker環境で再現可能

## 前提・運用制約

1. e-GovはSPAのためJS実行が必須
2. アクセスは直列実行を既定（過剰アクセス回避）
3. コメント規約・日本語記述は `AGENTS.md` に従う
