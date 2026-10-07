-- 027 · 工件正文落文件:`artifacts.body` → 索引四列
--       (`body_path` / `body_sha256` / `body_bytes` / `commit_sha`)
--
-- ── 依据 ────────────────────────────────────────────────────────
--
-- 设计 `docs/DESIGN-WORKSPACE.md` §4.1(终态 schema)与 §5(一次性交付、没有迁移)。
-- 用户原话(2026-10-08):
--   第 3 条「数据库里不要存真实内容,存一个索引就好了」;
--   第 6 条「老的数据可以完全不要,一会就要重置 sansheng」。
--
-- ── 为什么是「重建表」而不是 ALTER ────────────────────────────────
--
-- SQLite 没有 `ALTER COLUMN`;而 `ALTER TABLE … ADD COLUMN body_path TEXT NOT NULL`
-- 在**有存量行**的表上也加不上去(NOT NULL 要求每一行都有值;要加就得带 DEFAULT
-- —— 那是给每一行编一个**平台没写过**的落点,比没有更坏)。与 015 / 016 / 026
-- 同一条理由,只有重建表这一条路。
--
-- ── ⚠️⚠️ 本表与 016 / 026 那两次重建的关键不同:**这次没有数据要搬** ──
--
-- 输入 6 已经把存量工件判为不要(179 条正文随 reset 消失),于是:
--   · **没有 `_backup` 中转表**、**没有 `INSERT INTO … SELECT`**、**没有目录归位**
--     —— 设计 §5 明写「不写回填脚本、不做目录归位、不建 `_unassigned/`、
--     不保留 `body_legacy` 过渡列」;
--   · 016 那套「先备份 CASCADE 子表再灌回」在这里**故意不做**:它存在的理由是
--     保住子表的行,而本迁移的前提是「跑到这一步时 artifacts 是空的」。
--
-- ── 前提写成一条**会响的前置检查**,不是一句注释 ────────────────────
--
-- 「没有数据迁移」+「`DROP TABLE` 的隐式 DELETE 会级联清空子表」叠起来,正好是本项目
-- 最贵的那类失败(012 的形态):在**非空**库上静默清空 `artifacts`,连同 CASCADE 子表
-- `artifact_links`(**产出/关于**的边)与 `client_questions`(待答台账),而
-- `foreign_key_check` 一声不响。
-- 设计输入 6 说「用户会 reset」——但它没说「**忘了** reset 时会怎样」。所以第 1 步把
-- 「这张表必须已经是空的」变成一条真的会响的约束(`CHECK (n = 0)`):
--
--   空库     → 通过(这是唯一支持的路径:`reset` 之后,或 `--data <新目录>` 首跑);
--   有工件行 → **响亮失败**(`CHECK constraint failed: requires_empty_artifacts`),
--              `infra/migrations.ts` 的事务整体回滚,老行一条不少 —— 处置就写在错误里。
--
-- 判据在 `tests/platform/migrations.test.ts` 的 027 一组(正负样本各一条:
-- 空库装得上;有工件行时**失败且行数逐字不变**)。
--
-- ── 列定义 ──────────────────────────────────────────────────────
--
-- 除 `body` 一列换成下面四列外,其余与 026 的 B 段逐字相同:列顺序、NOT NULL、
-- 三个外键及其动作(projects CASCADE / agents NO ACTION / works SET NULL)、
-- kind 11 值、status 4 值、deliverable_type 2 值。**DROP TABLE 会带走全部 7 条索引**
-- (008 五条 + 014 一条 + 025 一条),第 4 步逐条原样重建。
--
--   body_path   TEXT NOT NULL     项目根相对路径,如 `artifacts/art_x-report.html`
--                                 (由平台生成,见设计 §4.3 —— 不让模型编路径)
--   body_sha256 TEXT NOT NULL     写入那一刻的正文哈希(对账用;**快照**,不是现值)
--   body_bytes  INTEGER NOT NULL  写入那一刻的字节数(**快照**)
--   commit_sha  TEXT              引入正文的提交(平台提交后回填);**未提交时 NULL
--                                 是合法状态**,不是缺参数
--
-- ⚠️ `body_path` **没有**「仅 `code_service` 可为 NULL」的例外(设计 §4.1 末那处更正):
-- 每个工件都有正文(`board_write` 的 `body` 必填),`code_service` 的正文就是那份
-- markdown 说明,仓库坐标在 `metadata_json`。所以三列全 NOT NULL —— 分支更少、判据更强。
--
-- ⚠️ `commit_sha` 与前三列**分开**:前三列是平台写文件那一刻就有的事实,它是**后来**
-- 被回填的(设计 §3.4 第 4 步),所以放表尾(与 025 的 `deliverable_type` 同一个位置策略)。
--
-- ── 登记 ────────────────────────────────────────────────────────
--
-- 本文件的 `CREATE TABLE artifacts` 与 008 / 016 / 026 同名 —— 那是有意的重建,已在
-- `tests/platform/migrations.test.ts` 的 `INTENTIONAL_REBUILDS` 里**逐表登记**
-- (artifacts ← 008 + 016 + 026 + 027)。未登记的重名仍然是错误(批次 5 的事故形态)。
--
-- ⚠️ 也因此**不能**把新表命名成 `m027_artifacts_new` 再 RENAME:重名守卫数的是
-- `CREATE TABLE` 的表名,改名法会让「artifacts 被多个迁移创建」这条登记**当场过期**
-- (`登记不得过期` 那条断言会红)。没有数据要拷时,改名法本来也没有任何收益。

-- 1. 前置检查:老数据不迁移 ⇒ 这张表必须已经是空的。非空 = 还没 reset
--    ⇒ **响亮失败**并整体回滚(不静默清空)。约束名就是给用户看的那句话。
CREATE TABLE m027_precheck (
  n INTEGER NOT NULL,
  CONSTRAINT requires_empty_artifacts CHECK (n = 0)
);
INSERT INTO m027_precheck (n) SELECT COUNT(*) FROM artifacts;
DROP TABLE m027_precheck;

-- 2. 丢旧表。第 1 步保证它是空的 ⇒ 隐式 DELETE 没有行、级联不动任何子表;
--    7 条索引随 DROP 一起消失(第 4 步重建)。**不写 IF EXISTS**:它不在就该响。
DROP TABLE artifacts;

-- 3. 建同名新表:列定义 = 026 的 B 段逐字,唯一改动是 `body` 换成四列。
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
  -- 027:正文的落点与写入快照(内容在项目仓里,见设计 §4.1 / §4.3)
  body_path       TEXT NOT NULL,
  body_sha256     TEXT NOT NULL,
  body_bytes      INTEGER NOT NULL,
  metadata_json   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  -- 014 的产出边。**SET NULL 不是 CASCADE**:删工作项不该删产出。
  work_id         TEXT REFERENCES works(id) ON DELETE SET NULL,
  -- 025 的类型列(026 放宽到 2 个取值)。`IS NULL OR …` 的形态原样保留:
  -- 非交付物工件这一列就是 NULL。
  deliverable_type TEXT
    CHECK (deliverable_type IS NULL OR deliverable_type IN ('html_report', 'code_service')),
  -- 027:引入正文的提交 —— 平台 housekeeping 提交后回填(设计 §3.4)。
  -- **NULL 是合法状态**(工件刚插进来、还没提交),不是缺参数。
  commit_sha      TEXT
);

-- 4. 原样重建被 DROP TABLE 带走的**全部 7 条**索引 —— 008 五条 + 014 一条 + 025 一条。
--    **故意不写 `IF NOT EXISTS`**(照 015/016/026 的纪律):名字若还被占着要响亮报错。
--    谓词(DESC / WHERE)必须逐字保留 —— 重建出一条不带 `WHERE work_id IS NOT NULL`
--    的部分索引是**静默的语义漂移**(查询照跑,只是悄悄退化成全表扫)。
CREATE INDEX idx_artifacts_project ON artifacts(project_id);
CREATE INDEX idx_artifacts_kind    ON artifacts(project_id, kind);
CREATE INDEX idx_artifacts_status  ON artifacts(project_id, status);
CREATE INDEX idx_artifacts_author  ON artifacts(author_agent_id);
CREATE INDEX idx_artifacts_recent  ON artifacts(project_id, created_at DESC);
CREATE INDEX idx_artifacts_work    ON artifacts(work_id) WHERE work_id IS NOT NULL;
CREATE INDEX idx_artifacts_deliverable
  ON artifacts(project_id, deliverable_type) WHERE deliverable_type IS NOT NULL;
