-- 009 · BC2 Collaboration(conversations / messages / asks / meetings)
--
-- 仍**只做加法**。
--
-- ── 这一批要保住的是 7-L 升级链 ───────────────────────────────────
--
-- AGENTS.md 记着 7-L 的三条约束。它们在**新模型下的形态**是:
--
-- ① **提问必须带 hypothesis 全文** —— 旧事故:payload 只有一句
--    `Executor needs help (judgment) for todo xxx`,判断轮连问题是什么都不知道,
--    只能全推给用户。这里落成 **CHECK 约束**(非空),不是靠调用方自觉。
--
-- ② **升级时改挂,不留两条活问** —— 旧事故:`onEscalate` 没把
--    `pendingExecutorCallbacks` 改挂到新 id,一次迟到的 cancel 能再杀一遍已恢复的
--    executor。这里落成 **parent_ask_id + escalated 状态**:升级时父问转 escalated
--    并建子问;子问被答,沿 parent 链回填,原始提问者才解除 blocked。
--    **任何时刻一条链上只有一个「活的」问题。**
--
-- ③ 判断轮卫生闸门 —— 旧模型里判断轮是一次独立的 LLM 补全(`makeWorkerAskAdjudicate`),
--    所以有 `SANSHENG_WORKER_ASK=0` 这个开关。新模型里「判断」是目标 agent 的
--    **正常回合**(它读 ask_list 然后决定 answer 还是 escalate),不再有独立调用点,
--    因此这个开关随之消失 —— 不是被删掉,是没有对应物了。

-- ── 会话 ────────────────────────────────────────────────────────
-- 对话是**项目的会话**,不是项目的边界。工件按 project 归属,session 只是
-- 来源线索 —— 所以 artifacts.conversation_id 刻意不加外键:工件必须比会话活得久。
--
-- ⚠️ **表名刻意不叫 conversations / messages** —— 001 已经建过这两个名字,
-- 而 `CREATE TABLE IF NOT EXISTS` 撞名时**静默无操作**:新表根本不会建出来,
-- 后面的索引会以一个没有 project_id 列的旧表为目标而报
-- 「no such column: project_id」。这类失败不报在撞名处,报在下游,极难归因。
-- tests/platform/migrations.test.ts 有一条不变量专门守这个。
CREATE TABLE IF NOT EXISTS project_sessions (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_sessions_project
  ON project_sessions(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS session_messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
  -- NULL = 甲方(用户)说的话。用户不是 agents 表里的角色,所以这里可空。
  agent_id   TEXT REFERENCES agents(id),
  kind       TEXT NOT NULL CHECK (kind IN ('user', 'assistant', 'thinking', 'tool', 'system')),
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_messages ON session_messages(session_id, created_at);

-- ── 提问与升级 ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS asks (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_agent_id TEXT NOT NULL REFERENCES agents(id),
  to_agent_id   TEXT NOT NULL REFERENCES agents(id),
  -- 升级链:这条问是从哪条升级上来的。NULL = 链首(直接由某个 agent 发起)。
  parent_ask_id TEXT REFERENCES asks(id) ON DELETE SET NULL,
  question    TEXT NOT NULL,
  -- 7-L 约束①:**hypothesis 是必填**,不是可选。判断轮没有它无从判断,
  -- 于是只能把问题原样推给用户 —— 那正是 7-L 要消灭的行为。
  hypothesis  TEXT NOT NULL CHECK (length(trim(hypothesis)) > 0),
  options_json TEXT,
  needs       TEXT,
  status      TEXT NOT NULL CHECK (status IN (
                'open', 'answered', 'escalated', 'cancelled', 'expired')),
  created_at  INTEGER NOT NULL,
  -- 超时由调用方(调度器/巡检)判定,这里只存截止时间。没有它,提问者可能
  -- 永久停在 blocked —— 而旧系统正是靠 watchdog 兜这个底。
  deadline_at INTEGER,
  resolved_at INTEGER,
  resolution_artifact_id TEXT REFERENCES artifacts(id)
);

CREATE INDEX IF NOT EXISTS idx_asks_open     ON asks(project_id, status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_asks_to       ON asks(to_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_asks_from     ON asks(from_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_asks_parent   ON asks(parent_ask_id);
CREATE INDEX IF NOT EXISTS idx_asks_deadline ON asks(deadline_at) WHERE status = 'open';

CREATE TRIGGER IF NOT EXISTS asks_no_self
BEFORE INSERT ON asks
FOR EACH ROW WHEN NEW.from_agent_id = NEW.to_agent_id
BEGIN
  SELECT RAISE(ABORT, '不能向自己提问');
END;

-- ── 会议(多边对焦)──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meetings (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  topic             TEXT NOT NULL,
  agenda_json       TEXT,
  status            TEXT NOT NULL CHECK (status IN (
                      'convened', 'in_progress', 'concluded', 'cancelled')),
  convening_agent_id TEXT NOT NULL REFERENCES agents(id),
  created_at        INTEGER NOT NULL,
  concluded_at      INTEGER,
  summary           TEXT
);

CREATE INDEX IF NOT EXISTS idx_meetings_project ON meetings(project_id, status);

-- 每个参会方一条「待表态」记录(stance 与 responded_at 一开始为空)
CREATE TABLE IF NOT EXISTS meeting_participants (
  meeting_id   TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  stance       TEXT CHECK (stance IS NULL OR stance IN ('support', 'oppose', 'undecided')),
  comment      TEXT,
  responded_at INTEGER,
  PRIMARY KEY (meeting_id, agent_id),
  -- 设计 1 §5.4 明写「反对必须写理由」。落成约束而不是靠提示词:
  -- 一个没有理由的反对,主持人无法据此调整方案。
  CHECK (stance <> 'oppose' OR (comment IS NOT NULL AND length(trim(comment)) > 0)),
  -- 表态了就要有立场与时间,三者要么都有要么都没有
  CHECK ((responded_at IS NULL) = (stance IS NULL))
);
