-- C9-3(审查 §C9):补 IF NOT EXISTS ×3。
-- 重跑安全说明:已迁移库 schema_version 记录 version=4,runMigrations(集合判定)
-- 永不重放本文件 —— 本改动只影响「手工重放/异常半途库」形态:旧文件重放直接
-- throw "table blackboards already exists",新文件幂等跳过。不改列定义,
-- 对既有库零影响。
CREATE TABLE IF NOT EXISTS blackboards (
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
CREATE INDEX IF NOT EXISTS idx_blackboards_conv ON blackboards(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_blackboards_active ON blackboards(conversation_id, status);