-- 036 · 忙时排队(queued_client_messages,2026-11-22):甲方在业务经理
--       正在跑回合时说的话,**不再拒收,排队等下一轮带上**。
--
-- ── 它补的是什么 ────────────────────────────────────────────────
--
-- 此前 `transport/hub.ts` 的 `send` 在忙闩占用时回 `code:"busy"`
-- (「与你对话的那位正在跑一个回合,等它结束或先中断」)。两处真实代价:
--   · 服务端叫用户「先中断」,而中断入口在连接断开/刷新后可能根本不在
--     (批次 32 修的就是这条链)—— **服务端指的路,界面走不通**;
--   · 甲方那一句话**哪儿都没落**:拒收 = 丢话,他只能等回合结束后重发,
--     而他多半以为自己说过了。
--
-- multica 的同款机制是「排队 + 合并进下一轮」("joined this run"):
-- 消息先持久化,agent 空出来时一并带上。本表是那句话的**账**:
-- `consumed_at IS NULL` = 还没被业务经理看到 ⇒ 排空器有一条待办
-- (`answer_client_message`,`runtime/dispatcher.ts`)。
--
-- ── 为什么消息正文存在 session_messages、这里只放账 ──────────────
--
-- 甲方那句话**本来就是一条会话消息**:对话页要显示它(乐观上屏之后的
-- 刷新回填),它必须落在 `session_messages`。本表只记「哪一条还没被带上」:
--   · `message_id` 引用那条消息(FK,`ON DELETE CASCADE` —— 消息没了,
--     「带上它」这件事也无从谈起,不让账悬空);
--   · `session_id` **刻意不加外键**(与 018 的 `turn_usage.session_id` 同一条
--     理由:账要比会话活得久;且这里指向的一定是本项目的线,不指向接待会话)。
--
-- ⚠️ 排空器触发的回合「一律落主对话」这条纪律,**这条待办是例外**:
-- 待办是项目级的,但这条待办就是**那条线上**甲方的话 —— 回合跑在
-- `session_id` 指的那条线(`DriverTodo.sessionId`),否则答复会出现在
-- 甲方看不见的另一条线上。
--
-- ── 幂等与 at-least-once ─────────────────────────────────────────
--
-- 消费语义与 `client_questions.consumed_at` / outbox 同一条纪律:
-- 回合**成功结束**才写 `consumed_at`,失败/被中断就下次重来(宁可多说一次,
-- 不能静默丢甲方一句话)。同一线多条排队消息 ⇒ 同一条待办(key 按线分组)、
-- 一轮全部带上(multica 的 "joined" 语义)。
--
-- ── 本迁移只做加法 ──────────────────────────────────────────────
--
-- 一条 `CREATE TABLE` + 一条部分索引,不写 `IF NOT EXISTS`(015/016/018/035
-- 同一条纪律:撞名要响亮报错)。

CREATE TABLE queued_client_messages (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- 排队的那句话落在哪条线上(回合将跑在这条线;见上面的「例外」说明)。
  session_id   TEXT NOT NULL,
  -- 那条 user 消息(`session_messages.id`)。正文只存那一处。
  message_id   TEXT NOT NULL REFERENCES session_messages(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  -- NULL = 还没被业务经理看到(待办判据);非空 = 已在某一轮带上。
  consumed_at  INTEGER
);

-- 待办判据只问未消费的行,部分索引让那条查询永远走索引。
CREATE INDEX idx_queued_client_pending
  ON queued_client_messages(project_id, session_id, created_at)
  WHERE consumed_at IS NULL;
