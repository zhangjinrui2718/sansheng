-- conversations
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  cwd TEXT,
  model_id TEXT,
  provider TEXT,
  message_count INTEGER DEFAULT 0,
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cost_usd REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conversations_last_active ON conversations(last_active_at DESC);

-- messages
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  content TEXT NOT NULL,
  tool_calls TEXT,
  thinking TEXT,
  usage_input INTEGER DEFAULT 0,
  usage_output INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv_turn ON messages(conversation_id, turn_index, created_at);

-- fragments
CREATE TABLE IF NOT EXISTS fragments (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('fact','preference','project','context','summary')),
  content TEXT NOT NULL,
  source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  importance REAL DEFAULT 0.5,
  decay_factor REAL DEFAULT 0.95,
  access_count INTEGER DEFAULT 0,
  last_accessed_at INTEGER,
  created_at INTEGER NOT NULL,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_fragments_priority ON fragments((importance * (1 + access_count)) DESC, last_accessed_at DESC);

-- user_profile
CREATE TABLE IF NOT EXISTS user_profile (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  observed_at INTEGER NOT NULL,
  last_reinforced_at INTEGER,
  evidence_count INTEGER DEFAULT 1,
  metadata TEXT
);