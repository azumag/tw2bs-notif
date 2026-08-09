# orbsky

Twitch 配信開始を EventSub で検知し、Bluesky の streaming status(`app.bsky.actor.status#live`)と通常投稿に自動反映するサービス。

- アプリ: Cloudflare Workers(`orbsky`)+ D1 + KV + Workers Queue
- ドメイン: https://orbsky.bluemoon.works
- リポジトリ: azumag/tw2bs-notif(名称は tw2bs-notif のまま)

## 機能

- Twitch アカウントでログイン
- 機能概要・使い方(/guide): ログイン前から、初期設定・自動ポスト変数・無料／特典の違いを確認可能
- チャンネル連携(/channels): 自分のチャンネルを登録 → 配信開始/終了を Bluesky に反映
  - 配信中バッジ + twitch.tv リンクカード(embed)
  - 配信開始時の通常ポストは `/channels` でチャンネルごとにON/OFF可能(全プラン、デフォルトON)
  - ポスト本文は `{title}` / `{category}` / `{channel}` / `{url}` を使ってチャンネルごとにカスタマイズ可能
  - `BSKY_POST_ON_START` は運用上の全体スイッチ
  - 4時間超の配信は cron(30分毎)が record を再書き込みして継続
- 特典(/support): FANBOX サポートコード or Twitch サブスク(azumagbanjo)で複数チャンネル連携が解放
  - サポートコードの取得先: [azumagのFANBOX](https://azumag.fanbox.cc/)
  - サポートコードは別サービス [twica](https://twica.bluemoon.works/plans) と共通
  - 特典有効化後は `/channels` の「マルチチャンネル設定」から、管理している別チャンネルをTwitchユーザー名で追加

## 開発

```bash
npm install
npm run dev        # wrangler dev(.dev.vars からシークレット)
npm run typecheck  # tsc --noEmit
npm test           # vitest(Workers ランタイム上で実行)
```

テストは `test/migrations.ts` で D1 スキーマを適用して実行する。

## デプロイ・運用

- デプロイ: `npm run deploy`(シークレットは `.dev.vars` から `--secrets-file` で供給)
- 運用詳細: [docs/OPERATIONS.md](docs/OPERATIONS.md)
- Bluesky OAuth PoC(ユーザー別 OAuth 方式の検証): [docs/bluesky-oauth-poc.md](docs/bluesky-oauth-poc.md)
- 実地検証チェックリスト: [docs/E2E-CHECKLIST.md](docs/E2E-CHECKLIST.md)

## 進捗

実装は GitHub Issues で管理している。https://github.com/azumag/tw2bs-notif/issues
