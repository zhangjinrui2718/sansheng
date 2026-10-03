-- 010 · BC7 Memory
--
-- ── 表名为什么不用 fragments / user_profile ──────────────────────
--
-- 001 已经建过这两个名字。按 tests/platform/migrations.test.ts 的不变量,
-- 平台表不得复用旧表名 —— 并存期里 `CREATE TABLE IF NOT EXISTS` 撞名会
-- **静默无操作**,新表根本建不出来,报错落在下游的索引上(批次 5 真实事故)。
--
-- 所以平台侧叫 `memory_fragments` / `memory_profile`。
--
-- ── 记忆与工件的根本区别:会不会淡忘 ─────────────────────────────
--
--   记忆(memory_fragments)  关于**用户**的长期知识,可衰减
--   工件(artifacts)         关于**这个项目**的记录,不衰减
--
-- 用户偏好明年可能就变,所以记忆要能淡忘;一份已签字的决策永远有效,所以
-- 工件不能。这条判据决定了它们是两个存储,而不是同一张表加个 flag。
--
-- ── 与旧 memry 链路的关系 ───────────────────────────────────────
--
-- 旧的 `fragments` + `fragments_vec` 是**旧系统**的存储,本次升级整体删除
-- (设计 1 §8.3:向量链路零读方却持续付费)。平台侧不复用、不迁移 ——
-- 数据已弃。
--
-- 存储形态可替换:上层只依赖 MemoryPort(见 src/platform/memory/port.ts),
-- 换第三方记忆系统 = 换一个实现,agent 代码一行不动。所以这张表的列是
-- **参考实现的内部细节**,不是契约。

CREATE TABLE IF NOT EXISTS memory_fragments (
  id            TEXT PRIMARY KEY,
  -- 闭合集,与 ROLE_SPECS 的 writeKinds 无关 —— 记忆的分类是另一套词汇
  kind          TEXT NOT NULL CHECK (kind IN (
                  'fact', 'preference', 'project', 'context', 'summary')),
  content       TEXT NOT NULL CHECK (length(trim(content)) > 0),
  importance    REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  -- 衰减因子:久不访问则权重下降。0.95 = 每次衰减 5%
  decay_factor  REAL NOT NULL DEFAULT 0.95 CHECK (decay_factor > 0 AND decay_factor <= 1),
  access_count  INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER,
  created_at    INTEGER NOT NULL,
  -- 来源项目(可空:关于用户的记忆不必然来自某个项目)
  source_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  -- 去重键:同一内容不重复入库(旧系统缺这个,于是攒下大量重复片段)
  content_hash  TEXT NOT NULL,
  UNIQUE (content_hash)
);

CREATE INDEX IF NOT EXISTS idx_memory_kind    ON memory_fragments(kind);
CREATE INDEX IF NOT EXISTS idx_memory_rank    ON memory_fragments(importance DESC, created_at DESC);

-- 用户画像:关于「这个人是谁」的结构化摘要(与 fragment 的流水式记录互补)
CREATE TABLE IF NOT EXISTS memory_profile (
  id          TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
