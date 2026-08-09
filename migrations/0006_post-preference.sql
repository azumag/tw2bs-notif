-- 配信開始時のBluesky通常ポストをユーザーごとに制御する。
-- 既存ユーザーの挙動を維持するため初期値はON。
ALTER TABLE users ADD COLUMN bsky_post_on_start INTEGER NOT NULL DEFAULT 1;
