-- Bluesky OAuth セッション(ユーザー別、細粒度スコープ: status + feed.post)
CREATE TABLE bsky_sessions (
  did TEXT PRIMARY KEY,
  twitch_user_id TEXT NOT NULL UNIQUE,
  session_json_enc TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
