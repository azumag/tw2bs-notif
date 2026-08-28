-- Bluesky OAuth の長期セッション化・競合防止・再認証状態の保持。
--
-- 既存の公開クライアント(token_endpoint_auth_method=none)で発行済みの
-- セッションは confidential client へ変換できないため、連携先の DID は残しつつ
-- reauth_required として移行する。利用者が一度再認証すると active に戻る。

CREATE TABLE bsky_connections (
  twitch_user_id TEXT PRIMARY KEY,
  did TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'reauth_required')),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO bsky_connections (
  twitch_user_id,
  did,
  status,
  reason,
  created_at,
  updated_at
)
SELECT
  twitch_user_id,
  did,
  'reauth_required',
  'oauth_client_upgraded',
  created_at,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM bsky_sessions
WHERE twitch_user_id <> '';

-- OAuth SDK の SessionStore は DID のみをキーとして扱う。
-- Twitch ユーザーとの紐付けは bsky_connections に分離する。
CREATE TABLE bsky_sessions_v2 (
  did TEXT PRIMARY KEY,
  session_json_enc TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO bsky_sessions_v2 (
  did,
  session_json_enc,
  created_at,
  updated_at
)
SELECT
  did,
  session_json_enc,
  created_at,
  updated_at
FROM bsky_sessions;

DROP TABLE bsky_sessions;
ALTER TABLE bsky_sessions_v2 RENAME TO bsky_sessions;

-- private_key_jwt 用の ES256 秘密鍵。値は ENCRYPTION_KEY で暗号化して保存する。
CREATE TABLE bsky_oauth_client_keys (
  key_name TEXT PRIMARY KEY,
  private_jwk_enc TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (key_name = 'primary')
);

-- refresh token のローテーション競合を防ぐ、D1 ベースの期限付き分散ロック。
CREATE TABLE bsky_oauth_locks (
  lock_name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

-- セッションが失効・削除された理由を追跡する監査ログ。
CREATE TABLE bsky_oauth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  did TEXT NOT NULL,
  event_type TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_bsky_oauth_events_did_created
  ON bsky_oauth_events (did, created_at DESC);
