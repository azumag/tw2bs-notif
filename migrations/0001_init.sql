-- users: Twitch OAuth ログインしたユーザー
-- Bluesky OAuth セッション(PoC 確定の細粒度スコープ方式)も同じ行に保持する
CREATE TABLE users (
  twitch_user_id TEXT PRIMARY KEY,
  twitch_username TEXT NOT NULL,
  twitch_display_name TEXT NOT NULL,
  twitch_profile_image_url TEXT,
  -- Twitch OAuth トークン(暗号化して保存。平文では保存しない)
  twitch_access_token_enc TEXT,
  twitch_refresh_token_enc TEXT,
  twitch_token_expires_at INTEGER,
  twitch_scopes TEXT NOT NULL DEFAULT '[]',
  -- Bluesky OAuth セッション(JSON、暗号化。クライアントメタデータは
  -- repo:app.bsky.actor.status / repo:app.bsky.feed.post の細粒度スコープ)
  bsky_session_enc TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
