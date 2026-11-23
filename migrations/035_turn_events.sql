-- 035 · 执行日志(turn_events):一个回合「做了什么」的逐事件轨迹(2026-11-22)
--
-- ── 它补的是什么 ────────────────────────────────────────────────
--
-- 「他做了什么」在库里此前没有结构化答案:
--   · `session_messages` 只有**正文**(他说了什么);
--   · `turn_usage` 只有**账**(烧了多少 token);
--   · 工具轨迹(`TurnResult.toolCalls`:名称 / 参数摘要 / 结果摘要 / 成败 / 时长)
--     在回合内存里抓得**全全的**,却只被 `renderExecutionReport` 渲染成一段散文,
--     随日志漂走 —— 查一次真机事故(unanswered_turn、109K token 超时、
--     `formatIdleTrail` 空转归因)只能靠翻 stdout。
--
-- 本表把那份现场落成**可回放的行**:一回合一组(`turn_id`),组内 `seq` 单调,
-- 每行是一次工具调用 / 一条 provider 故障 / 一个回合级标记(超时打断、无下文)。
-- 借鉴自 multica 的 `task_message`(seq 单调是重发顺序契约;库是唯一事实源,
-- 实时流只是「刚落库行的转发」)。
--
-- ── 三种粒度三张表,不混装(018 已立的规矩)─────────────────────
--
--   正文(session_messages,一条消息一行)/ 用量(turn_usage,一回合一行)/
--   轨迹(turn_events,一回合 N 行)。「这条轨迹行属于哪个回合」靠 `turn_id`;
-- `turn_usage` 没有回合 id 列,两边不强行对齐 —— 用量是**账**,轨迹是**现场**,
-- 各自的查询路径不同,硬接一条外键只会让「删账」多一个连带动作。
--
-- ── 可空性与外键:逐列照抄 018 的裁决 ────────────────────────────
--
--   · `project_id` 可空 —— 接待会话的回合同样有轨迹,理由与 018 完全相同
--     (那是产品里第一个花钱的回合,轨迹也一样不许丢);
--   · `session_id` **刻意不加外键** —— 轨迹必须比会话活得久
--     (`adoptIntakeMessages` 立项后会真的删掉接待会话行,挂着 CASCADE 会让
--     那几笔轨迹静默消失);
--   · `agent_id` NOT NULL + NO ACTION、`work_id` 可空 + ON DELETE SET NULL
--     —— 与 018 逐字同形,同一条理由(删工作项不该删掉「当时干了什么」)。
--
-- ⚠️ 本表给三张「被重建过 / 将来可能被重建」的表各加一条子边(与 018 同一笔账):
--   引用 `works(id)` 的外键 7 条 → **8 条**;`projects(id)` / `agents(id)` 各 +1。
--   **将来若有第二次重建 `works` / `projects` / `agents`,别忘了 `turn_events` 这条边。**
--
-- ── 取值域不建 CHECK ────────────────────────────────────────────
--
-- `kind` 当前是 `tool | provider_error | marker` 三值,将来可能加
-- (比如 `interrupt`)—— 与 022 / 030 / 031 同一条先例:闭集在读写两侧的 TS 里
-- (`storage/repo/turnEvents.ts` 的 `TURN_EVENT_KINDS`),不靠 schema。
--
-- ── 本迁移只做加法 ──────────────────────────────────────────────
--
-- 一条 `CREATE TABLE` + 两条 `CREATE INDEX`,一行 DROP 都没有,不碰任何既有表。
-- `CREATE TABLE` **故意不写 `IF NOT EXISTS`**(015 / 016 / 018 同一条纪律):
-- 名字被占着要响亮报错,而不是安静地什么都不建。

CREATE TABLE turn_events (
  id             TEXT PRIMARY KEY,
  -- 一回合一组。`runtime/turn.ts` 在回合开始时生成一次,同回合各行共用。
  -- **刻意不加外键**:它不是任何表的行 id,只是分组键。
  turn_id        TEXT NOT NULL,
  project_id     TEXT REFERENCES projects(id) ON DELETE CASCADE,
  session_id     TEXT,
  agent_id       TEXT NOT NULL REFERENCES agents(id),
  work_id        TEXT REFERENCES works(id) ON DELETE SET NULL,
  -- 回合内单调(1 起):**重发顺序契约**(multica 同款)—— 读面按它排,
  -- 不按 created_at(created_at 的粒度是毫秒,同一批写入会同毫秒)。
  seq            INTEGER NOT NULL,
  -- tool | provider_error | marker —— 取值域在 TS,见上。
  kind           TEXT NOT NULL,
  -- kind='tool' 时的工具名;其余为 NULL。
  tool           TEXT,
  args_summary   TEXT NOT NULL DEFAULT '',
  result_summary TEXT NOT NULL DEFAULT '',
  is_error       INTEGER NOT NULL DEFAULT 0,
  -- kind='tool' 时的调用时长(毫秒);其余为 NULL。
  duration_ms    INTEGER,
  created_at     INTEGER NOT NULL
);

-- 成员页「他做了什么」:按项目的成员面板逐成员倒序翻 —— 与 018 的两条索引同形。
CREATE INDEX idx_turn_events_project ON turn_events(project_id, agent_id, created_at DESC);
-- 单回合回放(点开一个回合看全程)。
CREATE INDEX idx_turn_events_turn ON turn_events(turn_id, seq);
