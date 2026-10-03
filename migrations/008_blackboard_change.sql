-- 008 · BC3 Blackboard + BC4 ChangeControl
--
-- 与 007 同样的纪律:**只做加法**,不碰任何旧表。
--
-- ── 本迁移修正了设计 1 §8.1 的两个缺口 ───────────────────────────
--
-- ① **多对多关系原本没有存储**。`blocker_open` 的签名带 `blocksWorkIds[]`,
--    `change_propose` 带 `affectedWorkIds[]`,但 §8.1 的表清单里:
--    - blockers 表没有这个字段,也没有关联表 → 传进来的 work id **无处可放**
--    - change_requests 只有一个 `affected_work_ids_json` 文本列
--    本迁移补 `blocker_blocks` 与 `change_affects` 两张关联表。
--
-- ② **JSON blob 换成关联表**。`affected_work_ids_json` 不可查(「哪些变更影响
--    了 work X」在 SQL 层问不出来)、无外键完整性。旧 `blackboards.artifacts_json`
--    就是这么烂掉的:一个 JSON blob 加上几个没人说得清用途的兄弟列。
--    关联表两个问题一次解决。
--
-- ── 状态机全部落成 CHECK ─────────────────────────────────────────
-- 对应设计 1 §6.3。非法状态在写入时就失败,而不是等读出来才在类型层撒谎。

-- ── BC3 Blackboard ──────────────────────────────────────────────
--
-- 工件是**所有 BC 的可审计落点**(设计 1 §2.2),不是 BC1 的附属 ——
-- 所以它按 project_id 归属,conversation_id 只是可选的来源线索。
CREATE TABLE IF NOT EXISTS artifacts (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- 来源会话。**暂时不加外键**:新 conversations 表属 BC2(阶段 6),
  -- 而旧 conversations 表在计划删除之列 —— 绑上去等于把平台拴在待删的表上。
  -- BC2 落地时补 REFERENCES。
  conversation_id TEXT,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'decision', 'note', 'evidence', 'hypothesis',
                    'project_brief', 'work_brief', 'meeting_note',
                    'review_finding', 'change_record', 'client_question')),
  status          TEXT NOT NULL CHECK (status IN (
                    'open', 'accepted', 'rejected', 'superseded')),
  author_agent_id TEXT NOT NULL REFERENCES agents(id),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  metadata_json   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_kind    ON artifacts(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_artifacts_status  ON artifacts(project_id, status);
CREATE INDEX IF NOT EXISTS idx_artifacts_author  ON artifacts(author_agent_id);
-- 按项目 + 时间倒序取「最近发生了什么」是最常用的读法
CREATE INDEX IF NOT EXISTS idx_artifacts_recent  ON artifacts(project_id, created_at DESC);

-- 工件之间的关系。三种 rel 各自的语义:
--   parent      层级(work_brief 挂在 project_brief 下)
--   depends_on  依赖(与 work_deps 平行,但作用于工件层)
--   answers     应答(decision 工件回答某条 client_question)
CREATE TABLE IF NOT EXISTS artifact_links (
  artifact_id        TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  rel                TEXT NOT NULL CHECK (rel IN ('parent', 'depends_on', 'answers')),
  target_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  PRIMARY KEY (artifact_id, rel, target_artifact_id),
  CHECK (artifact_id <> target_artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_artifact_links_target ON artifact_links(target_artifact_id, rel);

-- ── BC4 ChangeControl ───────────────────────────────────────────
--
-- 阻塞与变更是**跨会话存活的一等实体**,不是工件的一个 kind ——
-- 它们有自己的状态机与生命周期(设计 1 §2.2)。
CREATE TABLE IF NOT EXISTS blockers (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  raised_by_agent_id  TEXT NOT NULL REFERENCES agents(id),
  title               TEXT NOT NULL,
  detail              TEXT NOT NULL,
  severity            TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status              TEXT NOT NULL CHECK (status IN (
                        'open', 'acknowledged', 'resolved', 'deferred', 'rejected')),
  created_at          INTEGER NOT NULL,
  resolved_at         INTEGER,
  resolution          TEXT
);

CREATE INDEX IF NOT EXISTS idx_blockers_project ON blockers(project_id, status);
CREATE INDEX IF NOT EXISTS idx_blockers_open    ON blockers(project_id, severity)
  WHERE status IN ('open', 'acknowledged');  -- 「未解决阻塞」是业务经理最常查的一屏

-- 阻塞挡住了哪些工作项(设计 1 §8.1 缺这张表)
CREATE TABLE IF NOT EXISTS blocker_blocks (
  blocker_id TEXT NOT NULL REFERENCES blockers(id) ON DELETE CASCADE,
  work_id    TEXT NOT NULL REFERENCES works(id)    ON DELETE CASCADE,
  PRIMARY KEY (blocker_id, work_id)
);

CREATE INDEX IF NOT EXISTS idx_blocker_blocks_work ON blocker_blocks(work_id);

CREATE TABLE IF NOT EXISTS change_requests (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  rationale           TEXT NOT NULL,
  impact_json         TEXT,                      -- 影响面描述(自由文本数组)
  status              TEXT NOT NULL CHECK (status IN (
                        'proposed', 'under_review', 'accepted', 'implemented', 'rejected')),
  decided_by_agent_id TEXT REFERENCES agents(id),
  created_at          INTEGER NOT NULL,
  decided_at          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_changes_project ON change_requests(project_id, status);

-- 变更影响了哪些工作项(取代设计里那个不可查的 affected_work_ids_json)
CREATE TABLE IF NOT EXISTS change_affects (
  change_id TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  work_id   TEXT NOT NULL REFERENCES works(id)           ON DELETE CASCADE,
  PRIMARY KEY (change_id, work_id)
);

CREATE INDEX IF NOT EXISTS idx_change_affects_work ON change_affects(work_id);
