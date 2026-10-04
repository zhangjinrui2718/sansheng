-- 016 · 放宽 `artifacts.kind` 的闭集(「交付物」要有结构化的落点)
--
-- ── 它补的是什么 ────────────────────────────────────────────────
--
-- 设计 1 §2.11.5:「整合完没有 / 交付了没有」这一段流程的推进由
-- **`deliverable` 工件的存在性**表达(工件即推动流程),而不是在 `works` 上再加一列
-- —— `works.status` 继续管执行、`works.review_state` 继续管审查,各管一段。
--
-- 而 `artifacts.kind` 是 CHECK 闭集(008:32-35,10 个取值),`deliverable` 写不进去。
-- 本迁移只做一件事:把这个闭集放宽到含 `deliverable`。**写入侧零代码改动**
-- (`identity/role.ts` 的 `ARTIFACT_KINDS` 与六处同步面是 C2,不是本文件)。
--
-- ── 为什么是「重建表」,而不是 ALTER ─────────────────────────────
--
-- 与 015 同一个理由,实测原文见 `015_dispatch_event_kinds.sql:18-31`:
-- SQLite 没有 `ALTER COLUMN`;而 `ALTER TABLE ... ADD CONSTRAINT ... CHECK` 在本构建
-- (3.53.4)上**无错应用、而约束一个字节都没变**(多个 CHECK 之间是 AND,只能收紧)。
-- 本文件又独立复核了一遍(探针 D,`.tmp016/probe.mjs`,已删):
--
--   ADD CONSTRAINT(含 'deliverable')  → **无错应用**
--   写 kind='deliverable'             → 仍被拒:CHECK constraint failed(闭集 10 个)
--
-- ── ⚠️⚠️ 本表与 015 那张不同:它**有三条外键指进来** ──────────────
--
--   artifact_links.artifact_id        → artifacts(id) ON DELETE CASCADE   (008:58)
--   artifact_links.target_artifact_id → artifacts(id) ON DELETE CASCADE   (008:60)
--   asks.resolution_artifact_id       → artifacts(id) 无 ON DELETE = NO ACTION (009:75)
--
-- 静态核对:`grep -rn 'REFERENCES artifacts' migrations/` = **3 处**,一个不多。
-- 动态核对(探针 A,遍历全库 `PRAGMA foreign_key_list`):
--   正样本 引用 `projects` 的表 = 11 张 / 引用 `agents` 的表 = 10 张   ← 探测器没坏
--   被测   引用 `artifacts` 的表 = [artifact_links, asks],共 3 条外键 ← 与静态一致
--
-- `DROP TABLE` 会做一次**隐式 DELETE**(012 的真实事故:`DROP TABLE project_sessions`
-- 把全部 `session_messages` 级联删光,而 `foreign_key_check` 一声不响)。
-- 所以「建 _new → 拷 → DROP 旧的 → 改名」这套(015 在 `dispatch_events` 上用过的)
-- 在**本表**上会分叉成两种行为,而哪一种发生取决于运行时数据:
--
--   探针 B/C(真 schema 001→015,`foreign_keys = ON`,带正负样本自检;
--            样本非空:artifacts 2 行 / artifact_links 1 行,否则「不变」是空的):
--     朴素重建 + asks 里有一条非空 resolution_artifact_id
--       → **响亮失败** `FOREIGN KEY constraint failed`,事务回滚,**零损失**
--     朴素重建 + asks 全 NULL
--       → **成功**,`artifacts` 完好(2 行),而 **`artifact_links` 从 1 变成 0**;
--         `foreign_key_check = []` —— **一声不响**
--   用户真机库(副本)现状:asks = 0 · artifact_links = 0
--       → 今天走的正是**第二条**,而行数恰好是 0,所以肉眼看不出差别。
--
-- ⇒ **「在我机器上它报错了,所以我加了对的处置」不可移植。** 唯一的正确 recipe 是
-- 012 那套「先把内容移出去 → 重建 → 灌回」,而且**必须先备份子表**(012:38-46)。
--
-- ── 设计稿 §2.11.5 的 8 行 recipe 有**三处漏**,本文件逐条纠正 ──────
--
--   漏① **索引不是 5 个,是 6 个。** 设计稿写「显式重建 008 的全部五个索引」,
--        但 014:66 又给 `artifacts` 加了一条部分索引
--        `idx_artifacts_work ON artifacts(work_id) WHERE work_id IS NOT NULL`。
--        照设计稿只重建 008 那五个,这一条会随 `DROP TABLE` **静默消失**
--        —— 查询照跑,只是悄悄退化成全表扫。核对方式(两条独立证据):
--          · 静态 `grep -rn 'idx_artifacts' migrations/` → 6 个名字(008 五个 + 014 一个)
--          · 动态 真 schema 上 `SELECT name FROM sqlite_master WHERE type='index'
--            AND tbl_name='artifacts' AND name NOT LIKE 'sqlite_autoindex%'` → 6 条
--        本文件第 10 步把这 **6** 条全部显式重建,谓词(DESC / WHERE)逐字保留。
--
--   漏② **新表的列不止 008 那 11 个:014 给 `artifacts` 加了 `work_id`**
--        (`TEXT REFERENCES works(id) ON DELETE SET NULL`,014:57)。
--        若照设计稿「把 008 的 CREATE TABLE 抄过来只改 CHECK」,`work_id` 会
--        (a) 整列不存在,或 (b) 按 008 的列清单灌回而**把全部 work_id 静默置空**
--        —— 后者实测过(探针 E「设计稿字面 recipe」):迁移成功、零报错,
--        而 `work_id` 全部变成 NULL,`idx_artifacts_work` 也没了。
--        本文件第 5 步的列定义是 **008 + 014 的完整现状**,列顺序原样,
--        只在 `kind` 的闭集里加一个取值。
--
--   漏③ **`asks.resolution_artifact_id` 的 NO ACTION 会让迁移装不上。**
--        设计稿把「响亮失败」当成安全分支 —— 它确实不丢数据,但**迁移装不上**
--        (只库里有一条作答记录就够)。本文件把它也搬进中转表:第 3 步把非空值
--        移出并置 NULL,第 8 步在工件灌回之后**原样回填**。全程在迁移器的事务里,
--        失败整体回滚。守卫见 `tests/platform/migrations.test.ts`
--        (asks 逐字不变的断言;负样本:手写一条朴素重建在这份数据上必须响亮失败)。
--
-- ── 登记 ────────────────────────────────────────────────────────
--
-- 本文件里的 `CREATE TABLE artifacts` 与 008 同名 —— 那是有意的重建,已在
-- `tests/platform/migrations.test.ts` 的 `INTENTIONAL_REBUILDS` 里**逐表登记**
-- (artifacts ← 008 + 016)。未登记的重名仍然是错误(批次 5 的事故形态)。
--
-- ── 静默失败面(本文件逐条处置)────────────────────────────────
--   ① 子表被级联清空   → 第 1 步先备份 `artifact_links`,第 7 步灌回
--   ② 索引随 DROP 消失 → 第 10 步显式重建**全部 6 条**,一条不少
--   ③ 列被漏掉/漂移    → 第 5/6 步的列清单与 008+014 逐字相同(含 work_id)
--   ④ asks 的 NO ACTION 让迁移装不上 → 第 3 / 8 步的中转 + 回填
--   ⑤ 备份表残留       → 第 9 步显式 DROP(守卫测试钉住 `%_backup` 计数为 0)
--
-- 至于「重建前后行数与内容必须逐字不变」:本文件不写自检断言 —— SQLite 没有
-- `RAISE`(触发器之外),一个**永远不会触发**的检查只是装饰。它落在测试与探针里
-- (见 `tests/platform/migrations.test.ts` 的 016 一组),那里能做逐字对比、能带正负样本。
--
-- 全程在迁移器的事务里(`infra/migrations.ts` 的 `db.transaction`),
-- 中途任何一步失败都整体回滚,中转表不会残留。

-- 1. 子表先备份。**这一步不能省**(设计稿 012 那套 recipe 的第 1 步)——
--    第 4 步的隐式 DELETE 会把 `artifact_links` 级联清空,而它一声不响。
CREATE TABLE artifact_links_backup AS SELECT * FROM artifact_links;

-- 2. 本表备份(`work_id` 也在里面 —— 漏了它就是把 014 那条边静默删掉)
CREATE TABLE artifacts_backup AS SELECT * FROM artifacts;

-- 3. `asks.resolution_artifact_id` 是 NO ACTION:只要有一条非空引用,
--    第 4 步的 DROP 就会响亮失败并回滚整个迁移(安全,但迁移装不上)。
--    所以先把这一列的非空值移出、置 NULL(NULL 永远合法),第 8 步回填。
CREATE TABLE asks_resolution_backup AS
  SELECT id, resolution_artifact_id FROM asks WHERE resolution_artifact_id IS NOT NULL;
UPDATE asks SET resolution_artifact_id = NULL WHERE resolution_artifact_id IS NOT NULL;

-- 4. 丢掉旧表。级联会清空 artifact_links(内容已在 ①),6 条索引会一并消失
--    —— 第 10 步重建。
DROP TABLE artifacts;

-- 5. 建同名新表:列定义 = 008 + 014 的完整现状,逐字相同;
--    唯一改动是 kind 的闭集多一个 'deliverable'。
--    (列顺序、NOT NULL、三个外键及其动作都必须原样保留 —— 漏一个就是静默的语义漂移)
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
  -- 014 的产出边。**SET NULL 不是 CASCADE**(014:54-56):删工作项不该删产出。
  work_id         TEXT REFERENCES works(id) ON DELETE SET NULL
);

-- 6. 灌回工件。**显式列出每一列,含 work_id** —— 「SELECT *」在这里既会因为
--    列数不匹配而响亮失败,也更难看出列有没有被漏掉。
INSERT INTO artifacts (id, project_id, conversation_id, kind, status, author_agent_id,
                       title, body, metadata_json, created_at, updated_at, work_id)
  SELECT id, project_id, conversation_id, kind, status, author_agent_id,
         title, body, metadata_json, created_at, updated_at, work_id
  FROM artifacts_backup;

-- 7. 灌回子表。**少了这一步就是 012 那类静默删数据**(探针 B:1 → 0,且检查干净)。
INSERT INTO artifact_links (artifact_id, rel, target_artifact_id)
  SELECT artifact_id, rel, target_artifact_id FROM artifact_links_backup;

-- 8. 回填 `asks` 的作答边(第 3 步置 NULL 的那些)。工件 id 一个没变,
--    所以这里回填的就是原来那些 id。
UPDATE asks SET resolution_artifact_id = (
    SELECT b.resolution_artifact_id FROM asks_resolution_backup b WHERE b.id = asks.id)
  WHERE EXISTS (SELECT 1 FROM asks_resolution_backup b WHERE b.id = asks.id);

-- 9. 中转表用完即删。留着它们不只是脏 —— `artifacts_backup` 会永久占着
--    一份工件快照,而守卫测试钉住 `%_backup` 计数必须为 0。
DROP TABLE artifacts_backup;
DROP TABLE artifact_links_backup;
DROP TABLE asks_resolution_backup;

-- 10. 原样重建被 DROP TABLE 带走的**全部 6 条**索引 —— 008 的五条 + 014 的一条。
--     **故意不写 `IF NOT EXISTS`**(照 015 的纪律):名字若还被别的东西占着,
--     要**响亮报错**,而不是安静地什么都不建。谓词(DESC / WHERE)必须逐字保留
--     —— 重建出一条不带 `WHERE work_id IS NOT NULL` 的 idx_artifacts_work
--     也是静默的语义漂移。
CREATE INDEX idx_artifacts_project ON artifacts(project_id);
CREATE INDEX idx_artifacts_kind    ON artifacts(project_id, kind);
CREATE INDEX idx_artifacts_status  ON artifacts(project_id, status);
CREATE INDEX idx_artifacts_author  ON artifacts(author_agent_id);
CREATE INDEX idx_artifacts_recent  ON artifacts(project_id, created_at DESC);
CREATE INDEX idx_artifacts_work    ON artifacts(work_id) WHERE work_id IS NOT NULL;
