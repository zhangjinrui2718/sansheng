# 知识语料(knowledge)· 设计

> 2026-10-08 决策:**把所有角色的对话、项目、工件、中间产出做成一个只读的检索语料(当作 RAG 用),而不是记忆。**
> 记忆(`memory_fragments` / `memory_profile` / `MemoryPort` / `memory_remember` / 记忆页)**保持现状不变** ——
> 两者是两件事,生命周期相反,不要合并。

## §1 边界:memory 与 knowledge 是两套系统

| | memory(不变) | knowledge(本篇) |
|---|---|---|
| 记什么 | **用户**是谁、偏好什么、项目背景 | **项目/组织**的语料:对话正文、工件正文、中间产出 |
| 谁写 | 模型(业务经理 `memory_remember`) | **平台**,确定性索引,**零 token** |
| 生命周期 | 会淡忘(importance / decay) | 不淡忘;随来源删除而失效 |
| 存储 | 库内 TEXT(`memory_fragments`) | 库内**只有索引**(来源坐标 + 偏移 + 哈希 + 分词列);正文留在原处 |
| 读口 | `memory_search`(≤5 条短片段) | `knowledge.read` → `knowledge_search` / `knowledge_read` |
| 边界 | 关于用户 | 关于项目 / 组织 |

判据与 `migrations/010_memory.sql` 开头那句同源:**会不会淡忘**。
用户偏好明年可能就变(记忆),一份已签字的决策永远有效(语料)。

⚠️ **本系统不是 LLM Wiki 的"编译层"。** [karpathy 的 LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 描述的是
"LLM 增量维护的 markdown 页 + index.md + log.md";本项目这一期只做它的**前一半**:语料 + 索引 + 检索。
**代码里叫 `knowledge`,不叫 `wiki`** —— 名字不许承诺平台还没造出来的东西(7-E)。

## §2 语料不复制正文

工件正文已经在项目仓(`artifacts.body_path` + `body_sha256`),会话正文已经在 `session_messages` 行里。
所以 chunk 表**只存索引**:来源坐标、偏移、哈希、检索用的分词列。正文现读。

理由:复制一份正文 = 两份真相,第二份会漂 —— 工件那边已经为这件事做了 `drifted` / `unavailable` 三态
(`docs/DESIGN-WORKSPACE.md` §4.4),语料不该再造一个更弱的版本。

## §3 表结构(migration 028)

```
knowledge_chunks(chunk_rowid INTEGER PK, id TEXT UNIQUE, source_kind, source_id,
                 project_id → projects(id) ON DELETE CASCADE,
                 artifact_id, message_id, work_id,
                 seq, offset, length, sha256, seg, created_at, updated_at,
                 UNIQUE(source_kind, source_id, seq))
knowledge_fts = FTS5(seg), content='knowledge_chunks', content_rowid='chunk_rowid'
  + 三个同步触发器(ai / ad / au)
```

- `source_kind ∈ {'artifact','message'}`(闭集;`work` / `project` 是 P2)。
- `seq` 是同一来源内的块序号;`UNIQUE(source_kind, source_id, seq)` 是 upsert 的锚点。
- `offset` / `length` 是**在来源正文里的字符区间** —— 引用与 `knowledge_read` 的切片都靠它。
- `sha256` 是**该块文本**的哈希:相同则跳过(避免 FTS 抖动),不同则替换。
- `project_id` 可空(将来跨项目的语料);外键 `ON DELETE CASCADE` 让"项目没了语料也没了"落在结构上。
- ⚠️ 不建 `scope` / `tainted` / `visibility` 列:**闭集里每个值都必须有真的写入口**
  (migration 025 那条纪律)。这些是 P2,见 §8。

## §4 分词与检索:复用现成的 bigram,不引第三方库

中文没有空格,而 FTS5 的默认分词器对 CJK **不切词**。2026-10-08 实测(`better-sqlite3` 自带 SQLite 3.53.4):

| 方案 | 查询「催收」 | 「收业」 | 「外呼」 | 负样本「量化交易」 |
|---|---|---|---|---|
| FTS5 裸表(unicode61) | 0 | 0 | 0 | 0 |
| FTS5 `tokenize='trigram'` | 0(trigram 要 ≥3 字) | 0 | 0 | 0 |
| **bigram 列 + unicode61** | **1** | **1** | **1** | **0** |

⇒ **索引列 `seg` = 文本切成 bigram 后空格连接**(与 `memory/sqliteMemory.ts` 的 `tokenize()` 同一套切法),
查询侧用同一套切法把 query 切成 `a OR b OR c` 再 `MATCH`。这样:
**索引真的存在**(不像 `content LIKE '%x%'` 走不了任何索引),1–2 字的中文查询也能命中。

排序用 FTS5 的 `bm25()`;不做向量(P1)—— 旧系统 `fragments_vec` 就是"零读方却持续付费"被删的。

## §5 触发:三个点,全部由平台发起,零模型调用

| 点 | 位置 | 做什么 |
|---|---|---|
| T2 工具后 | `tools/registry.ts` 的 `dispatch()`(唯一漏斗) | (P2)需要立刻可见时增量建块;P1 先不挂 |
| **T3 回合边界** | `host/serve.ts` 的 `housekeepingCommit`(成功/失败/超时/被中断**四条路都到**) | `reindexProjectKnowledge(projectId)`:重扫该项目的工件与消息,upsert 变化、删除消失的 |
| **T5 启动/定时** | `host/serve.ts` 启动(与 `syncOrgForExistingProjects` 同一处) | `reindexAllKnowledge()`:补跑存量 + 检出 drift |

**幂等**:`(source_kind, source_id, seq)` upsert + `sha256` 比对;**水位线落库**(不存内存 ——
批次 20 那六个补丁的根因就是"刚才发生了什么"放在了内存里)。
housekeeping 里那一次是**同步**的(与它现有的提交/回填同一纪律),且**失败不许把回合收尾打挂**:
`try/catch` + 复用 `reportWorkspaceProblem` 的"同一条只播一次"。

## §6 读口

能力 `knowledge.read` → 两个工具(**工具级粒度**,与 `board_list` / `board_read` 同款纪律):

- `knowledge_search({ query, limit?, kind? })` → 命中块的**摘要 + 来源坐标**(`chunkId` / 工件 id + commit sha / 消息 id + 项目),
  `limit` 默认 5、上限 20。
- `knowledge_read({ chunkId })` → 按 `offset`/`length` **现读**来源正文并切片,返回这一段 + 坐标 + 读取状态。

⚠️ **不复用 `memory.read`**:两套语义(用户偏好 vs 项目语料)混在一个门里,模型就分不清自己拿到的是什么。

**预算**(RAG 特有的风险面,真机有过单回合 109k token 撞墙钟的事故):
摘要 ≤ 200 字符/条、单次检索返回 ≤ 20 条、`knowledge_read` 单块 ≤ 1200 字符。
"要全文"是**再调一次**的动作,不是默认行为。

### §6.2 HTTP 读面(记忆页第三段「知识语料」)

工具口是给 **agent** 的(要守提示词预算:200 字摘录);人看的读面是另一条 ——
**2026-10-08 补上**:用户要求把它放进**记忆 tab**,并要求看到「构建状态 / 量级 / 时效性 /
机制有没有在跑」,需要时能查明细。

- `GET /api/knowledge` → 量级 + 时效 + **机制判据** + 按项目分行:
  `chunks` / `ftsRows`(**必须相等**,不等 = 索引坏了)、`sourcesIndexed`、
  `pending`(还差几条 + 最多 5 条明细)、`lastIndexedAt` / `newestSourceAt` / `lagMs`。
- `GET /api/knowledge/chunks?q=&projectId=&limit=` → `q` 有值走 FTS 检索、**没值按时间浏览**;
  每条带出处(工件标题 + `bodyPath@commitSha` / 消息 id)、字符区间、三态、摘录与**块正文**
  (块本身 ≤ `CHUNK_MAX`,所以给人看是 bounded 的)。
- 状态判据是**前端纯函数** `web/src/lib/knowledgeState.ts` 的 `corpusStatus`,顺序 = 严重程度:
  **读不到 > 索引与行不一致 > 空 > 落后 > 正常**;`runtime: "unavailable"` **不是**「0 条语料」。
- 不开服务时的可见口:`.probe/knowledge-peek.mts`(CLI,会写库 —— 先拷数据目录)。

**三态**:`knowledge_read` 的读取状态不是 ok 就都不是"空正文" ——
`unavailable`(来源文件/行读不到)、`drifted`(现读文本的 sha256 与索引记的不一致:人工改过),
后者照常返回切片但**如实标出**"索引与正文不一致,下一次 reindex 会收回一致"。

## §7 可见性(已知缺口,如实记)

`ceiling` 管的是"能不能做这个动作",**管不了"该不该看见"**。P1 的语料是**跨项目全局可读**的
(与"所有角色共享一个语料"这个目标一致),但因此:

- 项目 A 的甲方原文会被项目 B 的执行角色检索到;
- `review_finding` / 失败现场这类内部内容目前和交付物正文在同一个池子里;
- worker 从外部网页抓来的内容没有 `tainted` 标记 —— **这是跨角色 prompt injection 的唯一传播通道**。

⇒ P2 的第一件事是加 scope(project/global)+ `tainted` + 内部/对外边界,**每条有真的写入口之后才建列**。

## §7.1 分级(tier):能做的那一半,已经做了(2026-10-08,030)

用户的问法是:「worker 执行中『外部网页进语料』这种材料,是否可以作为低权重语料,
在 search 里降低被召回的权重」。**答法是分两半的,而分清哪一半能做是要紧的**:

- ❌ **平台没有能力判定「这段文字是不是从外网抓来的」。** 语料来源只有两类
  (工件正文 / `session_messages` 里 `kind IN ('user','assistant')` 的消息),
  **工具结果根本不进语料**;而「worker 把抓来的网页粘进交付物」这件事在库里
  与「worker 自己写的段落」长得一模一样。任何声称「已识别外部内容」的字段,
  都是一句平台造不出来的假话(本项目的 7-E)。
- ✅ **平台能机械判定的那一半是「这份来源是定稿还是原始材料」**,而外网抓来的
  东西**必然**落在原始材料那一类里(worker 的 `evidence` 工件 / 它自己的工作叙述)。
  所以把原始材料整体降权,就把它一起降了权 —— 而**判据只读结构化列**:

  | 来源 | tier | 判据(结构化列) |
  |---|---|---|
  | 工件 | `primary` | `kind ∈ {deliverable, decision, client_question, meeting_note, change_record, project_brief, work_brief}` |
  | 工件 | `material` | `kind ∈ {evidence, hypothesis, note, review_finding}`,以及**任何未知 kind**(fail-closed) |
  | 消息 | `primary` | `kind = 'user'`(甲方原话) |
  | 消息 | `material` | `kind = 'assistant'`(角色自己的工作叙述) |

- **落点**:`knowledge_chunks.tier`(030,纯加法、可空、**不建 CHECK** —— 与 022 的
  `todo_kind` 同一条先例:取值域在读写两侧的 TS 里)。检索排序改成**两级**:
  tier 优先(定稿在前),同 tier 内保持原来的 bm25 顺序。`limit` 语义不变。
- **自愈而不是回填**:存量行的 `tier` 是 `NULL`(030 之前索引的)。幂等判据从
  「只有 `sha256`」改成「`sha256` **和** `tier`」—— 否则正文没变的那些行**永远**
  停在 `NULL`。重扫(回合边界 / 宿主启动)会把它们补上,块 id 不变。
- **读面**:`knowledge_search` / `knowledge_read` 每条带 `[primary]` / `[material]` /
  `[分级未算]`;`GET /api/knowledge/chunks` 的每条带 `tier`,**`null` 如实给 `null`**
  (读不到不是取值 —— 不许渲染成 `material`)。
- ⚠️ **降权只是排序,不是过滤**:`material` 仍然**检索得到**。把它从召回里删掉,
  就等于平台替模型决定「原始材料不值得看」—— 而那条判断的现场在模型那里。

## §8 明确不做(P2 清单)

1. `scope` / `tainted` / 内部对外边界(§7)。**分级(tier)已于 030 落地,见 §7.1** ——
   但那是**排序权重**,不是可见性边界:跨项目全局可读这件事一个字没变。
2. 编译层:karpathy 那套"LLM 更新页 + 矛盾标注 + index.md/log.md"——它是**往同一个语料里再放一类文档**,不冲突。
3. ~~HTTP 读面~~ —— **已做**(§6.2,记忆页第三段)。仍未做:独立的语料浏览器
   (从命中跳到工件正文、按 kind / 时间筛选、分页)。
4. `work` / `project` 两类来源(现在只有 `artifact` / `message`)。
5. 向量检索、rerank、第三方搜索服务。
6. 接待会话(`projectId === null`)里的检索:能力**不进** `INTAKE_CAPABILITIES`(fail-closed,先不开)。

## §9 验收

- **正负样本**:中文 2 字查询命中(§4 那张表)、无关查询 0 命中。
- **幂等**:同一来源 reindex 两次 → 块数与 id 不变;改正文 → 旧块消失、新块就位;删来源 → 块消失。
- **切片**:块的 `offset`/`length` 拼回去等于来源正文的对应区间(不丢字、不串位)。
- **三态**:`knowledge_read` 在来源缺失时 `unavailable`、在正文被改后 `drifted`,都不是空正文。
- **预算**:`limit` 与摘要长度上限在**工具层**生效(不是只在 repo 层)。
- **读面回归**(`tests/platform/knowledge-http.test.ts`,11 条):行与 FTS 相等;写一条新来源
  **不重建**时 `pending` 与 `lagMs` 必须当场动(一个永远回 0 的计数器与"一切正常"长得一样);
  表不在 ⇒ `runtime: "unavailable"` + problem(**不是** 0 条);正文读不到 ⇒ 该块
  `state: "unavailable"` 且 `text` 空、`problem` 非空;`q` 切不出词 ⇒ 400。
- **能力加法的一致性义务**(改这一处必须同时改这五处,否则 `check:design` / `design-conformance` 红):
  `capability.ts`(联合 + `CAPABILITIES` + `CAPABILITY_TOOLS` + `PlatformToolName`)、
  `role.ts` 五个 ceiling、`promptAssembly.ts` 能力描述、
  `DESIGN-PLATFORM.md`(§3.1 联合 / §3.2 展开表 / 计数声称)、
  `DESIGN-AGENTS.md`(角色矩阵 / 五份出厂 JSON / 五个 Ceiling 段 / 计数声称)。
