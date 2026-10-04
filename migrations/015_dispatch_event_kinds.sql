-- 015 · 放宽 `dispatch_events.kind` 的闭集(「取消」要能被交代出去)
--
-- ── 它补的是什么 ────────────────────────────────────────────────
--
-- Wave 1 让「取消工作项」写一条 `work_cancelled` 事件(设计 §12 #10):取消此前
-- 什么都不写,于是「这条工作项被取消了」业务经理与质检都不知道 —— 而它**正是
-- 下游依赖悬空的来源**(真机事故的起点)。但 013 建的 CHECK 闭集只有 4 个取值,
-- 实测原文:
--
--   insert into dispatch_events (..., kind, ...) values (..., 'work_cancelled', ...)
--   SqliteError: CHECK constraint failed: kind IN (
--                 'work_done', 'work_failed', 'work_blocked', 'blocker_opened')  (19)
--
-- 本迁移只做一件事:把这个闭集放宽到含 `work_cancelled`。
-- 写入侧**零代码改动** —— 见 `repo/dispatch.ts` 的降级分支:它吞的正是这一条
-- CHECK,CHECK 一放宽它就自然不再触发(那是它被设计出来的目的)。
--
-- ── 为什么是「重建表」,而不是 ALTER ─────────────────────────────
--
-- ① SQLite 没有 `ALTER COLUMN`,也不支持修改已有 CHECK 的表达式。
--
-- ② `ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)` 在本 SQLite 构建
--    (3.53.4)上**被接受、且真的生效**,但多个 CHECK 之间是 **AND** ——
--    它只能**收紧**,不能放宽。实测(本仓 `.tmp015/probe.mjs` 探针 C,已删):
--
--      放宽(新 CHECK 里含 work_cancelled) → **无错应用**,而 work_cancelled 依旧被拒
--      收紧(新 CHECK 只留 work_done)     → 无错应用;此后 work_done 落得进、
--                                            work_failed 被拒
--
--    所以拿它去「放宽」会得到一次**无错、但约束一个字节都没变**的应用 ——
--    正是本项目反复栽过的头号静默失败形态。**不放宽就用重建。**
--
-- ── ⚠️ 重建的静默失败面(012 的真实事故,本次逐条处置)──────────
--
-- `DROP TABLE` 会做一次**隐式 DELETE**。若**别的表**用 `ON DELETE CASCADE`
-- 指向本表,那些表的行会被静默清空,而 `foreign_key_check` 一声不响
-- (012 实测:重建 `project_sessions` 时删光了全部 `session_messages`)。
-- 所以本次重建的**安全性前提**只有一条:
--
--   **没有任何表引用 `dispatch_events`。**
--
-- 静态核对:`grep -rn 'REFERENCES dispatch_events' migrations/` = 0 命中
-- (013 里两处 REFERENCES 都是本表**指向别人**:projects / agents)。
-- 动态核对(探针 A,真 schema + `foreign_keys = ON`,带正负样本):
--   正样本  引用 `projects` 的表 = 11 张       ← 探测器没坏(非空)
--   正样本2 引用 `works` 的表 = 6 张
--   对照    引用 `blockers` 的表 = 1 张(blocker_blocks)
--   负样本  引用 `dispatch_events` 的表 = []   ← 空是有意义的
-- 该前提由 `tests/platform/migrations.test.ts` 的「015 重建前提」一组用例
-- **钉住**:将来谁加了一张指向 `dispatch_events` 的子表,先红的是那条测试,
-- 而不是先删数据。
--
-- **为什么这条前提没有写成 SQL 断言**:`PRAGMA foreign_key_list` 是**逐表**的,
-- 扫全库要动态 SQL(迁移文件里做不到);而拿 `sqlite_master.sql` 做文本 LIKE
-- 去猜外键,会得到一个「看起来正常的错误答案」(空白/引号/`main.` 前缀都能让它
-- 静默漏判)—— 那正是本项目的第 3 类静默失败。所以它落在测试里,用真 API + 样本自检。
--
-- 另外两处会静默消失的东西:
--   ③ `DROP TABLE` 会连表上的索引一起丢掉 —— `idx_dispatch_events_pending` 必须在
--      本文件里**显式重建**。丢了不报错,查询照跑,只是变成全表扫。
--      这里**故意不写 `IF NOT EXISTS`**:万一索引名还被别的东西占着,
--      要**响亮报错**,而不是安静地什么都不建。
--   ④ `seq` 是 `INTEGER PRIMARY KEY AUTOINCREMENT`,DROP 会抹掉 `sqlite_sequence`
--      里那一行。灌回时**显式写入 seq**,于是 `sqlite_sequence` 被重新抬到
--      `max(seq)` —— 版本号**不回退**(`seq` 是 `runtime/dispatcher.ts` 里
--      `todo_key` 的一部分)。这一条由测试断言,不靠注释。
--
-- 至于「重建前后行数与内容必须逐字不变」:本文件不写自检断言 ——
-- SQLite 没有 `RAISE`(触发器之外),一个**永远不会触发**的检查只是装饰。
-- 它落在测试与探针里(见 `tests/platform/migrations.test.ts` 的 015 一组),
-- 那里能做逐字对比、能带正负样本。
--
-- ── 这一次**不加** `work_reopened`(裁决 + 理由)──────────────────
--
-- 设计 §12 #9 的出路 (b)(`done → in_progress` 退回时写一条「先前那次交代作废」
-- 的事件)确实需要新 kind,而「一次加够」能省下将来的第二次重建。**仍然不加**:
--
--   1. **死枚举**:全仓没有任何写出方(`repo/works.ts` 的 `EVENT_KIND` 只有
--      done / failed / blocked / cancelled)。放进 CHECK 的取值会成为一句
--      「本系统会发出这种事件」的假话 —— 与「代码写了但没有读者」同构,
--      只是方向反过来(「schema 开了口但没有写者」)。
--   2. **省下的那次重建可能是假的**:§12 #9(b) 要求「让甲方知道先前那次交代
--      作废」,而 outbox 现在的列只有 `subject_id`(`工作项 id 或阻塞 id`),
--      **没有任何字段能指向前一条事件**。真要实现 (b),多半还要动列 ——
--      那时照样得重建表,预先塞一个 kind 省不掉任何东西。
--   3. **代价不对称**:`dispatch_events` 没有子表引用、只有一条部分索引,
--      重建成本极低(012 那次贵,是因为 `project_sessions` 有级联子表);
--      而一个没有写者的取值会永久留在闭集里误导读者。
--   4. 况且 §12 #9 至今是**未决问题**(文档原文:「(b) 更贴合真实工作流,
--      但它要求 …… 与 #10 是同一笔迁移」)—— 为一个尚未裁决的分支先占位,
--      等于把没做的决定固化进 schema。
--
-- 结论:只加 `work_cancelled`。将来真要 (b),照本文件再走一次重建即可 ——
-- 那条路已经被本文件 + 守卫测试完整走通并登记过了。
--
-- ── 登记 ────────────────────────────────────────────────────────
--
-- 本文件里的 `CREATE TABLE dispatch_events` 与 013 同名 —— 那是有意的重建,
-- 已在 `tests/platform/migrations.test.ts` 的 `INTENTIONAL_REBUILDS` 里
-- **逐表登记**(dispatch_events ← 013 + 015)。未登记的重名仍然是错误。
--
-- 全程在迁移器的事务里(`infra/migrations.ts` 的 `db.transaction`),
-- 中途任何一步失败都整体回滚,中转表不会残留。

-- 1. 内容先移出去(纯数据、无约束的快照表)
CREATE TABLE dispatch_events_backup AS SELECT * FROM dispatch_events;

-- 2. 丢掉旧表。它没有子表(前提见上),所以这次隐式 DELETE 删不到别人的行;
--    `idx_dispatch_events_pending` 会随之一并消失 —— 第 5 步重建。
DROP TABLE dispatch_events;

-- 3. 建同名新表:与 013 的定义逐字相同,只把 kind 的闭集加一个取值
--    (列顺序、NOT NULL、两个外键与其动作都必须原样保留 —— 漏一个就是静默的语义漂移)
CREATE TABLE dispatch_events (
  -- 单调自增:它同时是「这批事件的版本号」(见 runtime/dispatcher.ts 的 todo_key)
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN (
                'work_done', 'work_failed', 'work_blocked', 'blocker_opened',
                'work_cancelled')),
  -- 事件主体:工作项 id 或阻塞 id。**不加外键** —— 两条来源表不同,
  -- 而事件是历史记录,主体被删掉时这行仍应留着(它是「当时发生过什么」)。
  subject_id  TEXT NOT NULL,
  summary     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_by TEXT REFERENCES agents(id)
);

-- 4. 灌回。**显式列出每一列** —— 顺带把 `seq` 一起写回去,
--    这既保住了「这批事件的版本号」,也让 `sqlite_sequence` 重新抬到 max(seq)。
INSERT INTO dispatch_events (seq, project_id, kind, subject_id, summary, created_at,
                             consumed_at, consumed_by)
  SELECT seq, project_id, kind, subject_id, summary, created_at,
         consumed_at, consumed_by
  FROM dispatch_events_backup;

DROP TABLE dispatch_events_backup;

-- 5. 原样重建那条部分索引(随 DROP TABLE 静默消失的那一条)。
--    不加 `IF NOT EXISTS`:名字若还被占着,宁可响亮报错。
CREATE INDEX idx_dispatch_events_pending
  ON dispatch_events(project_id, created_at) WHERE consumed_at IS NULL;
