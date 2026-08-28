# Bluesky OAuth 運用

orbsky は AT Protocol OAuth の **confidential client** として動作する。

## client authentication 鍵

- 初回の `/oauth-jwks.json` 取得または Bluesky 連携開始時に ES256 鍵を生成する。
- 秘密 JWK は `ENCRYPTION_KEY` で暗号化し、D1 の `bsky_oauth_client_keys` に保存する。
- 外部へ返すのは公開 JWK だけで、秘密値 `d` は返さない。
- `bsky_oauth_client_keys` の行を削除すると新しい鍵が生成され、既存OAuthセッションは再認証が必要になる。通常運用では削除しない。

## トークン更新の直列化

AT Protocol の refresh token はローテーション式で、一度使った値を並行して再利用できない。
`bsky_oauth_locks` のD1リースにより、同じDIDのセッション復元・更新を全Worker isolate間で直列化する。
Workerが途中終了した場合も、リースは45秒で引き継げる。

## 移行時の注意

公開クライアント時代に作成された既存セッションは、そのまま confidential client へ変換できない。
移行マイグレーションでは、Bluesky DIDとの紐付けを `bsky_connections` に残したうえで `reauth_required` に変更する。設定画面から一度Blueskyを再連携すれば、以後は confidential client の長期セッションになる。

OAuthセッションが失効・削除された場合も、`bsky_connections` の紐付けは消さず `reauth_required` と理由を記録する。利用者が明示的に「連携を解除」した場合だけ、紐付けとセッションの両方を削除する。

## 障害調査

直近の削除・失効理由は次で確認できる。

```sql
SELECT id, did, event_type, reason, created_at
FROM bsky_oauth_events
ORDER BY id DESC
LIMIT 50;
```

通常、`bsky_oauth_locks` は処理完了時に空になる。Workerが途中終了した場合は期限切れ行が残るが、次回取得時に自動で上書きされる。
