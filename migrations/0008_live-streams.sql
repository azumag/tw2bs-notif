-- 配信中のチャネルだけを保持するテーブル。
-- 配信状態は KV に置いていたが、KV は結果整合のため
-- online 直後の offline を取りこぼす余地があった。
-- 更新チェーンの重複排除にも使うため、強整合な D1 へ移す。
CREATE TABLE live_streams (
  twitch_channel_id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  started_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
