-- Twitch channel.update を使ったタイトル/カテゴリ変更共有設定。
ALTER TABLE connections ADD COLUMN title_change_action TEXT NOT NULL DEFAULT 'off';
ALTER TABLE connections ADD COLUMN category_change_action TEXT NOT NULL DEFAULT 'off';
ALTER TABLE connections ADD COLUMN metadata_coalesce_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE connections ADD COLUMN metadata_coalesce_minutes INTEGER NOT NULL DEFAULT 2;
ALTER TABLE connections ADD COLUMN title_change_template TEXT NOT NULL DEFAULT '配信タイトルを変更しました
{title}
{category}';
ALTER TABLE connections ADD COLUMN category_change_template TEXT NOT NULL DEFAULT '配信カテゴリを変更しました
{title}
{category}';
ALTER TABLE connections ADD COLUMN combined_change_template TEXT NOT NULL DEFAULT '配信情報を更新しました
{title}
{category}';

CREATE TABLE channel_metadata (
  twitch_channel_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE pending_metadata_posts (
  connection_id INTEGER PRIMARY KEY,
  token TEXT NOT NULL,
  title_changed INTEGER NOT NULL DEFAULT 0,
  category_changed INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
);
