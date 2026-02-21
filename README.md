# e-gov-hourei-to-obsidian

e-Gov 法令検索の法令本文を取得し、Obsidian 向け Markdown (`laws/*.md`) を生成する CLI です。

## 標準実行は Docker

このプロジェクトは **Docker 実行を標準** とします。  
README の主手順はすべて Docker ベースです。

理由:

- 実行環境の差異を減らせる
- Playwright の依存をコンテナ側に閉じ込められる
- `laws/` / `data/` の権限管理を一貫化できる

## 前提

- Docker
- Docker Compose

`./law-scraper.sh` は内部で `HOST_UID/HOST_GID` を設定して `docker compose run` を呼び出します。

## 初回セットアップ（Docker）

### 1. 辞書を最初に作成する

法令名ベースのファイル名と参照解決精度を安定させるため、最初に `--build-dictionary` を実行します。

```bash
./law-scraper.sh --build-dictionary
```

生成先:

- `data/law_dictionary.json`

### 2. 本文を生成する

`law_id` 指定:

```bash
./law-scraper.sh --law-id 334AC0000000121
```

法令名指定:

```bash
./law-scraper.sh "特許法"
```

生成先:

- 法令ノート: `laws/*.md`
- 未解決参照ログ: `data/unresolved_refs.json`

## 日常運用（Docker）

### 既存ノートを活かして追記取得したい場合

```bash
./law-scraper.sh --law-id 334AC0000000121 --if-exists skip --max-depth 1
```

### 常に作り直したい場合

```bash
./law-scraper.sh --law-id 334AC0000000121 --if-exists overwrite
```

## オプション利用ガイド（Docker）

### `--dictionary-autoupdate`

**使うとよい場面**:

- 辞書を最近更新していない
- 深い参照先まで辿ると未知 `law_id` が多い
- `law_<id>.md` へのフォールバックを減らしたい

**使わなくてよい場面**:

- 事前に `--build-dictionary` 済みで運用している
- 実行時のAPI追加アクセスを避けたい

例:

```bash
./law-scraper.sh --law-id 334AC0000000121 --dictionary-autoupdate
```

### `--unresolved-path`

**使うとよい場面**:

- 実行ごとに未解決ログを分けたい
- CIや調査でログ衝突を避けたい

**既定でよい場面**:

- 通常運用で単一ログで十分

例:

```bash
./law-scraper.sh --law-id 334AC0000000121 --unresolved-path data/unresolved_refs_run_$(date +%Y%m%d).json
```

### `--dictionary`

辞書を用途別に分けたい場合に使用します。

```bash
./law-scraper.sh --law-id 334AC0000000121 --dictionary data/law_dictionary_custom.json
```

## テスト

```bash
/home/yuki/.local/share/mise/installs/pnpm/10.30.0/pnpm test
```

Docker E2E（2回実行して出力差分確認）:

```bash
/home/yuki/.local/share/mise/installs/pnpm/10.30.0/pnpm test:e2e:docker
```

## 補助ツール（`tools/`）

`tools/` は本体CLIのエントリポイントではなく、開発/検証用の補助スクリプト置き場です。

- `tools/e2e_docker.sh`
  - Dockerで同一入力を2回実行し、出力差分の有無を検証
- `tools/poc_fetch_law.mjs`
  - Playwrightで法令ページを取得し、PoC用ダンプを保存
- `tools/poc_fetch_law.ts`
  - 上記PoCのTypeScript版

## トラブルシュート（Docker）

### `law_<id>.md` の名前になる

辞書未作成/古い可能性があります。先に辞書を再生成してください。

```bash
./law-scraper.sh --build-dictionary
```

### `permission denied`（`laws/*.md`）

既存ファイルの所有権が異なる可能性があります。

```bash
sudo chown -R "$(id -u):$(id -g)" laws data
```

以降は `./law-scraper.sh ...` を使って実行してください。

### `ERR_PNPM_OUTDATED_LOCKFILE`

`package.json` と `pnpm-lock.yaml` の不整合です。

```bash
/home/yuki/.local/share/mise/installs/pnpm/10.30.0/pnpm install
```

### `page.evaluate: Target page, context or browser has been closed`

イメージ更新漏れがある可能性があります。`--build` を付けて再実行してください。

```bash
./law-scraper.sh --law-id 334AC0000000121
```

## 補足: ローカル実行（オプション）

Docker を使えない環境向けです。通常は Docker 実行を優先してください。

```bash
pnpm install
pnpm build
node dist/cli.js --build-dictionary
node dist/cli.js --law-id 334AC0000000121
```
