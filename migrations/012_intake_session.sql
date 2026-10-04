-- 012 · 接待会话(第一个项目之前的那个阶段)
--
-- ── 这个迁移补的是设计里漏掉的一段 ────────────────────────────────
--
-- 设计 1 §9.2 只写了「一个项目的会话拓扑」,**没写「第一个项目之前」**。
-- 后果是用户无法与业务经理对话:所有用户消息都要 `projectId`,而项目还不存在。
-- 前端的临时处置是一个「创建项目」表单 —— 那等于让甲方自己给自己立项,
-- 而业务经理(唯一 clientFacing 的角色)在整件事里没有位置。
--
-- 这里把它正式建模:一条 `project_id IS NULL` 的会话就是**接待会话**(全局唯一),
-- 业务经理在它里面与甲方把诉求谈清楚,谈拢了调 `project_open` 立项。
--
-- ── 为什么是重建表,而不是 ALTER ──────────────────────────────────
--
-- `project_sessions.project_id` 在 009 里是 `NOT NULL`。SQLite **没有**
-- `ALTER COLUMN` —— 放宽可空性只能重建表。
--
-- ── ⚠️ 为什么不能照抄「建 _new → INSERT → DROP 旧的 → RENAME」
--      (实测:那条路会**静默删掉全部会话消息**)
--
-- `session_messages.session_id REFERENCES project_sessions(id) ON DELETE CASCADE`,
-- 而本库 `foreign_keys = ON`(见 storage/db.ts)。于是:
--
--   DROP TABLE project_sessions
--     → SQLite 做一次隐式 DELETE FROM project_sessions
--     → 级联触发 session_messages 的 ON DELETE CASCADE
--     → **session_messages 被清空**,而 DROP 本身不报错。
--
-- 实测(本仓 .tmp 探针,已删):变体「建 _new → DROP → RENAME」跑完之后
-- `messages: []`、`foreign_key_check: []` —— 数据没了,却没有任何错误。
-- 这正是本项目的头号静默失败形态。
--
-- 「先 RENAME 旧表」那条路更糟:`ALTER TABLE ... RENAME` 会把
-- `session_messages` 的 REFERENCES 子句改写成指向 `project_sessions_old`,
-- 旧表再一 DROP,子表的 FK 就永久悬空(实测 session_messages.sql 里留下了
-- `REFERENCES "project_sessions_old"(id)`,消息同时被级联清空)。
--
-- 所以这里走**先把两张表的内容移出去 → 重建 → 灌回**:
--   1. 消息先拷进中转表(纯数据,无约束)
--   2. DROP 旧表(级联清空 session_messages —— 此时清空是**预期的**,因为内容已在①)
--   3. 建同名新表(旧表已不存在,不存在 `IF NOT EXISTS` 撞名静默)
--   4. 灌回会话行与消息
--   5. 重建两个索引 —— **DROP TABLE 会连表上的索引一起丢掉**,
--      `idx_project_sessions_project` 必须在这里显式重建,否则它是静默消失的
--
-- 全程在迁移器的事务里,失败会整体回滚,中转表不会残留。
--
-- ⚠️ 本文件里的 `CREATE TABLE project_sessions` 与 009 同名 —— 那是有意的重建,
-- 已在 `tests/platform/migrations.test.ts` 的 `INTENTIONAL_REBUILDS` 里**逐表登记**
-- (未登记的重名仍然是错误:批次 5 的事故形态)。

-- 1. 内容移出(先消息后会话;顺序无所谓,但读起来与依赖方向一致)
CREATE TABLE session_messages_backup AS SELECT * FROM session_messages;
CREATE TABLE project_sessions_backup AS SELECT id, project_id, created_at FROM project_sessions;

-- 2. 丢掉旧表。级联会清空 session_messages —— 内容已在 1 里保住。
DROP TABLE project_sessions;

-- 3. 建新表:project_id 放宽为可空,NULL = 接待会话
CREATE TABLE project_sessions (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

-- 4. 灌回会话与消息
INSERT INTO project_sessions (id, project_id, created_at)
  SELECT id, project_id, created_at FROM project_sessions_backup;
INSERT INTO session_messages (id, session_id, agent_id, kind, content, created_at)
  SELECT id, session_id, agent_id, kind, content, created_at FROM session_messages_backup;

DROP TABLE project_sessions_backup;
DROP TABLE session_messages_backup;

-- 5. 重建索引
--    ① 009 建过的那个:随 DROP TABLE 一起丢了,必须原样重建
CREATE INDEX IF NOT EXISTS idx_project_sessions_project
  ON project_sessions(project_id, created_at DESC);

--    ② 接待会话**全局唯一**。
--       ⚠️ 这里不能写成 `ON project_sessions(project_id) WHERE project_id IS NULL`
--       —— 那条索引**根本拦不住第二条接待会话**:UNIQUE 索引里 NULL 互不相等,
--       而部分索引收录的每一行 project_id 都是 NULL,于是约束永不触发。
--       实测(本仓 .tmp 探针,已删):这样建完索引之后连插两条 NULL 会话
--       都成功,NULL 行数 = 3,索引安静地什么都没做。
--       所以索引的**表达式**必须是一个非空值;`(project_id IS NULL)` 恒为 1,
--       唯一性才真正落在「接待会话只能有一条」上。
--       实测:非空行根本不进这个部分索引 ——「一个项目一条会话」不受影响,
--       同一项目插三条会话依然全部成功。
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_single_intake
  ON project_sessions((project_id IS NULL)) WHERE project_id IS NULL;
