-- 013 · 排空器状态(无状态驱动者循环的地基)
--
-- ── 它补的是什么 ────────────────────────────────────────────────
--
-- 批次 20 的驱动者循环把「下一步该谁跑」的判据分成了两半:
--
--   - 一半**在库里**(等答的提问 / 待评的变更 / 零工作项 / 派给我的 open 工作项)
--   - 一半**在内存里**(「刚有工作项变成 done」「下游刚出了结果」)
--
-- 后一半有三个同源的病:不持久(重启不补跑)、跨调用会丢(撞上界就永远没人
-- 汇报)、漏一类状态就判成假的无进展(真机跑出来过:签名漏了 meetings,项目
-- 经理成功表态却被判「无进展」,整条级联当场停住,那个项目最后 works=0)。
--
-- 本迁移把那一半搬进库里,于是判定可以退化成**一条纯查询**:
--
--   ① `works.review_state`      —— 「这份产出等着审 / 审过了」
--   ② `dispatch_events`         —— 「下游发生了什么、还没向甲方交代」
--   ③ `dispatch_attempts`       —— 「这条待办已经给过几次机会、还是没动静」
--
-- ── 为什么 ③ 也是库里的状态,而不是删掉 ─────────────────────────
--
-- 「同一个待办每 10 秒被重叫一次」是烧 token 的正解形态,必须有东西挡。
-- 但挡它的东西**不是判据**,是**预算**:按 (项目, 待办) 记一个持久计数,
-- 到界就不再叫醒并如实广播(不静默)。它与批次 20 的 `stallStore` 有两点
-- 本质不同:
--   - 它**不进内存**:重启后计数还在(重启不会让预算重新开始)
--   - 它**不需要状态指纹**:没有「项目签名漏了一类状态 → 假的没有进展」
--     这条失败路径 —— 计数的失效方向永远是「多跑一次」,不会是「误判停住」
--
-- ── 本迁移只做加法 ──────────────────────────────────────────────
--
-- 没有 DROP、没有表重建、没有 ALTER 已有列(只 ADD COLUMN)。批次 18 的事故
-- 是 `DROP TABLE` + `ON DELETE CASCADE` 静默删光全部会话消息 —— 本文件里
-- 一行 DROP 都没有。守卫见 tests/platform/migrations.test.ts。

-- ── ① 工作项的审查态 ────────────────────────────────────────────
--
-- 数据模型里此前**没有**「等待审查」这个状态:`works.status` 只有
-- open/in_progress/blocked/done/failed/cancelled,`artifact_links` 的 rel 只有
-- parent/depends_on/answers,而质检**不持 `work.update`**(它改不了工作项)。
-- 于是质检那条待办只能是「本层级联观察到的事件」。
--
-- 三态而不是布尔,因为「还没审」和「审过了」必须可区分 —— 布尔无法回答
-- 「一个 done 的工作项到底有没有被审过」。
--   none    这个工作项不该被审(非 done)
--   pending 已是 done、等着审        ← 质检的待办 = 查这一格
--   done    审过了(平台在质检回合结束后写)
ALTER TABLE works ADD COLUMN review_state TEXT NOT NULL DEFAULT 'none'
  CHECK (review_state IN ('none', 'pending', 'done'));

-- 质检的待办查询走这条部分索引:`WHERE status = 'done' AND review_state = 'pending'`
CREATE INDEX IF NOT EXISTS idx_works_pending_review
  ON works(project_id) WHERE review_state = 'pending';

-- ── ② 下游事件(outbox)─────────────────────────────────────────
--
-- 「工作项做完了」「登记了新阻塞」这类事实原先只在级联的局部变量里活:
-- 撞上 `maxRounds` 停下时随调用消失 → **工作项做完了永远没人向甲方汇报**。
-- 落成一行 append-only 的记录之后,业务经理的待办就是一条查询:
-- 「这个项目还有没被交代的下游事件吗」。
--
-- consumed_at 由平台在业务经理那个回合**成功结束后**写(不是模型自己写)——
-- 回合失败/被中断就不消费,下一次 tick 重来。这是 at-least-once:
-- 宁可多汇报一次,不能静默漏掉。
CREATE TABLE IF NOT EXISTS dispatch_events (
  -- 单调自增:它同时是「这批事件的版本号」(见 runtime/dispatcher.ts 的 todo_key)
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN (
                'work_done', 'work_failed', 'work_blocked', 'blocker_opened')),
  -- 事件主体:工作项 id 或阻塞 id。**不加外键** —— 两条来源表不同,
  -- 而事件是历史记录,主体被删掉时这行仍应留着(它是「当时发生过什么」)。
  subject_id  TEXT NOT NULL,
  summary     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_by TEXT REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_events_pending
  ON dispatch_events(project_id, created_at) WHERE consumed_at IS NULL;

-- ── ③ 待办尝试预算 ──────────────────────────────────────────────
--
-- 键是 `(project_id, todo_key)`,而 `todo_key` 由待办自身的内容决定
-- (例如 `execute_work:wk_7`、`answer_ask:a1+a2`)。待办消失时这一行被删掉 ——
-- 于是「同一件事再次出现」会自动拿到新的预算,不需要任何额外规则。
--
-- `target_state` 是目标行上一次的 `updated_at`:目标真的动了就把预算清零
-- (它确实在推进,不该被预算掐死)。只有「目标一动不动」才消耗预算。
CREATE TABLE IF NOT EXISTS dispatch_attempts (
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  todo_key        TEXT NOT NULL,
  attempts        INTEGER NOT NULL,
  -- 上一次尝试时目标行的 updated_at(没有目标行的待办为 NULL)
  target_state    INTEGER,
  first_attempt_at INTEGER NOT NULL,
  last_attempt_at  INTEGER NOT NULL,
  -- 到界放弃时**只广播一次** —— 否则每 10 秒一条 system 消息,那也是一种静默
  notified_at      INTEGER,
  PRIMARY KEY (project_id, todo_key)
);
