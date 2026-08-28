-- Bluesky OAuth の長期セッション対応。
--
-- 1. ユーザーと Bluesky DID の紐付けを OAuth セッションから分離する。
--    SDK が失効セッションを削除しても、再認証が必要なことを表示・記録できる。
-- 2. 既存セッションは public client (token_endpoint_auth_method=none) で発行済みのため、
--    confidential client へ切り替えるには一度だけ再認証が必要。
-- 3. confidential client の ES256 秘密鍵、分散リースロック、監査イベントを保存する。

CREATE TABLE bsky_connections (
  twitch_user_id TEXT PRIMARY KEY,
  did TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'reauth_required')),
  reason TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 既存トークンを confidential client のトークンへ変換することはできないため、
-- DID の紐付けは残しつつ再認証待ちにする。
INSERT OR IGNORE INTO bsky_connections
  (twitch_user_id, did, status, reason, updated_at)
SELECT
  bs.twitch_user_id,
  bs.did,
  'reauth_required',
  'OAuthクライアントの長期セッション対応に伴い、再連携が必要です。',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM bsky_sessions bs
JOIN users u ON u.twitch_user_id = bs.twitch_user_id
WHERE bs.twitch_user_id <> '';

-- セッションとユーザー紐付けの正本は bsky_connections へ移す。
-- デプロイは migration → Worker の順なので、旧Workerが短時間動いても壊れないよう
-- twitch_user_id 列は互換用として nullable・非UNIQUEで残す。新Workerは読み書きしない。
-- nullable にすることで、新Workerの未紐付けセッション同士も衝突しない。
CREATE TABLE bsky_sessions_v2 (
  did TEXT PRIMARY KEY,
  twitch_user_id TEXT,
  session_json_enc TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO bsky_sessions_v2
  (did, twitch_user_id, session_json_enc, created_at, updated_at)
SELECT did, twitch_user_id, session_json_enc, created_at, updated_at
FROM bsky_sessions;

DROP TABLE bsky_sessions;
ALTER TABLE bsky_sessions_v2 RENAME TO bsky_sessions;

CREATE TABLE bsky_oauth_client_keys (
  key_name TEXT PRIMARY KEY,
  private_jwk_enc TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE bsky_oauth_locks (
  lock_name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE TABLE bsky_oauth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  did TEXT NOT NULL,
  event_type TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_bsky_oauth_events_did_created
  ON bsky_oauth_events (did, created_at DESC);
