# E2E 実地検証チェックリスト

実環境(デプロイ済み Worker + 実アカウント)での確認項目。1件ずつ実施し、結果をチェックする。

## 前提

- [ ] Worker がデプロイ済み
- [ ] シークレット設定済み(Twitch / Bluesky)
- [ ] `npm run setup` で subscription 登録済み(`npm run setup -- list` で stream.online / stream.offline が enabled であること)
- [ ] `npx wrangler tail` を起動したまま確認する

## 配信開始

- [ ] Twitch で配信を開始する
- [ ] 1分以内に Bluesky プロフィールに「配信中」バッジと twitch.tv リンクカードが表示される
- [ ] `wrangler tail` に `[info][stream] set live` が表示される
- [ ] プロフィールの embed が実際の配信 URL / 配信タイトルを指している

## 配信終了

- [ ] Twitch で配信を終了する
- [ ] 1分以内に Bluesky プロフィールからバッジが消える
- [ ] `wrangler tail` に `[info][stream] cleared live status` が表示される

## 冪等性

- [ ] 配信中に Twitch コンソールからテストイベントを再送しても二重設定されない(バッジは変化しない)
- [ ] 終了後にもう一度 offline イベントを送っても何も起きない(`offline without live state, skipped`)

## 長期配信(4時間超の対応)

- [ ] 配信開始から30分経過後に `wrangler tail` で `[info][stream] refreshed live status` が表示される
- [ ] 4時間以上配信し続けた場合もバッジが消えない

## 自己修復

- [ ] 配信中に KV の `stream:state:<自分のbroadcaster_user_id>` を削除しても、次の cron(30分以内)で復旧する
  - 例: `npx wrangler kv key delete "stream:state:123456789" --binding STATE`
- [ ] 配信終了済みなのに Bluesky のバッジが残っている状態でも、次の cron で消える

## 異常系

- [ ] 不正署名のリクエストを送ると 401 が返る(ログは `invalid signature` 系)
- [ ] セットアップ前(secret 未設定)は 500 が返る
  - 手順: KV の `twitch:webhook_secret` を一時削除(`npx wrangler kv key delete twitch:webhook_secret --binding STATE`)→ 適当な POST を送って 500 を確認 → 検証後に `npm run setup` で再作成

## 完了条件

- [ ] 上記すべてにチェックが入っている
- [ ] 結果(日時・ログの抜粋)を issue #9 にコメントとして追記する
