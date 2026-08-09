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

## 自動ポスト設定(配信操作なしで確認可能)

- [ ] `/channels` の連携済みチャネルごとに「配信開始時にBlueskyへポストする」が表示される
- [ ] チェックを外して保存するとOFFのまま再読み込み後も維持される
- [ ] チェックを戻して保存するとONのまま再読み込み後も維持される
- [ ] 本文へ `{title}` / `{category}` / `{channel}` / `{url}` を入力して保存でき、再読み込み後も維持される
- [ ] 「配信タイトル」「カテゴリ」のチェックを個別に保存できる
- [ ] 複数連携がある場合、一方の設定変更が他方へ影響しない
- [ ] 特典未加入でも同じ設定を変更できる

## 配信終了

- [ ] Twitch で配信を終了する
- [ ] 1分以内に Bluesky プロフィールからバッジが消える
- [ ] `wrangler tail` に `[info][stream] cleared live status` が表示される

## 冪等性

- [ ] 配信中に Twitch コンソールからテストイベントを再送しても二重設定されない(バッジは変化しない)
- [ ] 終了後にもう一度 offline イベントを送っても何も起きない(`offline without live record, skipped`)

## 長期配信(4時間超の対応)

- [ ] 配信開始直後に `wrangler tail` で `[info][stream] scheduled badge renewal` が出て、`delaySeconds` が 10800〜12600 の範囲にある
- [ ] 3〜3.5時間後に `[info][stream] renewed live status` が出て、次の延長がまた予約される
- [ ] 4時間以上配信し続けた場合もバッジが消えない

## 配信中の記録(D1)

- [ ] 配信開始後、`live_streams` に自分のチャネルの行がある
  - 例: `npx wrangler d1 execute tw2bs-notif-db --remote --command "SELECT * FROM live_streams"`
- [ ] 配信終了後、その行が消えている
- [ ] 延長メッセージが届いた時点で既に配信が終わっていた場合、バッジは消さず `stream not live at renewal, left to expire` が出る(4時間で自然失効する)

## 異常系

- [ ] 不正署名のリクエストを送ると 401 が返る(ログは `invalid signature` 系)
- [ ] セットアップ前(secret 未設定)は 500 が返る
  - 手順: KV の `twitch:webhook_secret` を一時削除(`npx wrangler kv key delete twitch:webhook_secret --binding STATE`)→ 適当な POST を送って 500 を確認 → 検証後に `npm run setup` で再作成

## 完了条件

- [ ] 上記すべてにチェックが入っている
- [ ] 結果(日時・ログの抜粋)を issue #9 にコメントとして追記する
