-- 018 · 回合用量(turn_usage):一次真回合烧了多少 token —— 落成表
--
-- ── 它补的是什么 ────────────────────────────────────────────────
--
-- 「这个项目今天花了多少」在库里**没有答案**。SDK 侧一直有真值
-- (`pi-ai` 的 `Usage`:`input` / `output` / `cacheRead` / `cacheWrite` /
-- `totalTokens` / `cost`),`message_end` 事件上就能读到 —— 而平台这一侧
-- `grep -rn 'usage' src/platform/runtime/turn.ts` 是空的:数据在手边,没有任何
-- 东西读它。落实之后的落点就是本表。
--
-- ── 为什么是**新表**而不是给 `session_messages` 加列 ─────────────
--
-- `session_messages` 的粒度是**一条消息**;而 usage 的粒度是**一次 LLM 调用**:
-- 一个回合里模型可能调 N 次工具、产生 N+1 条助手消息(N+1 条 usage),
-- 而「这个回合花了多少」只有在**回合**这一层才有意义。给消息表加 5 个 token 列
-- 会让那张表变成**两种粒度混装** —— 之后每一条查询都要先问「这行是哪种粒度」。
--
-- 更硬的一条:**新表是纯加法**。本项目为「重建表」付过两次代价,而且是两次
-- **静默**的代价:
--   · 016:照字面 recipe 重建 `artifacts` 会把 `work_id` 整列静默置空(实测);
--   · 015 / 012:重建 `dispatch_events` / `project_sessions` 时,`DROP TABLE` 的
--     隐式 DELETE 会级联清空子表(012 把 `session_messages` 全删光,
--     而 `foreign_key_check` 一声不响)。
-- 本文件一个 `DROP` 都没有,所以上面那些失效路径在这里**不存在**。
--
-- ── 加表前先查名(批次 5 的真实事故)──────────────────────────
--
-- 「`CREATE TABLE IF NOT EXISTS` 撞名时静默无操作 —— 新表根本不会建出来,报错
-- 出现在下游(索引)」。本文件动笔前的核对(两条独立证据):
--   · `ls migrations/` → 001…017,`018` 这个编号空着;
--   · `grep -rn 'turn_usage' . --exclude-dir=node_modules --exclude-dir=.git`
--     → **0 命中**(全仓,不只是 migrations/)。
--
-- 而为了不让「撞名」再有一次静默的机会,本文件的 `CREATE TABLE` / `CREATE INDEX`
-- **故意不写 `IF NOT EXISTS`**(与 015 / 016 同一条纪律,与 009 / 013 的写法不同):
-- 名字若被别的东西占着,要**响亮报错**并回滚整个迁移,而不是安静地什么都不建。
--
-- ── 本迁移不涉及闭集放宽(如实说明)──────────────────────────
--
-- `ALTER TABLE ADD CONSTRAINT CHECK` 只能**收紧**(拿去放宽会无错应用而约束
-- 一个字节没变 —— 015 文件头有实测原文),所以放宽闭集只能重建表。本文件
-- **一个新列都没有加、一个已有约束都没有碰**,自然也不需要重建,不是
-- `INTENTIONAL_REBUILDS` 的成员。
--
-- ── ⚠️ 本文件给三张「被重建过 / 将来可能被重建」的表各加了一条子边 ──
--
-- 重建一张表之前必须先知道「谁引用我」(DROP 会隐式 DELETE 级联)。本表引用了
-- `projects` / `agents` / `works` 三张表,于是引用它们的**外键条数各 +1**:
--   · 引用 `works(id)` 的外键:6 条 → **7 条**(第 7 条是本表的 `work_id`)。
--     前 6 条:works.parent_work_id、work_deps.work_id、work_deps.depends_on_work_id、
--     blocker_blocks.work_id、change_affects.work_id、artifacts.work_id。
--   · 引用 `projects(id)` / `agents(id)` 的外键同样各 +1。
--
-- 016 的「重建前提」守卫跑的是 `upTo015` 的 schema(它看不见 014 之后的迁移),
-- 所以这条 +1 显式记在这里(与 017 末尾那笔同一处置)。**将来若有第二次重建
-- `works` / `projects` / `agents`,别忘了 `turn_usage` 这条边**;它的动作是
-- `ON DELETE CASCADE`(项目)/ `ON DELETE SET NULL`(工作项)/ NO ACTION(角色),
-- 与下面每一列的理由一致。
--
-- ── 本迁移只做加法 ──────────────────────────────────────────────
--
-- 一条 `CREATE TABLE` + 一条 `CREATE INDEX`,**一行 DROP 都没有**,不碰任何既有表。

-- ── 回合用量 ────────────────────────────────────────────────────
--
-- 粒度:**一次 LLM 调用一行**(实测见 `.probe/t1-usage-source.mjs`:一个回合里
-- 每次 LLM 调用都在 `message_end`(role=assistant)上带一条 usage,而
-- `turn_end` / `agent_end.messages` 会**再次投递同一条消息** —— 同时累加两条路
-- 会把同一份用量算两遍)。回合总量 = 该回合各行之和;写入侧的落点由 T3 决定,
-- 本迁移只管形状。
CREATE TABLE turn_usage (
  id           TEXT PRIMARY KEY,
  -- ⚠️ **可空,这是与「主会话给的形状」唯一的偏差,理由是实测的**:
  -- `project_id NOT NULL` 会让**接待会话**的回合无处落账 —— 那条路径上项目还
  -- 不存在(`migrations/012` 把 `project_sessions.project_id` 放宽为可空;
  -- `host/serve.ts` 的 `runAgentTurn` 把 `projectId` 原样传给 `runTurn`,
  -- 接待会话传的就是 `null`,而 `runTurn` 内部显式处理 `pid === null`)。
  -- 那个回合是**产品里第一个花钱的回合**(新用户第一次和业务经理说话),
  -- NOT NULL 会逼写入侧二选一:丢掉它(静默少账)或编一个项目 id(假账)。
  --
  -- NULL = 还没有项目(接待会话)。**注意这不是「可以省」**:
  -- SQLite 改不了可空性,将来若要改回去只能重建表 —— 而这正是本项目付过两次
  -- 代价的动作。所以这一格现在就得定对。
  project_id   TEXT REFERENCES projects(id) ON DELETE CASCADE,
  -- 来源会话。**刻意不加外键**(与 `artifacts.conversation_id` 同一条理由):
  -- 用量必须比会话活得久。而且这条不是理论上的:`host/serve.ts` 的
  -- `adoptIntakeMessages` 在立项之后会**真的 `DELETE FROM project_sessions`**
  -- (接待会话的消息迁进新项目、会话行删掉)—— 若这里有 `ON DELETE CASCADE`,
  -- 接待会话那几笔用量会在立项那一刻**静默消失**。
  -- NULL = 接待会话(还没有会话行)或那条会话已被删。
  session_id   TEXT,
  -- 角色:外键指向 `agent_id`,不存 role 字符串(角色属性只有一处真相)。
  -- **NO ACTION(不写 ON DELETE 子句)**,与 007 的 `works.assignee_agent_id`、
  -- 008 的 `artifacts.author_agent_id`、009 的 asks/meetings、013 的
  -- `dispatch_events.consumed_by` 同形;实测 `deleteAgent` 在生产代码里没有调用方
  -- (只有 `tests/platform/storage.test.ts` 用它),所以「删角色被用量挡住」不是
  -- 当前会发生的路径,而**静默删掉用量**也不是我们想要的。
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  -- 这条回合在干哪个工作项。可空:聊天/汇报/评审的回合不挂工作项。
  -- **ON DELETE SET NULL 不是 CASCADE**(沿用 014/016 对 `artifacts.work_id` 的
  -- 处置):删掉一个工作项**不该连带删掉已经花掉的钱的记录** —— 那是既成事实。
  work_id      TEXT REFERENCES works(id) ON DELETE SET NULL,
  -- 模型标识(provider 侧的 model id)。可空 —— 老行/未知来源不假装知道。
  -- 它是成本按模型拆分(`pi-coding-agent` 的 getUsageCostBreakdown 就是按它分组)
  -- 的前提;写入侧由 T3 决定填什么。
  model        TEXT,
  -- 三个 token 数都**不带符号**:SDK 的 Usage 里它们是非负整数,
  -- DEFAULT 0 让「provider 没报这一项」与「真的是 0」在写入侧是同一种写法。
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  -- 毫秒时间戳,与全库其余 created_at 同源。
  created_at   INTEGER NOT NULL
);

-- 项目页要「今日 / 最近 7 天」⇒ 按项目按时间查。DESC 与
-- `idx_project_sessions_project`(009:39)同形。
--
-- ⚠️ 这条索引的**前导列是 `project_id`**,所以它服务的是**项目内**的时间查询;
-- 「全平台今天花了多少」那条查询用不上它(加一条 `created_at` 单列索引即可,
-- 那是纯加法,等真有那个页面再加 —— 现在不猜)。
CREATE INDEX idx_turn_usage_project_time ON turn_usage(project_id, created_at DESC);
