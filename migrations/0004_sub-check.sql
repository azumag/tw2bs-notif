-- Twitch サブスク判定のキャッシュ(twica と同方式)
ALTER TABLE users ADD COLUMN twitch_sub_verified_at TEXT;
ALTER TABLE users ADD COLUMN twitch_has_sub INTEGER;
ALTER TABLE users ADD COLUMN twitch_sub_check_disabled INTEGER NOT NULL DEFAULT 0;
