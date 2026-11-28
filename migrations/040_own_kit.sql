-- 040 · 自己的仓库与经验库(agent_notes / agent_tool_disables,2026-11-28)
--
-- ── 它补的是什么 ────────────────────────────────────────────────
--
-- 三生里每一样东西都按**项目**分:工作区、知识语料、工件。角色级只有提示词单元、
-- 工具集合文件、MCP 授权三类配置 —— 没有任何属于「这一个角色、跨项目留着」的存储。
-- 于是同一个坑每个项目踩一遍,同一份调研每个项目重做一遍。
--
-- 用户原话(2026-11-28):「给工程师、质检员、研究员两类专属的 harness 内容 …
-- 一个独立的代码仓库 … 根据要经常解决的问题或者职责去拓宽自己的能力 …
-- 研究员构建一个有自己的 rag 服务,平时经验、外部调研等等这些内容都可以放进去」
-- 与裁决「自己的 rag 和代码仓库不需要我放行」。
--
--   · `agent_notes` —— **经验库**:一个角色自己的条目(经验 / 调研),全文检索。
--     平台自带检索(FTS5),这就是「自己的 rag」的底座;他想搭更强的,往自己
--     仓库里放一个 MCP 服务。
--   · `agent_tool_disables` —— 人按下的**刹车**:哪条自己仓库里的工具被停用了。
--     不放行 ⇒ 没有「待审 / 通过 / 退回」那套状态;唯一需要落库的人工动作是停用。
--
-- ── 经验库 ≠ 记忆 ≠ 语料(三套东西,别并)─────────────────────────
--
--   记忆(`memory_fragments`)  关于**用户**,业务经理写,会淡忘
--   知识语料(`knowledge_chunks`)关于**项目**,平台索引,角色只读,**只存偏移不存正文**
--   经验库(`agent_notes`)     关于**这个角色自己的手艺**,角色自己写,跨项目
--
-- 经验库**直接存正文**:条目本身就是内容,别处没有一份「原文」可以指 —— 照搬语料
-- 那套「只存索引」会得到一个指向空气的偏移。
--
-- ── 为什么有一个 seg 列 + FTS5 外部内容表 ────────────────────────
--
-- 与 028 同一条理由:FTS5 默认分词器对 CJK 不切词。`seg` 存 bigram 列,查询侧用
-- 同一套切法(`shared/text.ts`)。外部内容表 + 三个触发器是 SQLite 文档里的标准写法。
--
-- ── 取值域不建 CHECK ────────────────────────────────────────────
--
-- `agent_notes.kind`(lesson | research)、`agent_notes.status`(active | retired)
-- 闭集在读写两侧的 TS(`storage/repo/agentNotes.ts`)—— 与 022 / 030 / 039 同一条先例。
--
-- ── 隔离 ───────────────────────────────────────────────────────
--
-- 工具面按 `agent_id` 隔离:一个角色只检索得到自己的条目。⚠️ 这是一条**新的跨项目
-- 通道** —— 调研条目里的外部内容会跟着角色进以后每一个项目。平台判不了一段文字
-- 从哪来(030 那条纪律),所以 `research` 类条目在工具层**强制带出处**,而「来源
-- 可信度」如实不做(见 `web/src/lib/glossary.ts` 的 KNOWN_GAPS)。
--
-- ── 本迁移只做加法 ──────────────────────────────────────────────
--
-- 两条 `CREATE TABLE` + 一条 FTS5 虚表 + 三个触发器 + 一条索引,不写 `IF NOT EXISTS`。
-- 外键:`agent_notes.agent_id → agents`(CASCADE)、`agent_tool_disables.agent_id →
-- agents`(CASCADE)、`agent_notes.source_project_id → projects`(SET NULL:项目没了,
-- 「这条经验是在哪学的」这句话失去指向,但经验本身还在)—— 两张表在
-- `host/reset.ts` 清库清单里都排在父表之前。

CREATE TABLE agent_notes (
  -- 行号别名:供 FTS5 外部内容表用 content_rowid='note_rowid' 引用(与 028 同款)
  note_rowid    INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,
  -- 这条经验属于谁。工具面按它隔离 —— 一个角色只看得到自己的。
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- lesson | research —— 闭集在 TS
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  -- 出处。research 类**必填**(工具层强制);lesson 类可空。
  source        TEXT,
  -- 这条经验是在哪个项目里学到的;NULL = 没有项目(接待阶段)或项目已删除。
  source_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  -- bigram 分词列(检索用)。**不是**给模型看的正文
  seg           TEXT NOT NULL,
  -- active | retired —— 闭集在 TS。退休的条目不再被检索到,但读得到、可改回复活。
  status        TEXT NOT NULL,
  retire_reason TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 人读面「最近条目」与工具面的条数上限都按 (agent_id, status, updated_at) 查。
CREATE INDEX idx_agent_notes_agent ON agent_notes(agent_id, status, updated_at);

CREATE VIRTUAL TABLE agent_notes_fts USING fts5(
  seg,
  content       = 'agent_notes',
  content_rowid = 'note_rowid',
  tokenize      = 'unicode61'
);

-- 三个同步触发器:外部内容表的索引不会自己跟上行(标准写法,别省)
CREATE TRIGGER agent_notes_ai AFTER INSERT ON agent_notes BEGIN
  INSERT INTO agent_notes_fts(rowid, seg) VALUES (new.note_rowid, new.seg);
END;

CREATE TRIGGER agent_notes_ad AFTER DELETE ON agent_notes BEGIN
  INSERT INTO agent_notes_fts(agent_notes_fts, rowid, seg) VALUES ('delete', old.note_rowid, old.seg);
END;

CREATE TRIGGER agent_notes_au AFTER UPDATE ON agent_notes BEGIN
  INSERT INTO agent_notes_fts(agent_notes_fts, rowid, seg) VALUES ('delete', old.note_rowid, old.seg);
  INSERT INTO agent_notes_fts(rowid, seg) VALUES (new.note_rowid, new.seg);
END;

CREATE TABLE agent_tool_disables (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- 自己仓库里那个工具目录的名字(`tools/<tool_name>/`)。仓库不在了、目录删了,
  -- 这一行留着 —— 目录回来时它仍然是停用的(停用是人的决定,不因文件挪动而失效)。
  tool_name   TEXT NOT NULL,
  -- 人按下刹车的时刻(毫秒)。
  disabled_at INTEGER NOT NULL,
  UNIQUE (agent_id, tool_name)
);
