# tw2bs-notif

Twitch の配信開始/終了を EventSub Webhook で検知し、Bluesky の streaming status(`app.bsky.actor.status#live`)に自動反映する Cloudflare Workers アプリケーション。

## 構成

- [Cloudflare Workers](https://developers.cloudflare.com/workers/) + TypeScript
- Twitch EventSub(Webhook トランスポート): `stream.online` / `stream.offline`
- Bluesky: `com.atproto.repo.putRecord` で `app.bsky.actor.status`(rkey: `self`)を書き込み/削除
- KV(`STATE`): イベント重複排除と状態管理

## 開発

```bash
npm install
npm run dev        # wrangler dev
npm run typecheck  # tsc --noEmit
npm test           # vitest(Workers ランタイム上で実行)
```

### ローカル開発(.dev.vars)

シークレットを `.dev.vars` に置くと `wrangler dev` が読み込む(commit 禁止。`.gitignore` 済み):

```bash
cp .dev.vars.example .dev.vars
# .dev.vars に実値を記入してから:
npm run dev
```

注意: EventSub Webhook は Twitch から public URL への送信のため、ローカルの `wrangler dev` 宛には届かない。Webhook ハンドラのローカル検証は `npm test` の統合テスト(API スタブ)を使う。実機での通し確認は「動作確認」の手順で行う。

### KV namespace のセットアップ(初回のみ)

`wrangler.jsonc` の KV id はプレースホルダのまま。

```bash
npx wrangler kv namespace create STATE          # 本番 id を取得
npx wrangler kv namespace create STATE --preview # プレビュー id を取得
```

取得した id を `wrangler.jsonc` の `id` / `preview_id` に書き、設定変更後に再実行する:

```bash
npx wrangler types   # worker-configuration.d.ts を再生成
```

## セットアップ手順

### 1. Twitch Developer アプリの登録

1. https://dev.twitch.tv/console/apps でアプリを登録
   - OAuth リダイレクト URL は空欄で OK
2. Client ID / Client Secret を控える
3. チャンネルの user id を調べる(例: `https://api.twitch.tv/helix/users?login=<チャンネル名>` を `Client-ID` ヘッダ付きで叩く)

### 2. Bluesky アプリパスワード

Bluesky の設定 → プライバシーとセキュリティ → アプリパスワードから作成。

### 3. シークレットの設定

```bash
npx wrangler secret put TWITCH_CLIENT_ID
npx wrangler secret put TWITCH_CLIENT_SECRET
npx wrangler secret put TWITCH_BROADCASTER_ID
npx wrangler secret put BSKY_HANDLE
npx wrangler secret put BSKY_APP_PASSWORD
```

### 4. デプロイと購読

前提: 上記「KV namespace のセットアップ」で `wrangler.jsonc` の KV id を実値化済み、`wrangler login` 済みであること。

```bash
npm run deploy
CALLBACK_URL="https://tw2bs-notif.<あなたのアカウント>.workers.dev/twitch/eventsub" \
TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=... TWITCH_BROADCASTER_ID=... \
npm run setup
```

- workers.dev サブドメインが無いアカウントでは、Cloudflare ダッシュボードでカスタムドメインを設定し、その URL(`https://<ドメイン>/twitch/eventsub`)を CALLBACK_URL に使う(Twitch は HTTPS のみ許可)
- webhook secret は自動生成され KV(`twitch:webhook_secret`)に保存される。**2回目以降の実行では KV の既存 secret を再利用する**(再生成すると既存購読の署名検証が壊れるため)
- 既に購読済みの場合は `[skip]` と表示され、重複登録されない。callback URL が変わっている場合は自動で作り直される
- 購読一覧: `npm run setup -- list` / 削除: `npm run setup -- delete <id>`
- Twitch コンソール(dev.twitch.tv)の EventSub 一覧でも確認できる

### 5. 動作確認

```bash
npx wrangler tail   # ログ確認(配信開始時に [info][stream] set live が表示される)
```

- **配信開始**: Twitch で配信を開始 → 1分以内に Bluesky プロフィール(azumag.bsky.social 等)に「配信中」バッジ + twitch.tv リンクカードが表示される
- **配信開始投稿**: 既定で **「配信開始しました: <タイトル>」の通常投稿**もタイムラインに自動作成される(`BSKY_POST_ON_START` フラグ)
- **配信終了**: バッジが消える(投稿は残る)
- **ロング配信(4時間超)**: cron(30分毎)が record を再書き込みするためバッジが継続する
- ログ判別: `[info]` / `[error]` プレフィックスで成功・失敗が判別できる

#### 配信開始投稿を OFF にする

`wrangler.jsonc` の `vars` から `BSKY_POST_ON_START` 行を**削除**する(「false」に書き換えでは型エラーになる):

```bash
# wrangler.jsonc から BSKY_POST_ON_START を削除
npx wrangler types   # 型を再生成
npm run typecheck
npm run deploy
```

## 進捗

実装は GitHub Issues で管理している。https://github.com/azumag/tw2bs-notif/issues
