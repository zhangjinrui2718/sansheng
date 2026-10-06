-- 020 · 向甲方提问的「答复已被消费」边
--
-- ── 它补的是什么 ────────────────────────────────────────────────
--
-- 真机事故(2026-10-06 09:09,项目「美股自动化交易平台方案设计」):
--
--   09:08:16 业务经理 `ask_client` 提问「W1 数据源组合,您想怎么走?」
--   09:09:26 甲方在待答面板点了答复,后端 `POST /api/client-questions/:id/answer`
--            写了 decision 工件 + answers 审计边 + 提问转 accepted
--   09:12:17 排空器跑完:`四个角色 todos 全空`、`openWorks: 0`、`runningTurns: 0`
--
-- 之后系统再没有产生过一条消息。**甲方的答复落进库里就没人捡** ——
-- 业务经理在 08:59 宣布过的那条队列(「等您回完 W1,我会按 W2→W3→…→W7 顺序
-- 逐项问」)永远不会自动开始。
--
-- ── 为什么已有工件表答不了这个问题 ────────────────────────────────
--
-- `client_question` 工件 + `artifact_links` 的 `answers` 边**已经**完整表达了
-- 「问了什么」「答了什么」。缺的不是事实,是**消费标记**。
--
-- 规则必须有库里的终止判据,否则它每个 tick 都成立,只能靠尝试预算兜住 ——
-- 而 AGENTS.md 的定性是「预算不是判据,是限流」,拿它兜一条每 10 秒成立的规则
-- 等于让流水线静默停在一个「看起来跑过很多次」的地方。
--
-- 同一批教训在三条通道上各有一个终止判据,本表是第四条:
--
--   ① `asks.status='answered'`                 → answer_pending_ask(agent↔agent)
--   ② `dispatch_events.consumed_at`            → report_downstream_events
--   ③ `project_sessions.deliverable_artifact_id` → handover_deliverable
--   ④ **本表的 `consumed_at`**                 → resume_client(agent↔甲方)
--
-- ①②③ 都做对了,唯独 ④ 缺位 —— 而它恰恰是**唯一一条用户能自己推动的通道**。
-- 7-L 那次修复(「提问者进 blocked、但对方不会主动知道」)只覆盖了 agent↔agent
-- 的 `asks` 表,`client_question` 是另一条载体,同一个病只治了一条。
--
-- ── 为什么 `asked_by` / `consumed_by` 都指向 agents.id ────────────
--
-- 与全库一致:角色属性只有一处真相(AGENTS.md「外键一律指向 agent_id,
-- 不存 role 字符串」)。此刻能提问的只有业务经理(`client.ask` 只在他的
-- ceiling 里),但表不写死这一点 —— 写死就是**把判据搬进 schema**,而权限
-- 将来可能变。`resume_client` 规则按 `asked_by` 找提问者,与按 `to_agent_id`
-- 找回答者的 `answer_pending_ask` 同形。
--
-- ── 本迁移只做加法 ──────────────────────────────────────────────
--
-- 一行 DROP 都没有,没有表重建,没有 ALTER 已有列。**不建表之外的东西**,
-- 所以它不进 `INTENTIONAL_REBUILDS`(守卫见 `tests/platform/migrations.test.ts`)。
--
-- ⚠️ **它给 `artifacts` 增加了第 5 张引用子表**(此前 4 张,见 017 文件头)。
-- 那个数是 016 重建 recipe 的前提(先备份哪些子表 / 谁会跟着 DROP 静默级联)。
-- 016 的重建前提守卫跑的是 `upTo015`,看不见这一条,所以这里显式记一笔:
-- **将来若有第二次重建 `artifacts`,第 5 张子表是 `client_questions`,
-- 动作是 `CASCADE`(见下),重建前先把它整个备份出去。**

-- ── 提问台账 ────────────────────────────────────────────────────
--
-- 一行 = 一次向甲方提问。`question_artifact_id` 是主键且指向 `artifacts`:
-- 提问**就是**那条工件,本表不复制它的正文(正文改了这里也不会跟着漂,
-- 「两份定义迟早漂」是本项目为同一件事付过好几次代价的教训)。
--
-- `ON DELETE CASCADE`:删掉提问工件 = 这条提问不再存在,台账行没有独立意义。
-- **与 017 的 `deliverable_artifact_id` 取向相反是刻意的** —— 那条边的两端
-- 都是审计面(交付物必须比开它的那场对话活得久),失效方向选「响亮拒绝」;
-- 而本表表达的是「一次提问的当前进度」,提问没了它就该跟着没。
CREATE TABLE IF NOT EXISTS client_questions (
  question_artifact_id TEXT PRIMARY KEY
                        REFERENCES artifacts(id) ON DELETE CASCADE,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asked_by             TEXT NOT NULL REFERENCES agents(id),
  asked_at             INTEGER NOT NULL,
  -- 答复落在哪条 decision 工件上。**不加 ON DELETE 子句(= NO ACTION)**:
  -- 删掉一条 decision 是审计面上的事,不该静默抹掉「这里答复过」这个事实
  -- (与 `asks.resolution_artifact_id` 同形,重建 artifacts 前要先置 NULL)。
  answer_artifact_id   TEXT REFERENCES artifacts(id),
  -- 答复**落库**的时刻。与 `consumed_at` 严格分开:前者是「甲方说了」,
  -- 后者是「业务经理已经看过并处置了」。把两者合成一列,业务经理就永远没有
  -- 「答复到了但还没看」这个状态 —— 那正是这次事故里丢失的那一段。
  answered_at          INTEGER,
  -- 业务经理**处置完**这个答复的时刻(由平台在 `resume_client` 回合
  -- **成功结束后**写 —— 与 dispatch_events / 交付会话同一条纪律:
  -- 回合失败或被中断就不消费,下一次排空重来,at-least-once)。
  consumed_at          INTEGER,
  consumed_by          TEXT REFERENCES agents(id)
);

-- `resume_client` 规则的判据就是这一条:
--   answered_at IS NOT NULL AND consumed_at IS NULL
-- 部分索引让它在「答复堆积」时也是常数级 —— 甲方一口气答了 8 个问题时,
-- 每个 tick 扫全表会把排空器的心跳拖慢,而那 8 行里绝大多数已经被消费掉了。
CREATE INDEX IF NOT EXISTS idx_client_questions_unconsumed
  ON client_questions(project_id) WHERE consumed_at IS NULL;
