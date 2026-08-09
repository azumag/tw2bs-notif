-- 自動ポスト設定をユーザー単位からチャンネル単位へ拡張する。
-- 既存連携は現在のユーザー設定を引き継ぐ。
ALTER TABLE connections ADD COLUMN post_on_start INTEGER NOT NULL DEFAULT 1;
ALTER TABLE connections ADD COLUMN post_template TEXT NOT NULL DEFAULT '配信開始しました
{title}
{category}';
ALTER TABLE connections ADD COLUMN post_include_title INTEGER NOT NULL DEFAULT 1;
ALTER TABLE connections ADD COLUMN post_include_category INTEGER NOT NULL DEFAULT 0;

UPDATE connections
SET post_on_start = COALESCE(
  (SELECT users.bsky_post_on_start
   FROM users
   WHERE users.twitch_user_id = connections.user_id),
  1
);
