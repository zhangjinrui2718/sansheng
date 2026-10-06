-- 021 · 质检的审查结论:把「审出了什么」从散文变成一行
--
-- ── 它补的是什么 ────────────────────────────────────────────────
--
-- 真机事故(2026-10-06 08:57,项目「美股自动化交易平台方案设计」):
--
--   质检审根工作项 W0「整合与最终交付」,判**不通过**,6 条验收判据 0 条达成、
--   1 条部分、5 条未达成,并给出可执行的修复路径。审查意见落成一条
--   `review_finding` 工件(3352 字)。
--
--   而库里那条工作项是 `status='done'` + `review_state='done'`。
--
-- 根因在 `repo/works.ts` 的 `markWorkReviewed`:它的判据是**「质检那个回合成功
-- 结束了」**,不是「质检判通过了」。那上面写着理由(「平台能确定的事实是这一份
-- 产出已经被交给质检看过一次;它到底审出了什么,现场在那一回合的会话消息与
-- 工件里」)—— 理由本身没错,错在**那一段现场没有任何机器读者**:
--
--   - `listWorksPendingReview`(`review_state='pending'` 那一条查询)从此不再返回它
--     ⇒ **不会再审第二次**;
--   - 不通过只落在一条 `review_finding` 工件里,而**没有任何代码读它的 verdict**;
--   - 也没有任何规则把「不通过」翻译成新工作项、阻塞或 outbox 事件。
--
-- ⇒ 质检的否定结论是**死信**:它被正确地产生了,但组织不会消费它。
-- 8 条 `review_finding` 全部是 `status='open'`(连 7 条「审查通过」的也是)——
-- `status` 根本没在承载 verdict,这是判据缺失的直接旁证。
--
-- 与 020 是**同一个病**:平台能写出来,但没有读者。「代码里写了逻辑」不等于
-- 「它有读者」—— 这个项目已经为同一句话付过三次代价。
--
-- ── 为什么是「一行」而不是解析 review_finding 的正文 ─────────────
--
-- 最省事的做法是让平台去 `review_finding.metadata_json` 里找 `{"verdict":"fail"}`。
-- 那是**与模型约定的私有格式**,不是 schema:模型这次照写下次忘了写,
-- 表现是「静默地按通过处理」—— 与事故现场一模一样。而 `markWorkReviewed`
-- 原来的注释已经把这个反对写下来了(「判据不是『模型有没有写 review_finding』
-- —— 那依赖模型自己建立 artifact_link」)。
--
-- ⇒ 所以 verdict 由**一个工具调用**写入:`review_verdict` 是质检 ceiling 里的
-- 一条能力,调用它就是显式的、结构化的、无歧义的。
--
-- ── 一行 = 一次审查的一个工作项的结论 ──────────────────────────
--
-- 不用唯一约束:质检可以在被追问后改判(比如甲方拍板之后撤回了异议),
-- 而**改判必须留痕** —— 只留最后一条就是「改判现场消失」(7-N)。读面因此取
-- `created_at` 最大、`seq` 最大的一条。
CREATE TABLE IF NOT EXISTS review_verdicts (
  -- 单调自增:同一条工作项被反复审时,「最新那条」靠 (created_at, seq) 判定,
  -- 而 created_at 可能有并列(同一毫秒内写了两条)。
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id            TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- 闭集。**不叫 status**:status 在 artifacts 上是「这条工件被接受了没有」,
  -- 在 works 上是「它做完没有」,复用同一个词会让三处语义打架。
  verdict            TEXT NOT NULL CHECK (verdict IN ('pass','fail')),
  -- `fail` 时的严重程度。**平台不按它判任何东西**(不因 medium 而静默、
  -- 不因 high 而多叫醒)—— 它只是给 `cascade_stopped` 告警与人看的现场。
  -- 理由:「按严重度决定要不要处理」是一条**语义猜测**,而 §2.11.3 那条纪律
  -- 是「规则不许做语义猜测」—— 任何 fail 一律重开,严重度只影响人读的那一行。
  severity           TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  -- 审查意见工件。**不加 ON DELETE**(NO ACTION):删掉一份审查意见不该抹掉
  -- 「这里判过不通过」这个事实(与 asks.resolution_artifact_id 同形)。
  finding_artifact_id TEXT REFERENCES artifacts(id),
  note               TEXT,
  reviewed_by        TEXT NOT NULL REFERENCES agents(id),
  created_at         INTEGER NOT NULL
);

-- 判定的读面:「这条工作项最新一次审查结论是什么」。
-- 每次重审追加一行,所以这里按 (created_at DESC, seq DESC) 取首条。
CREATE INDEX IF NOT EXISTS idx_review_verdicts_work
  ON review_verdicts(work_id, created_at DESC, seq DESC);

-- 排空器消费块与测试要按项目查,补一条。
CREATE INDEX IF NOT EXISTS idx_review_verdicts_project
  ON review_verdicts(project_id, created_at DESC, seq DESC);

-- ⚠️ **它给 `artifacts` 增加了第 6 张引用子表**(020 之后是 5 张,见 017 文件头)。
-- 016 的重建前提守卫跑的是 `upTo015`,看不见这两条,所以显式记一笔:
-- **将来若有第二次重建 `artifacts`,第 6 张子表是 `review_verdicts`,
-- 动作是 `NO ACTION`,处置方式与 `asks.resolution_artifact_id` 同形 ——
-- 重建前先把它置 NULL、重建后回填。**
