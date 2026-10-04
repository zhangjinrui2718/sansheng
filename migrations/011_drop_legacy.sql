-- 011 · 清场:删除旧系统的表
--
-- ── 这些表是什么 ────────────────────────────────────────────────
--
-- 它们属于**已被删除的旧系统**(`src/server/**`,2026-10-04 批次 15 清场)。
-- 新平台的表见 007_platform_core / 008_blackboard_change / 009_collaboration /
-- 010_memory。
--
--   agent_states   旧的角色运行态(新架构里没有这个概念:角色是全局的人)
--   blackboards    旧的黑板容器(新的 artifacts 直接挂项目,不需要容器层)
--   conversations  旧的会话(新的是 project_sessions,以项目为界)
--   fragments      旧的记忆片段(新的是 memory_fragments)
--   messages       旧的会话消息(新的是 session_messages)
--   user_profile   旧的用户画像(新的是 memory_profile)
--
-- ── 为什么不写数据迁移 ──────────────────────────────────────────
--
-- 用户 2026-10-03 的决策(设计 1 §0.2 原文):「**不保留任何存量数据**。
-- 迁移不写双写、不写回填,直接重置 schema。」
--
-- 2026-10-23 再次明确:「不要考虑兼容性的问题,一切以最新的为准,如果有冲突
-- 删掉老的写新的,在最新的设计思路和方案下。」
--
-- 所以这里是纯粹的 DROP,没有 INSERT INTO ... SELECT,没有回填。
--
-- ── 关于碎片化的向量索引 ────────────────────────────────────────
--
-- `002_vec.sql` 建的 `fragments_vec*` 系列(sqlite-vec 虚拟表)也跟着旧
-- fragments 一起走 —— 它们的向量链路在新架构里没有对应物(设计 1 §11:
-- 「向量检索 → 文本检索(经 MemoryPort);零读方,纯付费」)。
--
-- ⚠️ **顺序**:必须先删虚拟表再删它的影子表。虚拟表被 DROP 时会连带清理,
-- 但 sqlite-vec 的 `*_info` / `*_chunks` / `*_rowids` 是独立表,显式删更稳。

-- 旧记忆的向量索引。
--
-- ⚠️ **只能 DROP 虚拟表本身,不能显式 DROP 它的影子表。**
-- sqlite-vec 的 `fragments_vec_rowids` / `_chunks` / `_info` 等是虚拟表的内部
-- 结构,SQLite 拒绝直接删除(`table fragments_vec_rowids may not be dropped`)。
-- 删虚拟表时它们会被一起清理。第一次写这段时我把影子表也列上了,整个 011
-- 因此报错 —— 而报错发生在建库阶段,连带把十条无关的测试一起打红。
DROP TABLE IF EXISTS fragments_vec;

-- 旧系统的业务表
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS fragments;
DROP TABLE IF EXISTS user_profile;
DROP TABLE IF EXISTS blackboards;
DROP TABLE IF EXISTS agent_states;
