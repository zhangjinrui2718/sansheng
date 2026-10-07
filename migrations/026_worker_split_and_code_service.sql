-- 026 · 执行角色一分为二(worker → research_worker + coding_worker)
--       + 交付物类型加 `code_service`(git 仓库 · 可独立部署到 Docker)
--
-- ── 用户原话(2026-10-08)────────────────────────────────────────
--
--   「我现在想加一个新的交付物类型,叫做代码服务,这个是一个 git 仓库,然后这个
--     仓库可以独立部署到 docker 上面,新增一种 worker 类型叫做 coding worker,
--     专门来写代码,现在的那个 worker 改名叫做 research worker,专门用来产出
--     文档、伪代码、架构图、汇报材料等等」
--
-- 两件事各自独立,但**同一批**发布,共用一条「放宽闭集」的机制。
--
-- ════════════════════════════════════════════════════════════════
-- A 段 · agents.role 闭集:4 个取值 → 5 个(并改一个名字)
-- ════════════════════════════════════════════════════════════════
--
-- 为什么要重建表:与 015/016 同一条理由(015:18-31 有实测原文)——
-- SQLite 没有 `ALTER COLUMN`,而 `ALTER TABLE … ADD CONSTRAINT … CHECK` 在本构建上
-- **无错应用、约束一个字节都不变**(多个 CHECK 之间是 AND,只能收紧)。放宽闭集
-- 只有重建表这一条路。
--
-- ── ⚠️⚠️ 这次的坑不在「子表会丢」,而在**用哪种重建法** ─────────────
--
-- 016 那套「建 _new → 拷 → DROP 旧的 → 改名」在 `agents` 上会分叉成两种行为,
-- 取决于**子表里有没有行** —— 本文件发布前用探针逐条实测过
--(`.probe/026-rebuild-probe.mjs`,33/33 通过,带正负样本自检;见 Q1/Q2/Q2b 三组):
--
--   ① 「先把 agents 改名成 agents_old,再建新表、拷回、DROP agents_old」
--      —— **看起来最干净,实际最危险**:
--        · 子表只有 project_assignments 有行时(最小数据)
--          → 迁移**不报错**,而 `project_assignments` 被**静默清空**
--            (DROP TABLE 的隐式 DELETE 仍会对「按名字引用 agents 的子表」
--             触发 ON DELETE CASCADE),`foreign_key_check` 依旧 `[]`
--        · 子表全都有行时(真机形态)
--          → `FOREIGN KEY constraint failed`,响亮失败、事务回滚
--      ⇒ 「在我机器上它报错了」不可移植 —— 这正是 016 文件头记过的同一条教训。
--
--   ② 「defer_foreign_keys = ON + 只备份那条 CASCADE 子表 + DROP + 重建 + 灌回」
--      —— **本文件采用的那一条**,探针 Q1 全绿:
--        · 15 条子表外键的行数逐项不变
--        · `foreign_key_check = []`
--        · 提交后 `defer_foreign_keys` **自动复位**(探针显式断言了这一条 ——
--          它若漏给后续迁移,后面每一次写库都会变成「提交时才报错」)
--
--   ⚠️ **本迁移必须跑在事务里**(`infra/migrations.ts` 的 `db.transaction` 就是)。
--   事务之外直接执行会在 `DROP TABLE agents` 上得到 `FOREIGN KEY constraint failed`
--   —— 那是**响亮失败**(安全),不是静默删数据;但要知道那条边界的来源是
--   `defer_foreign_keys` 需要一个「提交点」去推迟到。回归见
--   `tests/platform/migrations.test.ts` 的 026 一组(含这条负样本)。
--
--   `PRAGMA defer_foreign_keys` 是**唯一能在事务里生效**的放宽手段:
--   `PRAGMA foreign_keys` 在事务内是 no-op(016 之所以要走「置 NULL 再回填」,
--   就是因为这一条)。而 defer 只推迟**约束检查**,不推迟 **ON DELETE 动作** ——
--   所以 CASCADE 子表仍然要自己备份灌回,不能指望 defer 替你保住它。
--
-- ── 静态核对:引用 agents 的外键共 **15 条**,其中 CASCADE 只有 **1 条** ──
--
--   `grep -rn 'REFERENCES agents' migrations/` 得到的是**历史文件里的行数**,
--   不是**当前 schema 里的外键数**(016 重建过 artifacts、015 重建过 dispatch_events,
--   同一张表会被数两次)。真判据是动态的:
--
--     PRAGMA foreign_key_list(<每张表>) where table = 'agents'
--
--   探针实测(打印了完整名单):15 条 ——
--     project_assignments.agent_id        → CASCADE   ← 只有这一条
--     works.assignee_agent_id             → NO ACTION
--     asks.from_agent_id / to_agent_id    → NO ACTION
--     meetings.convening_agent_id         → NO ACTION
--     meeting_participants.agent_id       → NO ACTION
--     session_messages.agent_id           → NO ACTION
--     artifacts.author_agent_id           → NO ACTION
--     blockers.raised_by_agent_id         → NO ACTION
--     change_requests.decided_by_agent_id → NO ACTION
--     dispatch_events.consumed_by         → NO ACTION
--     client_questions.asked_by / consumed_by → NO ACTION
--     turn_usage.agent_id                 → NO ACTION
--     review_verdicts.reviewed_by         → NO ACTION
--
-- ── 改名这件事本身:为什么连**存量行**一起改 ──────────────────────
--
-- `role` 是闭合联合(TS 侧 `ProjectRole`),仓储在边界处**硬校验**
-- (`repo/agents.ts` 的 `rowToAgent` 对未定义 role **抛错**)—— 留一行
-- `role='worker'` 就是留一颗会让 `listAgents` 整条查询炸掉的雷。所以存量行必须
-- 一起改成 `research_worker`。这不是「改写事实换好看」:那个角色**真的**被重新
-- 定义了,改名是这个定义变更的一部分。
--
-- `specialization` **原样保留**(探针显式断言):它在两种执行角色上都仍然合法,
-- 而把 `wk` 已有的 `engineering` 抹掉才是「改事实」。

-- A1. 备份。两张表都必须先落一份 —— 顺序无依赖,先备份后 DROP。
CREATE TABLE m026_agents_backup AS SELECT * FROM agents;
CREATE TABLE m026_project_assignments_backup AS SELECT * FROM project_assignments;

-- A2. 放宽外键检查到**提交时**。这是本迁移能在事务里 DROP 掉一张被 15 条外键
--     指着的表的前提(实测:不加它,`DROP TABLE agents` 直接
--     `FOREIGN KEY constraint failed`,迁移装不上)。
--     ⚠️ 它**不**阻止 ON DELETE CASCADE —— 所以 A4 的备份灌回不能省。
PRAGMA defer_foreign_keys = ON;

-- A3. 丢掉旧表。`project_assignments` 会被级联清空(内容已在 A1),索引与触发器
--     一并消失(A8/A9 重建)。
DROP TABLE agents;

-- A4. 建同名新表:列定义与 007 逐字相同,**只改 role 的闭集**。
CREATE TABLE agents (
  id             TEXT PRIMARY KEY,
  role           TEXT NOT NULL CHECK (role IN (
                   'business_manager', 'project_manager', 'research_worker',
                   'coding_worker', 'quality_reviewer')),
  specialization TEXT CHECK (specialization IS NULL OR specialization IN (
                   'engineering', 'algorithm', 'data')),
  display_name   TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

-- A5. 灌回,并在这一步完成改名。**CASE 而不是先灌再 UPDATE**:一次成型,
--     少一次「改到一半失败」的机会。非 `worker` 的行原样搬运。
INSERT INTO agents (id, role, specialization, display_name, created_at)
  SELECT id,
         CASE role WHEN 'worker' THEN 'research_worker' ELSE role END,
         specialization,
         display_name,
         created_at
  FROM m026_agents_backup;

-- A6. 灌回被 A3 级联清空的成员关系。**少了这一步就是 012 那类静默删数据**
--     ——项目里会一个人都没有,而任何检查都不会报错。
--     必须排在 A5 之后:外键要能在父表里找到那 4 行。
INSERT INTO project_assignments (project_id, agent_id, added_at, removed_at)
  SELECT project_id, agent_id, added_at, removed_at FROM m026_project_assignments_backup;

-- A7. 中转表用完即删(守卫测试钉住 `%_backup` 计数必须为 0)。
DROP TABLE m026_agents_backup;
DROP TABLE m026_project_assignments_backup;

-- A8. 原样重建被 DROP 带走的两件东西 —— 触发器与索引,**故意不写 IF NOT EXISTS**:
--     名字若还被占着要响亮报错。
--
--     触发器的条件从「只对 worker」放宽到「只对两个执行角色」。它挡的是
--     「业务经理带一个 engineering 细分」这类配置事故 —— 判据是**角色集合**,
--     所以新增执行角色必须同步它,否则 `coding_worker` 一带细分就被拒。
CREATE TRIGGER agents_spec_only_worker
BEFORE INSERT ON agents
FOR EACH ROW WHEN NEW.specialization IS NOT NULL
     AND NEW.role NOT IN ('research_worker', 'coding_worker')
BEGIN
  SELECT RAISE(ABORT, 'specialization 只对执行角色(research_worker / coding_worker)有意义');
END;

CREATE INDEX idx_agents_role ON agents(role);

-- ════════════════════════════════════════════════════════════════
-- B 段 · artifacts.deliverable_type 闭集:1 个取值 → 2 个
-- ════════════════════════════════════════════════════════════════
--
-- 025 加了这一列,闭集刻意只有 `html_report`(理由见 025 文件头:7-E ——
-- **闭集里每个值都必须有真的写入口**,`git_repo` 当时一个字节的写入口都没有,
-- 写进闭集就是对外声明平台造得出它)。
--
-- 现在写入口有了(`code_service` 的坐标校验落在 `tools/blackboard.ts` +
-- `codeservice` 端口,见 B 段末尾),所以把它加进闭集。
--
-- ── ⚠️ 顺带更正 025 的一处**清单错误** ────────────────────────────
--
-- 025 的注释写「引用 `artifacts` 的子表是 **4 张**」,并列出
-- `artifact_links` ×2 / `asks.resolution_artifact_id` /
-- `project_sessions.deliverable_artifact_id`。**那份清单是错的** ——
-- 它漏了两张表、三条外键(**本轮动态核对发现**):
--
--   client_questions.question_artifact_id → CASCADE(**且是主键、NOT NULL**)
--   client_questions.answer_artifact_id   → NO ACTION
--   review_verdicts.finding_artifact_id   → NO ACTION
--
-- 真判据同样是动态的:`PRAGMA foreign_key_list(client_questions)` 等。
-- 这条错误如果照抄,`DROP TABLE artifacts` 会**级联删光整张
-- `client_questions`**(待答台账 —— 甲方问过什么、答没答,全在里面),
-- 而 `foreign_key_check` 一声不响。所以本文件按**实测清单**处置。
--
-- ── 处置方式:defer + 备份两条 CASCADE 子表 ──────────────────────
--
-- 与 A 段同一套判据。这里被级联清空的是 **两条**:
--   artifact_links(两条 CASCADE 外键,且是复合主键)
--   client_questions(question_artifact_id 是主键)
-- 其余三条(NO ACTION、且可空)靠 `defer_foreign_keys`:DROP 时先记违规,
-- 灌回之后提交,违规自动消失 —— **不必再把列置 NULL 再回填**(016 那套是在没有
-- defer 的前提下才需要的)。

-- B1. 先备份。`artifacts` 自己也要一份(它是被重建的那张)。
CREATE TABLE m026_artifacts_backup AS SELECT * FROM artifacts;
CREATE TABLE m026_artifact_links_backup AS SELECT * FROM artifact_links;
CREATE TABLE m026_client_questions_backup AS SELECT * FROM client_questions;

-- B2. 丢表。两条 CASCADE 子表被清空(内容已在 B1),7 条索引一并消失(B8 重建)。
DROP TABLE artifacts;

-- B3. 建同名新表:列定义 = 008 + 014 + 025 的完整现状,逐字相同,
--     **唯一改动是 `deliverable_type` 的闭集多一个 `code_service`**。
--     列顺序、NOT NULL、外键及其动作全部原样 —— 漏一个就是静默的语义漂移。
CREATE TABLE artifacts (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- 来源会话。**仍然不加外键**(008:28-31 的理由):工件必须比会话活得久。
  conversation_id TEXT,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'decision', 'note', 'evidence', 'hypothesis',
                    'project_brief', 'work_brief', 'meeting_note',
                    'review_finding', 'change_record', 'client_question',
                    'deliverable')),
  status          TEXT NOT NULL CHECK (status IN (
                    'open', 'accepted', 'rejected', 'superseded')),
  author_agent_id TEXT NOT NULL REFERENCES agents(id),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  metadata_json   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  -- 014 的产出边。**SET NULL 不是 CASCADE**:删工作项不该删产出。
  work_id         TEXT REFERENCES works(id) ON DELETE SET NULL,
  -- 025 的类型列。⚠️ `IS NULL OR …` 的形态是为了让**存量行合法** ——
  -- 025 之后仍可能有 `deliverable_type IS NULL` 的交付物(历史行),
  -- 而 `ALTER TABLE ADD COLUMN … CHECK` 对存量行不回溯校验这件事在这里无所谓:
  -- 本文件是**重建表**,存量行会被原样搬运,值仍然在闭集内(NULL 合法)。
  deliverable_type TEXT
    CHECK (deliverable_type IS NULL OR deliverable_type IN ('html_report', 'code_service'))
);

-- B4. 灌回工件。**显式列出每一列** —— `SELECT *` 在这里既会因为列数不匹配而
--     响亮失败,也更难看出列有没有被漏掉。
INSERT INTO artifacts (id, project_id, conversation_id, kind, status, author_agent_id,
                       title, body, metadata_json, created_at, updated_at, work_id,
                       deliverable_type)
  SELECT id, project_id, conversation_id, kind, status, author_agent_id,
         title, body, metadata_json, created_at, updated_at, work_id,
         deliverable_type
  FROM m026_artifacts_backup;

-- B5. 灌回关系边。**少了这一步就是静默删数据**(016 探针 B:1 → 0,检查干净)。
INSERT INTO artifact_links (artifact_id, rel, target_artifact_id)
  SELECT artifact_id, rel, target_artifact_id FROM m026_artifact_links_backup;

-- B6. 灌回待答台账。**这是 025 清单漏掉的那张表** —— 不灌回就是甲方问过的
--     每一个问题、每一次作答全部消失。
INSERT INTO client_questions (question_artifact_id, project_id, asked_by, asked_at,
                              answer_artifact_id, answered_at, consumed_at, consumed_by)
  SELECT question_artifact_id, project_id, asked_by, asked_at,
         answer_artifact_id, answered_at, consumed_at, consumed_by
  FROM m026_client_questions_backup;

-- B7. 中转表用完即删。
DROP TABLE m026_artifacts_backup;
DROP TABLE m026_artifact_links_backup;
DROP TABLE m026_client_questions_backup;

-- B8. 原样重建被 DROP 带走的**全部 7 条**索引 —— 008 五条 + 014 一条 + 025 一条。
--     谓词(DESC / WHERE)必须逐字保留:重建出一条不带
--     `WHERE deliverable_type IS NOT NULL` 的部分索引,是**静默的语义漂移**
--     (查询照跑,只是悄悄退化成全表扫)。
CREATE INDEX idx_artifacts_project ON artifacts(project_id);
CREATE INDEX idx_artifacts_kind    ON artifacts(project_id, kind);
CREATE INDEX idx_artifacts_status  ON artifacts(project_id, status);
CREATE INDEX idx_artifacts_author  ON artifacts(author_agent_id);
CREATE INDEX idx_artifacts_recent  ON artifacts(project_id, created_at DESC);
CREATE INDEX idx_artifacts_work    ON artifacts(work_id) WHERE work_id IS NOT NULL;
CREATE INDEX idx_artifacts_deliverable
  ON artifacts(project_id, deliverable_type) WHERE deliverable_type IS NOT NULL;
