# Bluesky OAuth 細粒度スコープ PoC 結果

検証日: 2026-08-09
アカウント: azumag.bsky.social (did:plc:dekk6rd3sp52ocea6qmalxm2)
実装: `poc/bsky-oauth/poc.mjs`(@atproto/oauth-client-node)

## 結論

**bsky.social は atproto OAuth の細粒度スコープをサポートしており、スコープ外の操作はサーバー側で拒否される。**
→ SaaS の Bluesky 認証方式は **OAuth(限定スコープの refresh token のみ保管)** が本命。アプリパスワード方式は不要。

## 検証結果

### 実行A: `atproto repo:app.bsky.actor.status` のみ

| 項目 | 結果 |
|---|---|
| PAR(認可リクエスト) | ✅ 受理 |
| 付与スコープ | `atproto repo:app.bsky.actor.status` |
| status record 書き込み(`putRecord app.bsky.actor.status`) | ✅ **200** |
| feed post 作成(`createRecord app.bsky.feed.post`) | ❌ **403 ScopeMissingError** `Missing required scope "repo:app.bsky.feed.post?action=create"` |
| クリーンアップ(deleteRecord) | ✅ 200 |

### 実行B: `atproto repo:app.bsky.actor.status repo:app.bsky.feed.post`

| 項目 | 結果 |
|---|---|
| 付与スコープ | 両スコープ |
| status record 書き込み | ✅ 200 |
| feed post 作成 | ✅ 200 |
| クリーンアップ | ✅ 200(テスト投稿・ステータスとも削除済み) |

## 判明した仕様・注意点

1. **localhost 仮想クライアントは bsky.social では不可**: `client_id: http://localhost` は PAR は通るが、認可 UI がログイン後に 404 になる(実測)。**公開 HTTPS のクライアントメタデータ URL が必須**(PoC では cloudflared トンネルで対応)。
2. **AS のスコープ検証はクライアントメタデータの `scope` 宣言と照合**: メタデータに未宣言の既知スコープ(`transition:generic` 等)は PAR で `invalid_scope`。細粒度スコープは「未知」扱いで PAR は通るが、認可後に UI 側で処理される。**実運用ではメタデータの `scope` に要求しうる全スコープを宣言すること**。
3. **スコープ文字列の形式**: `repo:app.bsky.feed.post?action=create` のように `?action=` パラメータがエラーメッセージに現れた。付与・検証は collection 単位で機能。
4. SDK: `@atproto/oauth-client-node` 0.5.3。NodeOAuthClient には `stateStore`/`sessionStore`/`dpopStore`(SimpleStore 実装)が必須。
5. 認可 UI でのスコープ表示は、翻訳されない生のスコープ文字列がユーザーに見える(要確認だが、SSR で `repo:app.bsky.actor.status` のまま表示された可能性が高い)。

## SaaS 設計への反映

- **users テーブルに保存するのは OAuth session(refresh token + DPoP 鍵)**。漏れても status/post 書き込みに限定される
- 要求スコープ: `atproto repo:app.bsky.actor.status repo:app.bsky.feed.post`(自動ポスト有効ユーザーは post 込み、バッジのみは status のみ等、ユーザーごとに切替可能)
- クライアントメタデータは SaaS の公開 URL(`https://<domain>/oauth-client-metadata.json`)で公開
- トークンリフレッシュは @atproto/oauth-client-node の `restore()` で管理(セッションは D1 に永続化)

## 関連リンク

- 仕様: https://atproto.com/specs/permission (細粒度スコープ)
- SDK: https://www.npmjs.com/package/@atproto/oauth-client-node
