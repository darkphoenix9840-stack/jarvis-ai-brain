-- J.A.R.V.I.S. device-scoped long-term memory
-- Apply this migration to the existing jarvis-memory D1 database before enabling memory APIs.

CREATE TABLE IF NOT EXISTS user_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  memory_key TEXT NOT NULL,
  memory_value TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  source TEXT NOT NULL DEFAULT 'user_approved',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (device_id, memory_key)
);

CREATE INDEX IF NOT EXISTS idx_user_memories_device_updated
  ON user_memories (device_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS memory_settings (
  device_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
