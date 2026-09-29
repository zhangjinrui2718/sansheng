-- M3+ B1: BlackboardArtifact v3 storage
--   - blackboards 表加 artifacts_json 列 TEXT nullable DEFAULT '[]'
--   - additive only — 旧 rows 仍可读;legacy `produced_artifacts_json` / `decisions_json`
--     保留(读时由 storage 层 best-effort 升级到 artifacts_json)。
ALTER TABLE blackboards ADD COLUMN artifacts_json TEXT DEFAULT '[]';

-- 索引用于加速按 scope/kind/status 过滤(SQLite json_each 不能用 index,
-- 但至少 conversation_id 仍是常见过滤维度)。
CREATE INDEX IF NOT EXISTS idx_blackboards_artifacts_conv
  ON blackboards(conversation_id);