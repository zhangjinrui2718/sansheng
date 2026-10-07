-- 028 · 知识语料(knowledge chunks + FTS5 索引)
--
-- 设计:`docs/DESIGN-KNOWLEDGE.md`。
--
-- ── 它是什么 / 不是什么 ───────────────────────────────────────────
--
-- 它是**只读检索语料**(设计里当 RAG 用):对话正文、工件正文、中间产出的
-- 可检索索引。它**不是记忆** —— 记忆(`memory_fragments` / `memory_profile`)
-- 关于**用户**、会淡忘、由模型写;语料关于**项目/组织**、不淡忘、由平台写。
-- 两套存储刻意分开(判据同 010 开头那句:会不会淡忘)。
--
-- ── 为什么只存索引,不存正文 ─────────────────────────────────────
--
-- 工件正文已经在项目仓(`artifacts.body_path` + `body_sha256`),会话正文
-- 已经在 `session_messages` 行里。再抄一份 = 两份真相,第二份一定会漂 ——
-- 工件那边已经为这件事做了 drifted / unavailable 三态(设计 §4.4)。
-- 所以这里只存:来源坐标 + 偏移区间 + 该块文本的哈希 + **检索用的分词列**。
--
-- ── 为什么有一个 seg 列 + FTS5 外部内容表 ────────────────────────
--
-- FTS5 的默认分词器对 CJK **不切词**,trigram 分词器对 1–2 字的查询又匹配不了
-- (2026-10-08 实测,见设计 §4 那张正负样本表)。所以索引列 `seg` 存的是按
-- bigram 切好、空格连接的文本(与 `memory/sqliteMemory.ts` 的 `tokenize()` 同一套切法),
-- 查询侧用同一套切法把 query 切成 `a OR b OR c` 再 MATCH。
-- 外部内容表(content='knowledge_chunks')让索引与行同一份真相,
-- 三个触发器负责同步 —— 这是 SQLite 文档里的标准写法。
--
-- ── 表名 ─────────────────────────────────────────────────────────
--
-- `knowledge_chunks` / `knowledge_fts` 都不在 001 的旧表里(不复用旧名是硬约束:
-- 并存期里 `CREATE TABLE IF NOT EXISTS` 撞名会静默无操作,新表根本建不出来)。
--
-- ⚠️ **没有 scope / tainted / visibility 列**:闭集里每个值都必须有真的写入口
-- (migration 025 那条纪律)。可见性门是 P2,见设计 §7 / §8。

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  -- 行号别名:供 FTS5 外部内容表用 content_rowid='chunk_rowid' 引用
  chunk_rowid   INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,
  -- 闭集。P1 只有这两类来源(work / project 是 P2)
  source_kind   TEXT NOT NULL CHECK (source_kind IN ('artifact', 'message')),
  source_id     TEXT NOT NULL,
  -- 归属项目:项目没了,它的语料也没有存在意义(外键 + 显式 prune 两条路)
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  artifact_id   TEXT,
  message_id    TEXT,
  work_id       TEXT,
  -- 同一来源内的块序号;UNIQUE 是 upsert 的锚点(幂等的另一半是 sha256)
  seq           INTEGER NOT NULL,
  -- 在**来源正文**里的字符区间。引用与 knowledge_read 的切片都靠它 ——
  -- 因此切块**不许改写原文**(只允许跳过空白),否则偏移会与正文对不上。
  offset        INTEGER NOT NULL CHECK (offset >= 0),
  length        INTEGER NOT NULL CHECK (length > 0),
  -- 该块文本的哈希(不是来源的哈希):相同则跳过,不同则替换
  sha256        TEXT NOT NULL,
  -- bigram 分词列(检索用)。**不是**给模型看的正文
  seg           TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (source_kind, source_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_source  ON knowledge_chunks(source_kind, source_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge_chunks(project_id);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  seg,
  content     = 'knowledge_chunks',
  content_rowid = 'chunk_rowid',
  tokenize    = 'unicode61'
);

-- 三个同步触发器:外部内容表的索引不会自己跟上行(标准写法,别省)
CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ai AFTER INSERT ON knowledge_chunks BEGIN
  INSERT INTO knowledge_fts(rowid, seg) VALUES (new.chunk_rowid, new.seg);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ad AFTER DELETE ON knowledge_chunks BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, seg) VALUES ('delete', old.chunk_rowid, old.seg);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_chunks_au AFTER UPDATE ON knowledge_chunks BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, seg) VALUES ('delete', old.chunk_rowid, old.seg);
  INSERT INTO knowledge_fts(rowid, seg) VALUES (new.chunk_rowid, new.seg);
END;
