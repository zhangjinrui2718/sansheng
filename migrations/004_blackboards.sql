CREATE TABLE blackboards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  goal TEXT,
  plan_json TEXT NOT NULL DEFAULT '[]',
  todos_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  critique_json TEXT NOT NULL DEFAULT '[]',
  retrieved_memories_json TEXT NOT NULL DEFAULT '[]',
  decisions_json TEXT NOT NULL DEFAULT '[]',
  produced_artifacts_json TEXT NOT NULL DEFAULT '[]',
  ts INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  iteration INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_blackboards_conv ON blackboards(conversation_id, created_at DESC);
CREATE INDEX idx_blackboards_active ON blackboards(conversation_id, status);