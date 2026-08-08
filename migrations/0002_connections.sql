-- ユーザーとTwitchチャンネルの連携
CREATE TABLE connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  twitch_channel_id TEXT NOT NULL,
  twitch_login TEXT NOT NULL,
  twitch_display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, twitch_channel_id)
);

CREATE INDEX idx_connections_user ON connections (user_id);
CREATE INDEX idx_connections_channel ON connections (twitch_channel_id);
