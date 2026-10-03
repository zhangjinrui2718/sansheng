-- 007 · 平台核心(BC0 Identity + BC1 ProjectManagement)
--
-- ── 为什么是「并存」而不是「替换」────────────────────────────────────
--
-- 架构升级采用并行建新:新表用新名字,与旧表(conversations / messages /
-- fragments / user_profile / agent_states / blackboards)同处一个 SQLite。
-- 旧代码一行不动,直到它对应的 BC 被新模块替代、连同旧测试一起删除。
--
-- 因此本迁移**只做加法** —— 没有 DROP、没有 ALTER、不碰任何旧表。
-- DROP 旧表是最后阶段(设计 1 §10.3 阶段 8)的事。
--
-- ── 闭合集一律用 CHECK 约束 ──────────────────────────────────────
--
-- role / status / specialization 都是闭合联合(TS 侧有对应类型)。放进 CHECK
-- 是为了让「非法值」在写入时就失败,而不是等到读出来才在类型层撒谎。
-- 旧 blackboards 表的教训:它允许任意字符串,于是攒下了 goal / plan_json /
-- todos_json 三个恒空列,谁也不知道哪些值是真在用的。

-- ── BC0 Identity ────────────────────────────────────────────────
-- 角色是「全局的人」,不随项目变化。clientFacing 刻意**不入库** ——
-- 它是 ROLE_SPECS 的代码内属性,入库就有了被数据篡改的路径(设计 1 §4.3)。
CREATE TABLE IF NOT EXISTS agents (
  id             TEXT PRIMARY KEY,
  role           TEXT NOT NULL CHECK (role IN (
                   'business_manager', 'project_manager', 'worker', 'quality_reviewer')),
  specialization TEXT CHECK (specialization IS NULL OR specialization IN (
                   'engineering', 'algorithm', 'data')),
  display_name   TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

-- 只有 worker 需要 specialization;别的角色给了就是配置事故
CREATE TRIGGER IF NOT EXISTS agents_spec_only_worker
BEFORE INSERT ON agents
FOR EACH ROW WHEN NEW.specialization IS NOT NULL AND NEW.role <> 'worker'
BEGIN
  SELECT RAISE(ABORT, 'specialization 只对 worker 有意义');
END;

CREATE INDEX IF NOT EXISTS idx_agents_role ON agents(role);

-- ── BC1 ProjectManagement ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  client     TEXT NOT NULL,
  goal       TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN (
               'draft', 'active', 'paused', 'done', 'abandoned')),
  created_at INTEGER NOT NULL,
  closed_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

-- 关联表:只回答「这个项目里有谁」,不复制角色属性。
-- removed_at 用软删除(历史留痕:谁什么时候参与的,是审计面的一部分)。
CREATE TABLE IF NOT EXISTS project_assignments (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id   TEXT NOT NULL REFERENCES agents(id)   ON DELETE CASCADE,
  added_at   INTEGER NOT NULL,
  removed_at INTEGER,
  PRIMARY KEY (project_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_assignments_agent ON project_assignments(agent_id);

-- 工作项。assignee 是**必填** —— 设计 2 §3.6:拆解出的工作项不能无主,
-- 「交给谁」必须在创建时就有答案,否则进度无从追问。
CREATE TABLE IF NOT EXISTS works (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_work_id    TEXT REFERENCES works(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  goal              TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN (
                      'open', 'in_progress', 'blocked', 'done', 'failed', 'cancelled')),
  assignee_agent_id TEXT NOT NULL REFERENCES agents(id),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_works_project  ON works(project_id);
CREATE INDEX IF NOT EXISTS idx_works_assignee ON works(assignee_agent_id);
CREATE INDEX IF NOT EXISTS idx_works_parent   ON works(parent_work_id);
CREATE INDEX IF NOT EXISTS idx_works_status   ON works(status);

-- 依赖边。DAG 的环检测在 repo 层做(见 repo/works.ts createsCycle)——
-- SQL 层表达不了,而且旧代码在这里踩过「DAG 通配 bug」(设计 1 §2.2 记录)。
CREATE TABLE IF NOT EXISTS work_deps (
  work_id            TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  depends_on_work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  PRIMARY KEY (work_id, depends_on_work_id),
  -- 自环直接由 schema 拒绝;多跳环由 repo 层拒绝
  CHECK (work_id <> depends_on_work_id)
);

CREATE INDEX IF NOT EXISTS idx_deps_reverse ON work_deps(depends_on_work_id);
