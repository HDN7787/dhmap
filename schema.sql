CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  slug        TEXT NOT NULL UNIQUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO categories (id, name, slug, sort_order) VALUES
(1, '小说', 'novel', 1),
(2, '影视', 'movie', 2),
(3, '音乐', 'music', 3),
(4, '游戏', 'game', 4),
(5, '工具', 'tool', 5),
(6, '新闻', 'news', 6),
(7, '其他', 'other', 7);

CREATE TABLE IF NOT EXISTS sites (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  url                 TEXT NOT NULL,
  registrable_domain  TEXT NOT NULL UNIQUE,
  title               TEXT NOT NULL DEFAULT '',
  description         TEXT NOT NULL DEFAULT '',
  category_id         INTEGER NOT NULL REFERENCES categories(id),
  favicon_url         TEXT DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'active',
  click_rank_24h      INTEGER NOT NULL DEFAULT 0,
  click_rank_7d       INTEGER NOT NULL DEFAULT 0,
  published_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sites_category ON sites(category_id, status);

CREATE TABLE IF NOT EXISTS click_rankings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id       INTEGER NOT NULL REFERENCES sites(id),
  window        TEXT NOT NULL,
  rank          INTEGER NOT NULL,
  click_count   INTEGER NOT NULL,
  snapshot_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_click_rankings_window ON click_rankings(window, rank);

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  display_name    TEXT NOT NULL DEFAULT '',
  role            TEXT NOT NULL DEFAULT 'user',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 投稿表
CREATE TABLE IF NOT EXISTS submissions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  url               TEXT NOT NULL,
  registrable_domain TEXT NOT NULL,
  title             TEXT NOT NULL DEFAULT '',
  description       TEXT NOT NULL DEFAULT '',
  category_id       INTEGER NOT NULL REFERENCES categories(id),
  status            TEXT NOT NULL DEFAULT 'pending',
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);