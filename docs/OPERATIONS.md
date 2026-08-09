# orbsky 運用ドキュメント

Twitch 配信開始 → Bluesky streaming status / 自動投稿 連携サービス。

## 構成

```
Twitch EventSub (stream.online/offline)
  → Cloudflare Workers "orbsky" (/twitch/eventsub)
  → Workers Queue (eventsub-events)
  → Queue consumer → processStreamEvent(connections ベース)
  → Bluesky (status record / 投稿)
cron (30分毎) → refreshStreamStatus(全連携チャンネルをバッチポーリング、自己修復)
```

- ストレージ: KV(STATE: セッション/状態/webhook secret)、D1(tw2bs-notif-db: users/connections/support_codes/user_licenses)
- 認証: Twitch OAuth ログイン(user:read:email + user:read:subscriptions)、セッションは HttpOnly Cookie + CSRF
- Bluesky 連携: 現状サービス共通の資格情報(BSKY_HANDLE / BSKY_APP_PASSWORD)。ユーザー別 Bluesky OAuth は将来対応(PoC 済み: docs/bluesky-oauth-poc.md)

## 特典システム

| プラン | 連携チャンネル数 |
|---|---|
| 無料 | 1チャンネル |
| 特典(Fanbox サポートコード OR azumagbanjo への Twitch サブスク) | 複数 |

- 特典失効後も既存連携は動作継続(新規追加のみ制限)
- サブスク判定は 1時間キャッシュ(手動「再確認」で更新可)
- 配信開始時の通常ポストは全プランでチャンネルごとに設定可能(`/channels`、デフォルトON)
- 本文は `{title}` / `{category}` / `{channel}` / `{url}` を使って自由に構成できる。テンプレートに書いた変数だけが展開される(個別のON/OFFスイッチは無い)
- `BSKY_POST_ON_START` は自動ポスト全体の運用スイッチ。チャンネル設定がONでも、この値が `true` でない場合は投稿しない

### サポートコードの発行手順

コードは「文字列 → sha256 ハッシュ」で D1 に保存する(平文は保存しない)。

```bash
CODE="XXXX-XXXX-XXXX"   # 配布するコード文字列
HASH=$(python3 -c "import hashlib; print(hashlib.sha256('$CODE'.encode()).hexdigest())")
npx wrangler d1 execute tw2bs-notif-db --remote --command \
  "INSERT INTO support_codes (code_hash, plan_type, memo) VALUES ('$HASH', 'support', 'Fanbox 8月号')"
```

- `plan_type`: `support` / `patron`(patron が上位。上位コードで下位ライセンスは置換)
- サポートコードは別サービス [twica](https://twica.bluemoon.works/plans) と共通
- 同じコードは複数ユーザーが使用可能(各ユーザー1回)。`activation_count` で使用数が分かる
- 無効化: `UPDATE support_codes SET status = 'inactive' WHERE code_hash = '<hash>'`
- 一覧: `SELECT memo, plan_type, status, activation_count FROM support_codes`

## デプロイ

```bash
npm run deploy          # 手動デプロイ(シークレットは .dev.vars から)
npm run setup           # ※旧単一テナント用。現在は UI の連携フロー(/channels)を使用すること
```

### CI/CD(Workers Builds)

GitHub の `main` ブランチへの push で自動デプロイされる(Workers Builds)。

- build: `npm ci` / deploy: `npx wrangler deploy`
- 設定場所: Cloudflare ダッシュボード → Workers & Pages → orbsky → Settings → Builds
- 本番ブランチ(main)以外への push はプレビュー版(`wrangler versions upload`)が作られる
- GitHub Actions は typecheck + test のみ(デプロイはしない)

シークレット(`wrangler secret put`):

| 名前 | 内容 |
|---|---|
| TWITCH_CLIENT_ID | Twitch アプリ tw2bsky の Client ID |
| TWITCH_CLIENT_SECRET | 同上 Secret |
| TWITCH_BROADCASTER_ID | サブスク判定対象チャンネル(azumagbanjo = 130871908) |
| BSKY_HANDLE / BSKY_APP_PASSWORD | Bluesky 資格情報(サービス共通) |
| ENCRYPTION_KEY | トークン暗号化キー(32バイト hex) |

D1 migration:

```bash
npx wrangler d1 migrations apply tw2bs-notif-db --remote
```

## 監視・トラブルシューティング

- `npx wrangler tail orbsky` — リアルタイムログ(`[info]` / `[error]` プレフィックス)
- 配信開始が反映されない場合:
  1. `npm run setup -- list`(または Twitch コンソール)で購読が enabled か確認
  2. チャンネルが connections に登録されているか(DB: `SELECT * FROM connections`)
  3. `wrangler tail` で `ignored unknown channel` が出ていないか
- EventSub 購読は連携フロー(/channels)で自動作成・削除される。手動購読は不要
- 4時間超の配信: cron(30分毎)が record を再書き込みしてバッジを維持
