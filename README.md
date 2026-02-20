# e-gov-jobun-to-obsidian

e-Gov 法令検索の法令本文を取得し、Obsidian 向け Markdown (`laws/*.md`) を生成する CLI です。

## 前提

- Node.js 20+
- pnpm (`/home/yuki/.local/share/mise/installs/pnpm/10.30.0/pnpm`)
- Docker / Docker Compose（Docker実行時）

## ローカル実行

1. 依存インストール

```bash
/home/yuki/.local/share/mise/installs/pnpm/10.30.0/pnpm install
```

2. ビルド

```bash
/home/yuki/.local/share/mise/installs/pnpm/10.30.0/pnpm build
```

3. 実行（law_id 指定）

```bash
node dist/cli.js --law-id 334AC0000000121
```

4. 実行（法令名指定）

```bash
node dist/cli.js "特許法"
```

## Docker実行

`laws/` と `data/` をホストユーザー権限で作成・更新するため、`HOST_UID/HOST_GID` を渡して実行します。

```bash
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose run --build --rm law-scraper --law-id 334AC0000000121
```

法令名指定:

```bash
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose run --build --rm law-scraper "特許法"
```

## 辞書の作成

法令名ベースのファイル名・リンク解決精度のために、先に辞書を作ることを推奨します。

```bash
node dist/cli.js --build-dictionary
```

Docker:

```bash
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose run --build --rm law-scraper --build-dictionary
```

## 主なオプション

- `--law-id <id>`: ルート法令ID指定
- `<法令名>`: ルート法令名指定
- `--max-depth <n>`: 参照先法令の再帰深さ（既定 `1`）
- `--if-exists overwrite|skip`: 既存ノートの扱い
- `--build-dictionary`: `data/law_dictionary.json` を再生成
- `--dictionary <path>`: 辞書ファイルパス
- `--dictionary-autoupdate`: 未知 `law_id` をAPI照会して辞書追記
- `--unresolved-path <path>`: 未解決参照ログ出力先

## テスト

```bash
/home/yuki/.local/share/mise/installs/pnpm/10.30.0/pnpm test
```

Docker E2E（2回実行して出力差分確認）:

```bash
/home/yuki/.local/share/mise/installs/pnpm/10.30.0/pnpm test:e2e:docker
```

## 出力

- 法令ノート: `laws/*.md`
- 辞書: `data/law_dictionary.json`
- 未解決参照: `data/unresolved_refs.json`

## よくあるエラー

### `ERR_PNPM_OUTDATED_LOCKFILE`

`package.json` と `pnpm-lock.yaml` の不整合です。

```bash
/home/yuki/.local/share/mise/installs/pnpm/10.30.0/pnpm install
```

### `permission denied`（`laws/*.md`）

既存ファイルの所有権が異なる可能性があります。

```bash
sudo chown -R "$(id -u):$(id -g)" laws data
```

その後、Docker実行時に `HOST_UID/HOST_GID` を渡してください。
