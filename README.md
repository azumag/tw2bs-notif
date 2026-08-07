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

## 進捗

実装は GitHub Issues で管理している。https://github.com/azumag/tw2bs-notif/issues
