-- M3a · agent_states table
-- 会话恢复:每个 conversation 对应一行 Pi agent state metadata
-- 当前只存 cwd/model/provider/lastActiveAt + state_json (轻量 JSON);
-- 真正的上下文重放在 kernel.resume() 里靠 replay messages 完成。
CREATE TABLE IF NOT EXISTS agent_states (
  conversation_id TEXT PRIMARY KEY,
  cwd TEXT,
  model_id TEXT,
  provider TEXT,
  state_json TEXT,
  last_active_at INTEGER,
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_agent_states_last_active ON agent_states(last_active_at);