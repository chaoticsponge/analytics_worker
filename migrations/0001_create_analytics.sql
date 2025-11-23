-- Enable foreign key enforcement (good practice, even if not used yet)
PRAGMA foreign_keys = ON;

-- Core analytics events table
CREATE TABLE IF NOT EXISTS analytics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,               -- Unix ms timestamp
  type TEXT,                         -- e.g. 'page_view'
  path TEXT,                         -- path + query, e.g. /blog/post?x=1
  full_url TEXT,                     -- full URL
  referrer TEXT,                     -- document.referrer
  user_agent TEXT,                   -- raw UA string
  duration_ms INTEGER,               -- time on page
  scroll_pct INTEGER,                -- max scroll depth percentage 0–100
  session_id TEXT,                   -- client session identifier

  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,

  device_type TEXT,                  -- mobile / tablet / desktop
  device_os TEXT,                    -- macOS / Windows / iOS / Android / etc
  device_browser TEXT,               -- Chrome / Safari / Firefox / etc

  ip TEXT,                           -- cf-connecting-ip
  country TEXT,                      -- request.cf.country
  city TEXT,                         -- request.cf.city
  colo TEXT                          -- request.cf.colo (CF POP)
);

-- Helpful indexes for typical analytics queries

-- Time-based queries (latest events, time ranges, daily aggregates)
CREATE INDEX IF NOT EXISTS idx_analytics_ts
  ON analytics (ts);

-- Page-level aggregates (top pages, avg scroll/duration per path)
CREATE INDEX IF NOT EXISTS idx_analytics_path_ts
  ON analytics (path, ts);

-- Session-based queries (per-session behavior)
CREATE INDEX IF NOT EXISTS idx_analytics_session_id
  ON analytics (session_id, ts);

-- UTM breakdowns
CREATE INDEX IF NOT EXISTS idx_analytics_utm_source_medium_campaign
  ON analytics (utm_source, utm_medium, utm_campaign);

-- Geo queries (optional but useful)
CREATE INDEX IF NOT EXISTS idx_analytics_country_ts
  ON analytics (country, ts);
