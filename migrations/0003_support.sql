-- サポートコード(twica と共通仕様: コード文字列 → sha256 で保存・照合)
CREATE TABLE support_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  plan_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  memo TEXT NOT NULL DEFAULT '',
  activation_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ユーザーへのライセンス付与(一度きり)
CREATE TABLE user_licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  code_id INTEGER NOT NULL,
  plan_type TEXT NOT NULL,
  fanbox_id TEXT,
  activated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, code_id)
);

CREATE INDEX idx_user_licenses_user ON user_licenses (user_id);
CREATE INDEX idx_user_licenses_code ON user_licenses (code_id);
