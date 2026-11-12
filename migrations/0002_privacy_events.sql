-- Additive migration: existing records and custom views remain intact.
-- Historical personal data is not removed by this migration.
ALTER TABLE analytics ADD COLUMN event_id TEXT;
ALTER TABLE analytics ADD COLUMN tracker_version INTEGER;
ALTER TABLE analytics ADD COLUMN device_source TEXT;
ALTER TABLE analytics ADD COLUMN viewport_class TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_event_id ON analytics (event_id);
ALTER TABLE analytics ADD COLUMN visitor_id TEXT;
ALTER TABLE analytics ADD COLUMN bot_name TEXT;
CREATE INDEX IF NOT EXISTS idx_analytics_visitor_ts ON analytics (visitor_id, ts);
CREATE TABLE IF NOT EXISTS visitors (
  visitor_id TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
