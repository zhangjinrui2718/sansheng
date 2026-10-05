# 设计 1 · Sansheng 工程平台设计

**状态**:草案 · 2026-10-03
**取代**:`ARCHITECTURE.md`(v1.0,12 层模块图)—— **该文件已于 2026-10-04 批次 18 删除**。
它描述的实现已在批次 15 清场时整体移除;本文是唯一的现行结构文档。两者的差异见 §11(保留作历史对比)。
**配套**:设计 2《角色 Agent 与 Harness 配置》

---

## 0. 设计目标与非目标

### 0.1 要解决的三个真问题

1. **约束写在提示词层,执行点在代码层,两层之间没有连接。**
   7-B 与 7-L 是同一款病复发两次:executor 提示词里写着「卡住时你求助的对象是沟通员」,这句话在代码里从未被强制过。提示词是**台词**,不是**机制**。

2. **agent 无法使用平台自身的基础设施。**
   现状:全仓 17 个工具里,属于 sansheng 自有的只有 `board_list` / `board_read` / `memory_search` 三个,且**全是只读**。消息总线零工具、工件系统零写工具。基础设施是「框架对 agent 做」,不是「agent 能做」。

3. **一切以对话为界,项目活不过一轮对话。**
   `BlackboardScope = "global" | "conversation"`,`board_list` 按 `conversationId` 过滤。真实项目要跑多轮对话,而需求变更插在第 3 轮、执行阻塞卡在第 5 轮时,第 4 轮换对话就看不见前面的上下文了。

### 0.2 非目标

- 不做多租户、不做分布式。单用户本地服务,进程内单例仍然是正确选择。
- 不引入新的运行时依赖。SQLite + 现有 Pi SDK 足够。
- **不保留任何存量数据**(用户 2026-10-03 决策)。迁移不写双写、不写回填,直接重置 schema。

---

## 1. 核心反转:组织架构是一等数据

### 1.1 现在与目标

| | 现在 | 目标 |
|---|---|---|
| 组织架构住在哪 | 提示词台词 + 硬编码调用链 + `ROLE_CEILING` | **全局角色表 + 项目参与关系(数据)** |
| 「谁跟谁说话」由谁决定 | 提示词自觉 | **capability × scope 求解,机制级过滤** |
| 约束如何升级 | 改提示词,期望模型听话 | 改 `ROLE_CAPABILITY_CEILING`,代码评审可见 |

### 1.2 一句话表述

> **工具 = 能力 × 作用域。**
> 能力(capability)决定「能做什么类型的动作」,作用域(scope)决定「能对谁/对什么做」。
> 两者都满足,工具才存在。

当前的设计只有第一维(`Record<ToolRole, ToolName[]>`),所以它管得了 read/write/bash,管不了「甲方只能找业务经理」。

### 1.3 为什么这一维必须存在

「甲方只与业务经理交互」是本系统最硬的组织规则。它有三种实现方式:

| 方式 | 可靠性 | 现状 |
|---|---|---|
| 写在提示词里 | 模型可能不听 | 已失效两次(7-B / 7-L) |
| 写在代码的 if 分支里 | 可靠但不可配置,且与提示词语义脱节 | 7-L 硬编码 `handleWorkerAsk(knowIt=false)` |
| **写成 capability 授予** | 可靠 + 可配置 + 与提示词同源 | **本设计** |

Pi SDK 原生支持第三种:`createAgentSession({ tools, customTools })` 的 allowlist 通过 `isAllowedTool` 对 builtin / extension / customTools **统一过滤**,且只有名单内的工具被激活。这是机制级硬约束,不依赖提示词自觉 —— 现成的底座,不需要造。

---

## 2. DDD 领域划分

### 2.1 限界上下文

```
                         ┌─────────────────┐
                         │  Client(甲方)    │
                         └────────┬────────┘
                                  │  仅经 client.* capability
                                  │  (由全局 RoleSpec 授予,与项目无关)
    ══════════════════════════════▼══════════════════════════════
    BC0  Identity —— 全局角色:Agent(角色是「全局的人」,不随项目变化)
    ══════════════════════════════╤══════════════════════════════
    BC1  ProjectManagement —— 项目与工作:立项、拆解、排期、进度
    ══════════════════════════════╤══════════════════════════════
    BC2  Collaboration —— 协作与对焦:提问、应答、会议、升级
    ══════════════════════════════╤══════════════════════════════
    BC3  Blackboard —— 工件:所有可审计的记录都落在这里
    ══════════════════════════════╤══════════════════════════════
    BC4  ChangeControl —— 变更与阻塞:需求变更、阻塞登记与升级
    ══════════════════════════════╤══════════════════════════════
    BC5  Harness —— 能力装配:角色 → 能力 → 工具集
    ══════════════════════════════╤══════════════════════════════
    BC6  Execution —— 执行运行时:会话、工具循环、沙箱
    ══════════════════════════════╤══════════════════════════════
    BC7  Memory —— 长期记忆:先简单实现,经 MemoryPort 预留第三方接入
    ══════════════════════════════╧══════════════════════════════
                     通用域:Storage / Provider / Transport
```

**依赖规则**:上层可依赖下层,反向只走事件。BC5 依赖 BC0(取角色属性)与 BC1(取项目参与关系)来算 scope,其余 BC 之间不直接调用。

**BC0 是本次修订新增的。** 角色全局化的直接后果:整个系统里「有多少个 agent、各是什么角色」是一份**稳定的全局清单**,项目只引用它。这让 scope 求解不再依赖「项目成员表」这个运行时数据,而是「全局角色 + 项目参与关系」两个稳定输入。

### 2.2 聚合与实体

#### BC0 Identity(全局,先于一切 BC)

**角色是「全局的人」,不随项目变化。** 这是本设计的前置事实,不是可选项:

```
Agent (聚合根 · 全局)
├── id, role: ProjectRole
├── specialization?: "engineering" | "algorithm" | "data"
├── displayName
└── createdAt                        ← 创建后不再变化,不随项目增删
```

`Agent` 是**长期存在的实体**,如同公司里的员工。项目只是**引用**它们。

**推论**:`clientFacing` 不是「在某项目里的身份属性」,而是**角色自身的属性** —— 业务经理这个角色永远是客户接口,跟它在哪个项目里无关。因此它应当定义在 `RoleSpec`(代码内常量)上,而不是运行时数据上。这比原来的设计更硬:它**不可能被数据篡改**。

#### BC1 ProjectManagement

```
Project (聚合根)
├── id, name, client, goal, status, createdAt, closedAt
├── assignments: ProjectAssignment[]   ← 本项目引用了哪些全局 Agent
├── works: Work[]                      ← 拆解出的工作项树
└── changes: ChangeRequest[]

ProjectAssignment (实体)
├── projectId, agentId                 ← 指向全局 Agent,不复制其属性
├── addedAt, removedAt
└── (无 role / 无 clientFacing —— 那些是 Agent 与 RoleSpec 的属性)
```

**`ProjectAssignment` 是「谁参与了这个项目」的关联表,不是组织架构本身。** 它只回答「这个项目里有谁」,回答不了也不该回答「这个人是什么角色、能不能见客户」—— 那些在 BC0 与 `RoleSpec` 里,全局且不可变。

它仍然一次性解决了三件事:

- todo 的 assignee 从哪来(指向 `agentId`)
- 一次会议的参会者是谁(`assignments` 的子集)
- 「甲方只能找业务经理」如何被表达(**由 `RoleSpec.clientFacing` 决定,与项目无关**)

```
ProjectRole = "business_manager"      业务经理(唯一 clientFacing)
            | "project_manager"       项目经理
            | "worker"                执行工种(可多个,分工程/算法/数据)
            | "quality_reviewer"      质检审查员
```

#### BC2 Collaboration

```
Conversation(问答对)      单点阻塞式提问,与 7-L 的升级链同构
Meeting(多边对焦)         参会者集合 + 议题 + 纪要
Escalation(升级链)        「不是找甲方,是找上一层」
```

#### BC3 Blackboard

工件是**所有 BC 的可审计落点**,不是 BC1 的附属。

```
Artifact (统一记录)
├── id, projectId, conversationId?
├── kind: ArtifactKind
├── status: ArtifactStatus
├── author: RoleRef                  ← 角色而非裸字符串
├── body, metadata
└── links: { parent?, dependsOn[], answers? }
```

#### BC4 ChangeControl

```
ChangeRequest  proposed → under_review → accepted → implemented
                        └────────────→ rejected
Blocker        open → acknowledged → resolved | deferred | rejected
```

这两个是**跨会话存活**的一等实体,不是工件的一个 kind —— 它们有自己的状态机和生命周期。

### 2.3 值对象

| 值对象 | 含义 | 备注 |
|---|---|---|
| `Capability` | `"blackboard.write"` 这样的闭合联合 | 平台级的闭合集,新增需评审 |
| `Scope` | `{ kind: "project"\|"role"\|"client", ref }` | 作用域 |
| `ToolSetFile` | 用户可编辑的 `{ allow, deny }` | 沿用 7-E 格式 |
| `RoleSpec` | 一个 baseRole 的 ceiling + 默认集合 + 写面 kind 白名单 + 提示词单元 | 沿用 7-E 的 `ROLE_CEILING` 概念,升维 |
| `WriteKindPolicy` | `{ capability: "blackboard.write", allowedKinds: ArtifactKind[] }` | 见 §4.4 第三道门 |

### 2.4 领域模型总表:实体 / 投影 / 值对象 · 基数 · 谁维护(2026-10-04 补做)

> **为什么补在 §2 里,而不是新开 §13。** 两条理由。①**语义**:本文 §2 的标题就是「DDD 领域划分」,而对它的意见正是「DDD 没做好」—— 把答案写在别处,这一节的标题就变成了一句不成立的话。②**机械**:`docs/DESIGN-AGENTS.md` 与 `docs/ADR-001-harness-wiring.md` 按**编号**引用本文的 §3.3 / §4.3 / §6.2 / §7 / §8.3 / §10.3 / §12,插入一个新的大节会把它们**全部错位**;而 `check:design` 的 E14 只校验「引用指得着」,不校验「还指原来那一段」—— 编号漂移它抓不住。所以这里只增小节、不动编号。
>
> **与 §2.2 的关系**:§2.2 写的是**迁移前的目标模型**(2026-10-03),有几处与落地后的代码不符(`Artifact` 画了一个代码里不存在的 `links` 字段,`Project` 画了内嵌的 `works` / `changes` 数组)。**本节以代码为准**;§2.2 作为意图记录保留不改。

#### 2.4.1 先定判据

| 类别 | 判据 | 反面 |
|---|---|---|
| **实体** | 有自己的 `id` 主键;**被别的记录按 id 引用**;状态可变 | 只出现在查询结果里 → 投影 |
| **投影(读模型)** | **没有自己的表**;同一时刻可由一条纯查询从实体重算;重启不需要补写任何东西 | 有自己的表 + 自己的状态 → 实体或机制 |
| **值对象** | 无身份,靠内容相等;改了就是换一个;入库时降级成 CHECK 里的字符串 | 有自己的行 → 实体 |
| **技术机制** | 有表,但记录的是**平台怎么工作**(调度 / 限流 / outbox),不是业务发生了什么 | 业务语义依赖它 → 实体 |

**一句话**:本系统的领域层只有**实体 + 值对象 + 值型的边**;**唯一的投影是「待办」**;`dispatch_events` / `dispatch_attempts` 是**技术机制**,不是领域概念。

#### 2.4.2 总表

| 概念 | 类别 | 载体 | 基数 | 谁维护(写口) |
|---|---|---|---|---|
| `Agent` | 实体(BC0,全局) | `agents` | 1 Agent — N ProjectAssignment | 平台 `ensureOrg`(代码内固定的四个角色);**没有 agent 工具能建人** |
| `Project` | 实体 · 聚合根 | `projects` | 1 Project — N(Work / Artifact / Ask / Meeting / Blocker / ChangeRequest / Session) | **两条路并存**:agent `project_open`(`tools/project.ts`)· 平台 `POST /api/projects`(`transport/http.ts:125`) |
| `ProjectAssignment` | 实体(关联) | `project_assignments` | **M:N**(Project × Agent),`PRIMARY KEY(project_id, agent_id)` | `project_open` 的 `ensureProjectOrg` + `POST /api/projects`;**`removeMember` 零生产调用方**(`repo/projects.ts:134`) |
| `Work` | 实体 · 聚合根 | `works` | 1 Work — N 子 Work(`parent_work_id`);**N:1** 负责人(`assignee_agent_id`);**M:N** 依赖 | agent:`work_create`(`tools/project.ts:242`)/ `work_update`(`:319`)/ `work_assign`(`:342`)/ `report`(`:451`);状态的唯一写口是 `repo/works.ts:547` 的 `updateWorkStatus`(迁移规则见 §2.7) |
| `WorkDep` | 实体(边) | `work_deps` | **M:N**,DAG(自环 + 多跳环都由 `addDep` 拦) | **只有 `work_create` 能写**(`:296`);`removeDep`(`repo/works.ts:322`)**零生产调用方** |
| `Artifact` | 实体 | `artifacts` | 1 Artifact — **1** Project(必填);1 Artifact — N ArtifactLink | **三条路**:模型 `board_write`(`tools/blackboard.ts:122`)· 协议工具原子创建(`collab.ts` / `client.ts`)· 平台 `POST /api/client-questions/:id/answer`(`http.ts:249`) |
| `ArtifactLink` | 实体(边) | `artifact_links` | **M:N**(Artifact × Artifact),`rel ∈ parent \| depends_on \| answers` | `board_write` 的 `links` 参数;协议工具 |
| **`Artifact → Work`**(**产出 ∪ 关于**,migration 014) | 值型的边 | `artifacts.work_id` | **N:1**(N 工件 — 1 工作项),**可空** | `board_write` 的 `workId` 参数(模型显式指名,平台校验「存在且同项目」);`ON DELETE SET NULL`。⚠️ 一条边承载**两个**语义 —— 「交付物」与「关于哪条工作项」,读产出要自己区分(§2.6 末) |
| `Ask` | 实体 | `asks` | **N:1** from / **N:1** to;自引用 `parent_ask_id` = 升级链(**一条链上同时只有一条活问**) | `ask_role` / `answer` / `escalate` |
| `Meeting` + 参会记录 | 实体 + 关联 | `meetings` / `meeting_participants` | 1 Meeting — **M:N** Agent(`PRIMARY KEY(meeting_id, agent_id)`) | `convene` / `meeting_respond` / `meeting_conclude` |
| `Blocker` + 命中记录 | 实体 + 边 | `blockers` / `blocker_blocks` | 1 Blocker — **M:N** Work | `blocker_open` / `blocker_update` |
| `ChangeRequest` + 影响记录 | 实体 + 边 | `change_requests` / `change_affects` | 1 Change — **M:N** Work | `change_propose` / `change_review` |
| `ProjectSession` / `SessionMessage` | 实体 | `project_sessions` / `session_messages` | 1 Project — **1:N** Session(结构允许 N);1 Session — N Message | 平台(建会话、落消息)。`project_id IS NULL` 的那一条 = **接待会话**,全局唯一(§9.3) |
| 记忆 | 实体(跨项目) | `memory_fragments` / `memory_profile` | **不挂项目** | `memory_remember`;只有业务经理持 `memory.write`(设计 2 §10.4) |
| **待办 Todo** | **投影(读模型)** | **无表** | 每次 tick 现算 | **平台代码**:`collectTodos`(`runtime/dispatcher.ts:186`) |
| `WorkStatus` / `ReviewState` / `ArtifactStatus` / `AskStatus` / … | 值对象 | TS 闭合联合 + SQL CHECK | — | 代码评审(改它 = 一次显式评审) |
| `Capability` / `Scope` / `ToolSetFile` / `RoleSpec` / `WriteKindPolicy` | 值对象 | 代码内常量 | — | 代码评审(§7.1) |
| `dispatch_events` | **技术机制 · outbox** | `dispatch_events` | 1 Project — N Event | 平台:`updateWorkStatus`(`repo/works.ts:547`)调 `announcementsFor`(`:447`);消费在 `consumePendingDispatchEvents`(`repo/dispatch.ts:116`) |
| `dispatch_attempts` | **技术机制 · 限流账本** | `dispatch_attempts` | 1 `(project_id, todo_key)` — 1 行 | 平台:`bumpAttempt` / `pruneAttempts`(`repo/dispatch.ts`) |

**从这张表能读出的三件事**:

1. **基数只有两种形状**:「1 实体 — N 实体」的容器关系(`project_id` / `parent_work_id`),和「M:N 关联表」(4 张:`project_assignments` / `blocker_blocks` / `change_affects` / `meeting_participants`)。**没有 1:1 的业务关系**;唯一的「一对一」是 `dispatch_attempts` 的主键,而它是技术机制。
2. **「谁维护」不是一个角色,是四条互斥的路径**(见 2.4.3)。把它说成「agent 维护」会漏掉平台那条路 —— 而平台那条路正是真机事故的来源(§2.9)。
3. **唯一的投影是待办**(§2.5);唯一的「技术机制」是 outbox 与限流账本(§2.5 末)。

#### 2.4.3 四条写口(「谁维护」的精确答案)

| 写口 | 是什么 | 受不受三道门约束 | 例子 |
|---|---|---|---|
| **① 模型经工具** | 模型显式调一个平台工具 | **受**(ceiling × scope × writeKind) | `work_create` · `board_write` |
| **② 协议工具原子写** | 工具的语义本身就是一次通信,记录与动作**同事务落库** | 受(工具自身已授权) | `ask_client` 落 `client_question`(§6.2) |
| **③ 平台代码** | 状态机维护、接待会话落库、HTTP 面 | **不受** —— 它没有「调用者角色」 | `updateWorkStatus` 维护 `review_state` · `POST /api/projects` |
| **④ 平台不提供** | 构造函数存在但零生产调用方 → **事实上没有写路径** | — | `removeMember`(`repo/projects.ts:134`)· `removeDep`(`repo/works.ts:322`)· `deleteWork`(`repo/works.ts:267`) |

> **判据(写给以后加表的人)**:**每张业务表都要能指出唯一写口。** 现在 `works.status` 有(`updateWorkStatus`),`work_deps` **没有** —— 它有两个写口:repo 的 `addDep`(`repo/works.ts:308`)和 `work_create` 里为回滚写的裸 SQL(`tools/project.ts:299`)。写口分裂的地方,「这条不变量由谁保证」就没有答案。

### 2.5 「待办」是投影 —— 它是正式模型的一部分,不是驱动循环的私事

**定义**:**待办 = 一个 `(agent, 此刻可执行的动作)` 对。它在库里没有行,由 `collectTodos` 一次纯查询算出。**

这个定义不是文字游戏,它有三个可验证的后果:

| 后果 | 判据(可验) |
|---|---|
| 重启不需要「补写待办」 | `collectTodos` 的入参只有 `(db, projectId, now, 预算上限)`,不读任何进程内状态(`runtime/dispatcher.ts:186`) |
| 同一时刻可以从库重算 | 全部 8 个判据都是 SQL / repo 查询(下表) |
| 「刚才发生了什么」不能参与判定 | `NUDGE_CAPABILITIES`(`dispatcher.ts:152`)只敲门铃,不携带状态 |

| TodoKind | 判据从哪来(载体) | 载体是实体还是机制 |
|---|---|---|
| `answer_ask` | `asks` WHERE to_agent=我 AND status=open | 实体 |
| `attend_meeting` | `meeting_participants` WHERE agent=我 AND stance IS NULL | 实体 |
| `review_change` | `change_requests` 非终态 × 我持 `change.review` | 实体 |
| `fix_work_assignment` | `works` 非终态 AND 负责人不存在/非 worker(`dispatcher.ts:210`) | 实体 |
| `decompose_project` | 该项目 `works` **零行** AND project active | **空集判据** |
| `execute_work` | `works` 分派给我 AND `depsSatisfied`(`works.ts:396`) | 实体 |
| `review_work` | `works.status='done' AND review_state='pending'`(`works.ts:223`) | 实体 |
| `report_downstream` | `dispatch_events` WHERE consumed_at IS NULL(`dispatcher.ts:280`) | **技术机制** |

**8 个 kind 里 7 个直接站在实体上,只有 `report_downstream` 站在机制表上** —— 这不是缺陷(它的信息「下游发生了什么还没交代」本来就是平台的事实),但它解释了为什么 §2.9 那件事(要不要唤醒业务经理)只能在这里改,而改不动「实体上的判据」。

#### 命名:领域层、机制层分开写

用户的意见(「`dispatch_events` / `dispatch_attempts` 不该与领域概念混名」)**成立,但要修正一处**:代码里的注释其实分得很清(`repo/dispatch.ts` 头注释写着「本模块只做读写,不做判定」)。缺的是**文档层的正式命名**。三个混在一起的名字:

```
DriverTodo          领域概念(「谁手上有可执行的活」)—— 但类型名里的 Driver 是技术词
dispatch_events     技术机制(outbox:下游发生了什么、还没交代)
dispatch_attempts   技术机制(限流账本:叫醒过几次)
```

| 层 | 建议名 | 现状名 | 处置 |
|---|---|---|---|
| 领域 | **待办 `Todo`** / `TodoKind` | `DriverTodo`(`dispatcher.ts:102`) | **只改类型名**(`DriverTodo` → `Todo`)。驱动者是运行时的词,它不是领域里的东西 |
| 机制 | **outbox(待交代事件)** | `dispatch_events` / `DispatchEventKind` | **表名不改**(理由见下);改的是措辞:文档与类型里一律叫「outbox / 待交代事件」 |
| 机制 | **限流账本** | `dispatch_attempts` / `AttemptRow` | 同上 |

> **为什么建议不改表名。** 改名在 SQLite 上等于**重建表**(012 那条路,它的注释里记着这条路会静默删数据),还要同步索引、`INTENTIONAL_REBUILDS` 登记(`tests/platform/migrations.test.ts:42`)与真机库。**收益是措辞,成本是一次数据迁移** —— 不对等。所以结论是**分层命名,不动表名**:领域层用 `Todo`,机制层在文档与类型上叫 outbox / 账本。

### 2.6 缺口 ①:工件与工作项之间没有边(**已落地** —— 本节保留为「为什么这么画」的记录)

> **⚠️ 本节的状态(2026-10-04 · Wave 2 更新)**
>
> 下面这段「现状」描述的是**014 之前**的形态,它**已经为假**:
> `migrations/014_artifact_work.sql` **已落地**,`artifacts.work_id` 存在,
> `board_write` 的 `workId` 参数与 `listArtifacts(projectId, { workId })` 都已接线,
> `runtime/execution.ts` 的产出采集也已从「项目级集合差」换成走这条边。
>
> 下面**保留**两样东西:① 方案 B(`artifact_links.rel = 'produces'`)为什么结构上
> 不成立的三条实测证据 —— 那些结论与这个项目无关、与 SQLite 有关,换不掉;
> ② 这条边的设计选择与理由。**读的时候把「现状」当历史**,以代码为准。
>
> **⚠️ 另有一处当时的判断被真机推翻了** —— 见本节末「这条边的语义其实是两个」。

**当时的现状**:`artifacts` 没有 `work_id`(`migrations/008_blackboard_change.sql` 的 `artifacts` 表;`src/platform/storage/repo/artifacts.ts` 里 grep 不到 `work_id`)。

「这条工作项产出了什么」那时是**项目级集合差**算出来的:

```
回合前   artifactsBefore = set(listArtifacts(db, projectId))        ← 整个项目
回合后   差集                                                        ← 就是「产出」
```
落点 `runtime/execution.ts`(Wave 2 已改成走 014 的产出边)。

**这比「靠作者 + 时间接近猜」更弱 —— 它连作者都不看。** 后果:同一项目里两个回合交叠时,**两边都会把对方的工件算成自己的产出**。今天的宿主有 per-project 忙闩(`host/serve.ts` 的 `hub.isBusy`),所以只有「常驻宿主 + `platform-run` CLI 同时跑同一项目」才会撞上;**判据本身是错的,只是暂时没有触发面。**(修它 = 让读写两侧都走这条边,见 §2.6 末。)

质检那一侧当时同样断: `review_work` 待办的 `refs` 是 work id(`dispatcher.ts:292`),而 `listArtifacts` 的过滤器只有 kind / status / author / parentOf(`repo/artifacts.ts:119`)—— **从 work id 查不到它的产出。**

#### 方案对比(带实测)

| 方案 | 结论 | 依据 |
|---|---|---|
| **A. `artifacts` 加 `work_id`(可空)** | ✅ **采用** | 可空列 + 部分索引,纯加法,不动任何现有约束 |
| **B. `artifact_links.rel` 加一个 `produces` 取值** | ❌ **结构上不成立** | 见下 |

**方案 B 不成立的三条实测证据**(本次对着真实迁移链跑的探针,SQLite 3.53.4):

1. `artifact_links` 的**两端都是工件**:`artifact_id REFERENCES artifacts(id)`、`target_artifact_id REFERENCES artifacts(id)`(`migrations/008`)。要表达的边是「工件 ← **工作项**」,一端根本不在 `artifacts` 里 → 写入被 `FOREIGN KEY constraint failed` 拒绝。
2. `rel` 的 CHECK 闭集不放 `produces` → 写入被 `CHECK constraint failed: rel IN ('parent', 'depends_on', 'answers')` 拒绝。
3. 想放宽这个闭集**只能重建表**:`ALTER TABLE artifact_links DROP COLUMN rel` 被拒(`cannot drop PRIMARY KEY column: "rel"`);`ALTER TABLE ... ADD CONSTRAINT ... CHECK (rel IN (..., 'produces'))` **会被接受、也真的生效,但只能收紧不能放宽**(CHECK 之间是 AND 关系)—— 加完之后 `rel='produces'` **依然写不进去**。

> ⚠️ **第 3 条是一个新踩到的静默陷阱,写进这里给以后的人。** 「加一条 CHECK 来放宽闭集」这条迁移会**无错应用**,而约束一点没放宽;失败出现在很远的下游(某次插入的 CHECK 错误)。这与 AGENTS.md 的「三类静默失败」同一族,只是第 4 例:**看起来成功的 ALTER 什么也没放宽。**

结论:**边加在 `artifacts` 上(方案 A)。**

#### 这条边的基数与语义

- **N:1**(N 个工件由 1 条工作项产出),**可空**。`NULL` = 不是任何工作项的执行产出:立项书、会议纪要、变更记录、甲方问答。
- 它**只表达「产出(provenance)」** ← ⚠️ **这条判断被真机推翻了,见下。**
- **谁维护**:`board_write` 有**可选** `workId` 参数(模型显式指名),平台在写入时校验「存在且同项目」。不用会话级的「当前工作项」默认值 —— 一条会话会连续跑多个工作项(`execution.ts` 的注释),`ToolRunContext` 是建会话时构造一次的(`runtime/assembly.ts:137`),放了默认值它会**过期**。

#### ⚠️ 这条边的语义其实是**两个**(真机第一跑就推翻了上一版)

上面那句「它**只**表达产出」**是假的**。真机第一次跑到质检就发生:

> 质检审完一条工作项,会把 `review_finding` 挂到**被审的那一条**上。

所以 `workId` 的实际语义是「**产出 ∪ 关于**」:

| 谁 | kind | 那条边其实在说 |
|---|---|---|
| worker 自己 | `evidence` / `hypothesis` / `work_brief` / `note` | **产出**:这条工作项交付了它 |
| 质检审查员 | `review_finding` | **关于**:这条工件在说这条工作项 |
| 项目经理 | `work_brief` / `note` | **关于**(通常是补充说明) |

**处置(两件事必须同时做,否则会静默丢东西)**:

1. **不能删那些边。** `work_id` 是 `review_finding` **唯一**能表达「我审的是哪一条」的地方
   —— §2.6 已经实测过 `artifact_links.rel` 放不下 `produces`(两端都必须是工件),
   而「关于」这条 M:N 关系还没有自己的表(§12 #7)。删边 = 质检意见变孤儿。
2. **读「产出」时必须自己区分。** `runtime/execution.ts` 采产出时用三条**机械**判据
   取交集:`work_id = 这条工作项` **且** `author_agent_id = 本回合的执行者`
   **且** `kind ∉ ABOUT_ONLY_ARTIFACT_KINDS`(`["review_finding"]`)。
   作者那一条是真的在挡东西(质检也是这条边的合法作者),不是冗余。

**这是一个权宜,缺口仍然开着**:一条边承载两种关系。真正的解法是给 `artifacts`
再加一个 `rel ∈ {produces, about}`,那又是一笔迁移。在那之前,
「这条工作项交付了什么」这个问题的答案**必须**经过上面那三条判据 ——
直接拿 `workId` 当答案会把质检意见算成交付物。

#### migration `014_artifact_work.sql`(**已落地**)

```sql
-- 014 · 工件 → 工作项的产出边(已落地,`migrations/014_artifact_work.sql`)
--
-- 纯加法:一个可空列 + 一条部分索引。没有 DROP、没有重建、没有 NOT NULL。
-- ⚠️ 不建表 —— 因此没有 `CREATE TABLE IF NOT EXISTS` 撞名的面(AGENTS.md 静默失败 #1)。
ALTER TABLE artifacts ADD COLUMN work_id TEXT REFERENCES works(id) ON DELETE SET NULL;

-- 「这条工作项产出了什么」和质检那条判定都走这条部分索引
CREATE INDEX IF NOT EXISTS idx_artifacts_work
  ON artifacts(work_id) WHERE work_id IS NOT NULL;
```

**落地前的实测结论**(对着 001→013 的真实迁移链跑,已含正负样本):

| 检查 | 结果 |
|---|---|
| 014 之前 `artifacts` 有 `work_id` 吗(负样本) | `false` ✅ |
| 014 之后有吗(正样本) | `true` ✅ |
| 既有行是否被破坏 | `[{"id":"a0","work_id":null}]` ✅ |
| 带 `work_id` 的插入 | 成功 ✅ |
| **悬空 `work_id`(负样本)** | `FOREIGN KEY constraint failed` ✅ 外键是真在拦 |
| 删掉对应 work 之后 | 工件**仍在**、`work_id` 变 `null` ✅ |
| 部分索引 | `true` ✅ |
| `foreign_key_check` | `[]` ✅ |

**四条设计选择,各有理由**:

1. **`ON DELETE SET NULL` 而不是 `CASCADE`** —— 删掉一条工作项**不该删掉它的产出**:工件是审计面(设计 2 §10.2 的判据:工件不衰减、必须比产生它的东西活得久)。用 CASCADE 就是 012 那条静默删数据的路,只不过删的是工件。
2. **不能加 `UNIQUE`** —— SQLite 拒绝 `Cannot add a UNIQUE column`(实测),而「N 个产出」本来就该允许。
3. **可空、不给 `DEFAULT`** —— `ADD COLUMN` 带 `REFERENCES` 时默认值必须是常量;可空天然满足,而且「这条工件没有产出工作项」是真事实,不该被一个占位值掩盖。
4. **部分索引 `WHERE work_id IS NOT NULL`** —— 现有多数工件(`client_question` / `meeting_note` / `change_record`)的 `work_id` 都是 `NULL`,不该进索引。

### 2.7 状态机的合法性:迁移规则**已落地**在唯一写口

> **2026-10-04 修正(补做 §2.10–§2.12 时顺手核对)**:本节原来的「现状」与「建议」**都已为假** —— 建议的那张表**已经实现并有测试钉着**。逐条核对在下面;原「现状」表里的每一行都错了(写口位置、是否校验、`cancelled` 能不能复活)。**这一处修正不是重写,而是把一个已经把建议做完的系统如实记下来。**

**现状**:`works.status` 是 CHECK 闭集(`migrations/007`: `open | in_progress | blocked | done | failed | cancelled`),而**迁移规则**是数据:`WORK_TRANSITIONS`(`repo/works.ts:83`),判定在 `isWorkTransitionAllowed`(`:139`,`from === to` 算幂等空操作,一律放行)。**唯一写口是 `updateWorkStatus`(`repo/works.ts:547`)**,非法迁移**不抛异常**,返回结构化原因 + 回灌出边集合(`:168-182`;`nextWorkStatuses` 在 `:188`,注释写明「8-F:拒绝必须让模型能自纠」)。

| 迁移 | 今天允许吗 | 触发它的路径 | 平台顺手维护什么 |
|---|---|---|---|
| `open → in_progress` | ✅ | `runWorkItem` 自动写(`execution.ts:139`) | — |
| `open / in_progress / blocked` 之间互迁 | ✅ | 模型调 `work_update` | 迁入 `blocked` → 写一条 outbox 事件 |
| `open / in_progress / blocked → done` | ✅ | 模型调 `work_update` / `report` | `review_state = 'pending'`;outbox `work_done`;迁出 `done` 时 `review_state` 清成 `none` |
| `open / in_progress / blocked → failed` | ✅ | 同上 | outbox `work_failed` |
| `open / in_progress / blocked → cancelled` | ✅ | 同上 | outbox `work_cancelled`(migration 015,§12 #10) |
| **`done → in_progress`**(退回) | ✅ **明确允许** | 同上 | `review_state` 清成 `none` —— 但**已消费的 outbox 事件不撤**(残留的那一半见 §12 #9) |
| **`failed → in_progress`**(重试) | ✅ **明确允许** | 同上 | 它是 `failed` 唯一的复活路径(`failed` 不在任何待办里,`checkRunnable` 也拒绝它),少了这条边一次失败就把下游永久堵死 |
| **`cancelled → 任意`**(复活) | ❌ **禁止** | — | `cancelled: []`(零出边)。「取消」是汇点:范围重新需要时要做的是**新的一件事**,不是复活旧的(§2.8) |

**两条裁决写在代码里**(`repo/works.ts:98-137`),各自带理由与代价:`done → in_progress` 允许(三条理由,核心一条:**收紧它会把模型推回「取消旧的 + 新建一份」那个真机事故路径**),`cancelled` 是真终态。

**没有做的那一半(仍然成立)**:退回重做时**已消费的 outbox 事件不会撤回**,于是「已向甲方交代过完成」与「其实还没做完」可以同时成立 —— `consumed_at` 在这一次退回上开始撒谎。两条出路都需要一笔 `dispatch_events` 重建(015 那条路),**不擅自加 `work_reopened`**(放进 CHECK 却没有写出方的取值 = 一句「本系统会发这种事件」的假话)。见 §12 #9。

**给新增规则的判据(与 §2.11 衔接)**:新规则要读工作项状态时,**用 `WORK_TRANSITIONS` / `nextWorkStatuses` 表达可达性,不要自己判「是不是终态」** —— 终态的定义今天有三处(`isTerminalWorkStatus` `works.ts:44` · `checkRunnable` `execution.ts:82` · `cancelled: []`),第四处就是漂移的开始。

### 2.8 `cancelled` 的关系语义:取消不是失败

**定义**:

> **`cancelled` = 这块范围不要了。** 它不是「这条活没做成」,而是「不需要有人做了」。
> 因此它在**依赖关系上不构成阻塞**;但在**可见性上必须出现**。

| 前置的状态 | 阻塞下游吗 | 下游的语义 | 必须可见吗 |
|---|---|---|---|
| `done` | 否 | 前置满足 | 否 |
| **`cancelled`** | **否** | **按「范围已缩」开工,输入少了一块** | **是** |
| `failed` | **是** | 真的失败了 —— **这条才需要人介入** | 是(已可见) |
| `in_progress` / `open` / `blocked` | 是 | 等得起 | 是(已可见) |
| 指向的工作项不存在 | 是 | 数据损坏 | 是(已可见) |

代码落点:`DepState` 是**五态**而不是布尔(`repo/works.ts:353`),`depsSatisfied` 只在 `failed` / `pending` / `missing` 非空时为假(`works.ts:396`)。

**「必须可见」落在三处**(不是一处):

| 落点 | 渲染什么 | 位置 |
|---|---|---|
| `work_read` | 五种前置状态逐条列出,含「已取消(不阻塞,但你该知道)」 | `tools/project.ts:440` |
| worker 的待办注入 | 单独一段「⚠️ 可开工,但前置里有被取消的」+ 「这不是阻塞」 | `runtime/pendingWork.ts:267` |
| 待办字段 | `myWorksWithCancelledDeps` | `pendingWork.ts:73` |

> **一处脆弱的耦合(记下来,不必现在改)**:`renderPendingWork` 的 `hasAnything` 门(`pendingWork.ts:218`)**没有**列 `myWorksWithCancelledDeps`。今天不影响结果 —— 那个字段非空时 `myOpenWorks` 必然也非空(两者同一次循环里 push,`pendingWork.ts:117`),所以那一段照样渲染。但这段可见性是**搭在别人的非空上**的;哪天 `myOpenWorks` 的判据改动,这段会**静默消失**。

#### 「取消 + 新建」该不该重定向依赖边

**结论:平台不重定向。** 三条理由:

1. 「新建一份同名项」**不是一次改名**。库里没有「后继」这个字段(`works` 只有 `parent_work_id`,是树,不是版本链),平台只能靠标题相似度猜 —— 而猜测会**静默改写用户显式画的那张图**。
2. 真机数据里那两份工作项**不是等价的**。实测(用户自己的 `~/.sansheng/sansheng.db`):

   ```
   旧的「三段式 vs omni 综合对比与替代路径分析」 = cancelled,它有 2 条前置
   新的「三段式 vs omni 综合对比与替代路径分析」 = open,它有 4 条前置,与旧的只有 1 条重合
   新的「调研报告整合与撰写」 = open,它有一条前置指向**旧的、已取消的那一份**
   ```
   重定向必须先回答「哪几条边跟着走、哪几条不跟」—— **那是人的判断,不是平台的。**
3. 依赖图是**人画的**。平台代改边,等于把「谁依赖谁」从可审计的数据变成一次平台推断 —— 与 §4.4 三道门「只减不增、且必须留痕可见」同源。

**该谁负责**:

| 谁 | 负责什么 |
|---|---|
| **项目经理** | 它画的边它负责。取消一条**仍有后继依赖**的工作项时,它应当先改边再取消(见下面的缺口) |
| **平台** | 只负责让悬空的边**可见**,不负责猜。已在做的:`work_read` 五态渲染 + worker 待办标注 |

**真正的缺口比「要不要重定向」更靠前 —— 这条建议优先于 §2.6**:

> `work_update` **没有 `dependsOn` 参数**(`tools/project.ts:319` 的参数只有 `workId` / `status`),`removeDep` **零生产调用方**(`repo/works.ts:322`)。

也就是说:**一条已有工作项的依赖边改不了。** 「取消 + 新建」不是项目经理的偏好,而是它**唯一的重做路径** —— 真机数据正是这条路径的产物。

**建议**:给 `work_update` 加可选 `dependsOn`(**整体替换**语义,内部走 `addDep` / `removeDep` 同一套环检测,不做第二套);并把「取消一条有后继依赖的工作项」变成一条**非阻塞警告**(结构化返回 + 列出后继 id),**不是拒绝** —— 拒绝会把合法的「这块不要了」也一起挡住。

**另一条立即该补的(✅ 已补:migration 015 + `repo/works.ts` 的 `cancelled` 判定)**:`cancelled` **曾**不写任何 outbox 事件(`EVENT_KIND` 只有 done / failed / blocked)。于是「一条工作项被取消」这件事业务经理与质检**都不知道** —— 而它恰恰是下游悬空的来源。补它要给 `dispatch_events.kind` 的 CHECK 闭集加一个取值,那需要**重建表**(理由同 §2.6 的实测第 3 条)。这张表没有子表引用、只有一条部分索引,重建成本低 —— 已在 `migrations/015_dispatch_event_kinds.sql` 走过一次(见 §12 #10)。

### 2.9 谁决定甲方可见性

**用户的判断**:业务经理干了太多事,立项之后**执行细节**不该再一条条同步给甲方。

**复核结论:问题成立,但归因要改一处。**

#### 归因:不是「没有判据」,是「判据不可证伪」

提示词里其实**有**判据(`harness/system_prompts/business_manager.core.md`):

| 行 | 原文 | 性质 |
|---|---|---|
| `:44` | 「值得让他知道的 → `tell_client` **主动**播报。**这是你的职责,不是可选项**」 | **硬职责** |
| `:46` | 「**不值得打扰他的,就不要播。**」 | 克制,无判据 |
| `:52` | 「**判据很简单**:如果甲方读到你这条消息会想「这个我确实需要知道」,就播;如果他会想「哦」,就别播」 | **判据在,但它要求模型预测甲方的反应** |

所以准确的诊断是:**一条硬职责 + 一条正确但不可证伪的克制**。`:52` 那条判据没有可操作的输入(模型看不到甲方此刻在做什么、上一次被告知了什么),它只能退化成「看起来挺重要」。用户说的「后者永远输」在效果上对,在原因上是**判据不可执行**,不是**没有判据**。

#### 触发侧:唤醒频率确实不该由「单条 work 迁移」决定

现状精确形态(不是「每完成一条就播报」,但效果接近):

- outbox 的**写入侧**只对「根工作项终态 / `failed`(与树的位置无关)/ 里程碑」写行,判定在一处(`announcementsFor`,`repo/works.ts:447`;种类表 `EVENT_KIND` 在 `:486`),中间工作项的状态迁移**静默放行** —— ⚠️ 但真机库是**扁平**结构(9 work / 9 root / 0 中间),于是**每一行都是根**,这一刀事实上没有筛掉任何东西(详见 §9.4「合并唤醒」);
- `collectTodos` 只要有**一条**未消费事件,就给业务经理生成 `report_downstream` 待办(`dispatcher.ts:280`);
- 它优先级最低(`PRIORITY` = 7,`dispatcher.ts:99`),所以一条 `work_done` 的事件**总会在某个 tick 把业务经理叫醒一次**。

结论:**唤醒频率由「单条状态迁移」决定**,而业务经理没有「这一条不值得叫醒我」的选项 —— 它只能被叫醒之后再决定播不播。**唤醒即成本**:一次唤醒 = 一次完整回合的 token,而且它在会话里留下一条回复(那就是用户看到的「一长串」的来源之一)。

#### `report_downstream` 去留:**保留,改触发条件**

**不取消**,理由具体:outbox 就是「工作项做完了却没有人向甲方汇报」那次真机事故的修复(批次 21;`runtime/dispatcher.ts:13` 与 `repo/dispatch.ts:10` 都记着它的现场;另见 §9.4)。取消它 = 把那类事故放回来。

**改的是判据**:`report_downstream` 从「有未消费事件」收紧为「有未消费的**可打扰**事件」。判据是**机械的**,只用现有列:

| 事件 | 可打扰判据 | 该不该打扰甲方 |
|---|---|---|
| 某条**根工作项**终态 | `works.parent_work_id IS NULL` | **是** |
| 一个**里程碑**:某个根工作项的全部后代都终态 | 沿 `parent_work_id` 聚合 | **是** |
| `work_failed` | 事件 `kind` | **是** —— 影响时间表,甲方要能重新决策 |
| `work_blocked` / `blocker_opened` 且 `severity ∈ {high, critical}` | join `blockers.severity` | **是** |
| `blocker_opened` 且 `severity ∈ {low, medium}` | 同上 | 否(团队内部可消化) |
| 中间工作项终态(非根、非里程碑) | — | **否** ← 这就是用户抱怨的那一长串 |

两条实施路线,选一条:

- **方案甲(推荐):收紧写入侧。** `updateWorkStatus` 只在「根工作项终态 / 里程碑 / severity ≥ high」时写 outbox。**理由**:它把「要不要打扰甲方」从一个**模型的自述**变成**库里的一个事实** —— 可测、可审计、可复现,与 §9.4「判定永远重新查库」同源。
  **代价(如实记)**:outbox 从「下游事件流水」缩成「待交代队列」,`renderDownstream`(`dispatcher.ts:403`)给业务经理的现场会变窄。
- **方案乙(不推荐):只在判定侧收窄。** 保留完整流水,只在 `collectTodos` 过滤。**为什么不行**:消费是**全量**的 —— `consumePendingDispatchEvents(db, projectId, ...)` 无差别标记该项目**全部**未消费事件(`repo/dispatch.ts:118`)。一次「可打扰」事件会把一串「不可打扰」事件一起标记为已交代,于是 `consumed_at` 这个字段开始撒谎。

#### 「谁判断」:平台定候选,业务经理定措辞

```
平台      机械判据 → 决定「哪些事进了候选队列」      ← 可测、可复现
业务经理  在候选内决定「播 / 不播 / 怎么说」        ← 它见过甲方,也只有它持 client.message
```

**为什么不是「项目经理判断、业务经理转述」**(用户的倾向),三条理由:

1. **项目经理看不到甲方**:它不持 `client.*`(`identity/role.ts` 的 ceiling),也不写用户记忆 —— `memory.write` 只有业务经理(DESIGN-AGENTS §10.4)。让它判断「甲方该不该知道」,等于让它对一份**它读不到的上下文**做判断。
2. **要走这条路必须新增一条边**(项目经理 → 业务经理的「请播报」)。而那条边的语义是「请你播」—— 于是业务经理从「判断 + 措辞」降级成「只有措辞」,**唯一见过甲方的角色失去了否决权**。这正是「一长串」的另一种成因,不是解法。
3. 用户要的是**少打扰**,不是**换一个人决定**。把判据机械化(上表)直接拿到「少打扰」,不需要动角色权限 —— 而动权限要走 §4 的能力/ceiling 评审,代价大得多。

#### 业务经理的可操作播报判据(替换「值得就播」)

> **三个二值问题,全部为「是」才播**:
> 1. 它会改变甲方**已经知道的东西**吗(时间 / 范围 / 验收判据 / 花的钱)?
> 2. 甲方**此刻能对它做点什么**吗(决定 / 确认 / 提供输入)?什么都做不了 → 那是日志,不是播报。
> 3. 它**下周还成立**吗?不成立 → 那是过程噪音。

**「不播」也必须是一次决定,不是一次遗漏**:业务经理的回复文本本来就会落成 `assistant` 会话消息 —— 让它在那条回复里**点名说自己评估了哪几条、为什么判断不必播**。零新增机制,而且事后查得出「当时是判断过还是漏了」(AGENTS.md 教训 4:见不到的现场等于没有现场)。

### 2.10 通道分离:对话页 = 甲方 ↔ 业务经理(2026-10-04 新增)

> **为什么是 §2.10 而不是新开一节。** 与 §2.4 同一条理由(见 §2.4 开头):①**语义** —— 这一节定的是「谁在说话」,那是领域身份,§6 的工件模型与 §5 的通信模型都建在它上面;②**机械** —— `DESIGN-AGENTS.md` 与 `ADR-001` 按编号引用本文的 §3.3 / §4.3 / §5.3 / §6.2 / §7 / §8.3 / §10.3 / §12,插大节会把它们全部错位,而 E14 只校验「指得着」。**只增小节,不动编号。**

**用户的判断**:对话页是我和业务经理**双向沟通的通道**;其他所有角色的对话,在「成员」页里每人一份「他产生了什么对话」的清单,供我检查。

**复核结论:方向成立,但「前端拿不到信息区分」只对了一半** —— 说话者身份**库里有、REST 里有**,只在**流式面**断掉;而前端把 REST 那份也丢了。

#### 2.10.1 说话者身份在四层的现状

| 层 | 载体 | 有 speaker 吗 | 证据 |
|---|---|---|---|
| **库** | `session_messages.agent_id` | ✅ **有**,`NULL` = 甲方 | `migrations/009_collaboration.sql:45-46`(注释原文:「NULL = 甲方(用户)说的话。用户不是 agents 表里的角色」) |
| **REST 视图** | `SessionMessageView.agentId` / `.agentName` | ✅ **有** | `shared/types/platform.ts:177-179`;`toMessageView` 在 `transport/views.ts:223-224` 填它 |
| **WS 流** | `message_start` / `tool_start` | ❌ **没有** | `shared/types/platform.ts:422` · `:436`;`emitMessageStart` 的 role 实参被写死成 `"assistant"`(`transport/hub.ts:183-185`),四个调用点 `host/serve.ts:335` · `:537` · `:659` 与 `hub.ts:265` 从不传 agent |
| **前端** | `messageToTurn` | ❌ **拿到又丢掉** | `web/src/stores/chat.ts:163-185` 只读 `m.kind` / `m.content`,把 `agentId` / `agentName` 全丢,并把一切非 `user`/`system` 归成 `"assistant"`;`grep -rn 'agentId\|agentName' web/src/` = **0 命中**(同模式自检:`grep -rln 'role' web/src/` = 7 个文件命中,负样本 `ZZQQNOPE` = 0) |

**两条真机库实测**(`~/.sansheng/sansheng.db`,只读查询,2026-10-04):

```
session_messages 按 (kind, agent_id) 分组:
  assistant/wk=5 · assistant/bm=4 · user/null=2 · assistant/pm=1 · assistant/qa=1
project_sessions = 1        ← 四个角色全在**同一条**会话里
artifact_links = 0 · asks = 0 · schema_version 最新 = 15
```

⇒ 「四个角色的回合落进同一条 thread」**成立**,而且比那句话更强:它是**一条**会话(`project_sessions = 1`),不是「N 条被前端合并」。⇒ **「对话页只有两个人」不需要任何 schema 变更**;要补的只有下面这两处。

#### 2.10.2 契约最小加法:**加两个事件,不加四个**

判据是「**谁在读这个字段**」—— **没有读者的字段不加**(与 AGENTS.md「有声明没读者」同源)。

| 候选 | 读者是谁 | 结论 |
|---|---|---|
| `message_start.agentId` | 前端**建轮**的唯一入口(`chat.ts:340-355`) | ✅ **加** |
| `tool_start.agentId` | `tool_start` **自己也能建轮** —— `get().currentTurn ?? newTurn(e.messageId, "assistant")`(`chat.ts:394`) | ✅ **加** |
| `delta` / `thinking_delta` / `message_end` / `tool_end` 上的 `agentId` | **没有** —— 它们全部追加到**当前那一轮**(`chat.ts:357-408`),而当前那一轮是被 `message_start` / `tool_start` 建出来的 ⇒ 身份在**建轮**那一刻就定了 | ❌ **不加** |
| `speakerRole: ProjectRole` | 没有独立读者:可由 `agentId → agents.role` 推出,而前端已经拿得到 `MemberView.role`(`routes/Members.tsx:78`) | ❌ **拒** |
| `channel: "client" \| "internal"` | 没有独立读者:它是 `clientFacing` 的派生值,而 `clientFacing` 已在 `GET /api/harness`(`Members.tsx:107` 就在读) | ❌ **拒** |

**拒 `speakerRole` / `channel` 的三条具体理由**(不是口味问题):

1. **它们是派生值,而派生值上到线上就是第二处真相。** `ROLE_SPECS[role].clientFacing` 是**代码内常量**(`identity/role.ts:127` 定义、`:146` 只有业务经理为 `true`),文件头注释明写它「**在结构上不存在被篡改的路径**」(`:7-9`)。把它抄进每条事件,就等于给它开一条被篡改的路径,而两者不一致时**没有人知道该信哪个**。
2. **它们都答不了「这条是谁说的」** —— 成员页要的正是这个,所以无论如何还得带 `agentId`;那把 role / channel 一起带上就是纯增量成本。
3. **它们把多 worker 合成一个。** `speakerRole` 会让两个 worker 说成一个人;而 `agentId` 保得住区分(`agents` 表今天 4 行,但基数是 M:N,见 §2.4.2)。

**形状与语义**(`shared/types/platform.ts`,冻结契约**只增字段**):

```
message_start   { projectId, messageId, role: "user" | "assistant", agentId: string | null }
tool_start      { projectId, messageId, agentId: string | null, tool: WsToolInfo }
```

- **`agentId: string | null`,`null` = 甲方** —— 与 `session_messages.agent_id` 的注释**逐字同义**(`migrations/009:45`),与 `SessionMessageView.agentId` 同义(`shared/types/platform.ts:177`)。**不新造词汇,不新造取值域。**
- **类型上必填,不是可选。** 可选 = 「填不填都行」,而漏填的表现是前端把它当**无名助手**(静默);必填之后 4 个构造点各自必须说清是谁,而 TS 会把它们全点出来。这与 `markWorkReviewed` 的取舍同源:宁可多要一次显式声明,不要一个可以省略的身份。
- **⚠️ 一处已有的第二真相**:`tell_client` 那条播报在 `hub.ts:259` 把作者**写死成 `agentId: "bm"`**,不经 `ctx.agent.id`(工具在 `tools/client.ts:136` 只把 `projectId` / `message` 交给通道)。今天 `"bm"` 恰好就是业务经理的 agent id(`runtime/org.ts:31`),所以值是对的;但组织表换 id 的那一刻,这条消息会**静默归错人**。⇒ 与本次改动同批处理:把 `ctx.agent.id` 透传进 `ClientChannel.tell` 的入参。

**「谁面向甲方」不需要新字段**:前端由 `agentId` → `MemberView.role` → `HarnessView.roles[].clientFacing` **两跳**算出,两个端点都已经在页面上被读过。接待会话没有项目(**没有成员表**),**但 `/api/harness` 是全局的** —— 所以那条路径不缺输入。

> ⚠️ **2026-10-06 更正:这条两跳判据已经**降级**成回退判据。** 主判据改成了下面那两维
> (`source` / `trigger`)—— 理由见 §2.10.4 前面那段「按触发源判」。两跳今天**仍然会跑**,
> 但只在 `origin === { source: "unknown" }` 时(019 之前写入的存量行;见 W3-① 那一节)。

**2026-10-06 追加:另两维(`source` / `trigger`)—— 判据不是「谁在说」,而是「谁发的封套 / 这一轮为什么存在」**

上表拒掉 `speakerRole` / `channel` 的理由是**它们是派生值**。下面这两维**不是派生值** ——
它们回答的是「这个封套是谁发的」与「这一轮为什么存在」,从 `agentId` / 角色 / 会话通道
**任何一处都推不出来**。而它们是判据的**全部输入**(见 §2.10.4 前那段):

| 字段 | 读者是谁 | 结论 |
|---|---|---|
| `TurnMessageStart.source: "turn"` | 前端 `originOfMessageStart`(`web/src/stores/chat.ts`)→ `channelOf` | ✅ **加**(判别联合的一半) |
| `TurnMessageStart.trigger: TurnTrigger`(**必填**) | 同上:`channelOf` 只放 `trigger.kind === "user"` 的回合正文进甲方通道 | ✅ **加** |
| `BroadcastMessageStart.source: "broadcast"` | `channelOf`:播报**无条件**进甲方通道 | ✅ **加** |
| `BroadcastMessageStart.trigger` | **没有读者,而且不允许存在** —— 播报与「这一轮为什么存在」正交,给它挂一个 `trigger` 只会让「顺手用 trigger 判播报」重新变成可写错的代码 | ❌ **结构上不存在**(`_BroadcastMustNotCarryTrigger`) |
| `source` 的第三个取值 | 没有 —— 加第三种(例如「系统提示流」)会让某条封套**静默**落进「既不是回合、也不是播报」的缝隙 | ❌ **断言封死**(`_MessageStartHasExactlyTwoSources`) |

**判据(两半,不在这里重新论证)**:

```
进甲方通道 ⟺ 用户消息(agentId === null)
          ∨ source === "broadcast"            // tell_client 的播报,无条件
          ∨ (source === "turn" ∧ trigger.kind === "user")
```

### 2.10.2b W3-① · 这两维**必须落库** —— 「刷新之后判据消失」那个缺口

> **这一节记的是一条真 bug 的闭合过程。** 它此前是**已知缺口**,写在
> `web/src/lib/data.ts` 的 `channelOf` 注释里,并有一条测试钉着它的方向。

| | 流式那一路 | 刷新(REST 回填)那一路 —— **修之前** |
|---|---|---|
| 判据来源 | `message_start` 的 `source` / `trigger`(在内存里) | `SessionMessageView` —— **一个字节都没有** |
| `origin` | 真实封套 | 只能是 `{ source: "unknown" }` |
| `channelOf` 走到哪一步 | 第 3/4 步(封套判据) | **第 5 步(回退:按角色两跳)** |
| 后果 | 工件触发的业务经理回合正文**不进**对话页 | 业务经理是 `clientFacing` ⇒ **又进了** |

⇒ 同一个回合,刷新一次就换了通道,而**界面上看不出任何异常**。两害相权之后前端的
选择是**回退**(而不是 fail-closed):fail-closed 会让「刷新一次,与业务经理的整段对话
就没了」—— 那看起来像页面被清空。

**闭合方式:落封套的输入,不落「算好的通道」。**

```
migration 019    session_messages.origin_source   ∈ {turn, broadcast} | NULL
                 session_messages.trigger_kind    ∈ {user, todo}      | NULL
shared/types     SessionMessageView.origin: MessageOrigin(必填)
                 MessageOrigin = {turn, trigger:{kind}} | {broadcast} | {unknown}
```

三条决定,每条都有理由(细节见 `migrations/019_message_origin.sql`):

1. **不落 `channel` 一列。** 判据已经改过两次(按角色 → 按触发源),落「算好的通道」
   等于把某个版本的判据冻进数据 —— 而判据再改一次时,重算的输入(封套)恰好没存。
2. **`trigger_kind` 只存 `kind`,不存 `todoKind`。** 前端对回合封套**只读 `kind`**
   (`isTurnTriggerKind`),`todoKind` 既不参与判定也没有读者 —— 落它就是多一份会漂的
   11 值闭合集。于是**落库的形状与前端读的形状是同一个**(`MessageOrigin` 的
   `trigger: { kind }`),WS 那条路也照着它收窄。
3. **`unknown` 保留,且**不回填存量行**。** 019 之前写入的行两列都是 `NULL` ⇒ 读侧如实
   给 `unknown` ⇒ 第 5 步回退判据对它们继续有效。**不回填是因为回填不了**:那两维当时
   根本没被记录,任何回填都是编造 —— 而猜错的方向(把内部回合猜成 `turn/user`)正是
   这次要修的那个 bug。

**闭合点在两处,缺一不可**(`transport/views.ts` 的 `messageOriginOf` 是**唯一**合成点):

- **写**:`repo/sessions.ts` 的 `appendSessionMessage` 把两维定成**必填实参**,并在那唯一
  一个写口上判「`trigger_kind` 有值 ⟺ `origin_source === 'turn'`」。五处调用点各自显式
  声明(`serve.ts` 的用户消息 / 两处助手正文 / 两处系统通知、`hub.ts` 的 `tell_client` 播报)。
- **读**:`SessionMessageView.origin` 必填;`http.ts` 成员页那条**显式列名**的 SQL 也补上
  两列(漏列时 `undefined` 与「存量行」在类型上长得一样 —— 那里选择**抛**)。
- **前端**:`TurnOrigin` **就是** shared 的 `MessageOrigin`(不再是前端自己的类型),
  `messageToTurn` 照抄 `m.origin`。⇒ 两条路产出同一个形状,「一边改了另一边没改」编译期就红。

**回归判据**(`tests/platform/message-origin.test.ts` + `tests/web/channel-origin-criterion.test.ts`):
带封套的行刷新之后按判据分流 —— **`h-bm-todo` 不再出现在对话页**;不带封套的行仍是
`unknown` 并走回退(旧数据兜底)。夹具守卫在 `tests/web/fixture-envelope-fields.test.ts`
的**规则 3**(`SessionMessageView` 夹具必须带 `origin`;`tests/**` 不参与 typecheck)。

#### 2.10.2c W3-③ · 提示词**不是**从仓库直接生效的 —— 出厂副本、常驻会话,与 `[未播报]` 的实测

> 这一节记的是 **2026-10-05 的一次真机端到端**(真 provider `minimax-cn/MiniMax-M3`、
> 真宿主、真排空器触发、真模型写正文)。**证据全部落在 `.probe/`**(脚本 + 原样输出 +
> 抓下来的 REST 载荷),可复核:`node .probe/w3-e2e-watch.mjs <dataDir> <baseline>`,
> 回放判据在 `tests/web/w3-e2e-real-payload.test.ts`。

**① 运行期读的是数据目录那一份,而它**不会**自动跟着仓库更新。**

```
仓库  harness/system_prompts/*.md          ← 改的是这一份,可 git 审阅
  │  npm run build:server → scripts/copy-harness.mjs
  ▼
dist/harness/system_prompts/*.md           ← **出厂副本**(「恢复出厂」的字节来源)
  │  POST /api/harness/units/:id/reset  →  harness/write.ts 的 resetPromptUnit
  ▼                                          (备份 → 原子写 → 回读)
<dataDir>/harness/system_prompts/{unit}.md ← **运行期唯一读的那一份**
```

两侧都**没有自动同步**:boot 不播撒、也不覆盖(AGENTS.md 已记「新数据目录不会自动播撒
出厂单元」;**反向那一半此前没记**)。⇒ **改了仓库提示词而没做一次 reset,运行期的模型
什么都收不到。**

实测(`~/.sansheng`,W3-③ 动手前):

| 单元 | 数据目录 | 出厂 | 缺了什么 |
|---|---|---|---|
| `business_manager.core.md` | **39 行** | 215 行 | 「正文是工作记录 / 工件触发的回合不进甲方通道 / `[未播报]` 必须写在第一行」全都没有 |
| `business_manager.align.md` | 63 行 | 125 行 | 接待会话与项目内的分段、提问必须走 `ask_client` |
| `business_manager.protocol.md` | 55 行 | 91 行 | 两条渠道的对照表 |
| `quality_reviewer.core.md` | 64 行 | 71 行 | (小改) |

⇒ **W2 那套「按触发源判通道」在真机上从来没有生效过** —— 不是代码没接线,是**规矩
没送到模型手上**。已按 §2.10.2b 的 `reset` 写回(`.probe/w3-reset-prompts.mts`;
被覆盖的文件全部落在 `<dataDir>/harness/backups/prompts/*.bak`)。

**② 常驻会话把系统提示**在建会话那一刻定盘** —— 所以 reset 之后必须重启进程。**

`promptAssembly` 在每个**新会话**建立时读盘一次,而会话池的键是 `(上下文, agent)`、
进程活着就一直复用。实测:reset 之后**同一个进程**里再触发一次,系统提示仍是
**5722 字符**;重启进程后同一次触发的系统提示是 **14340 字符**
(`.probe/w3-e2e-server-armA-stale.log` / `-armB-reset.log` 各有一行「系统提示 N 字符」)。
AGENTS.md 说工具集合文件「改完不用重启」—— 那句话对**新会话**成立,对**已经建好的**
会话不成立;而业务经理那条会话恰好是最常驻的那一条。

**③ `[未播报]` 的实测:两回合都没能让平台认账(这是本次 E2E 的结论,不是猜测)。**

| | arm A(旧提示词) | arm B(**reset 之后**,系统提示 14340 字符) |
|---|---|---|
| 触发 | 真排空器 `report_downstream`(一条 `work_failed` 事件) | 同上(再放一条事件) |
| 正文里有 `[未播报]` 这五个字吗 | ❌ 没有 | ✅ **写了** |
| 位置 | — | ❌ **在第 3 行的行中**(`…路径仍然成立。[未播报] 评估 1 条 —— …`) |
| 平台的「没留工作记录」告警 | ⚠️ 触发 | ⚠️ **仍然触发**(判据是 `/^[ \t]*\[未播报\]/` 逐行匹配) |
| `splitWorkLog`(A4) | 不触发 | **不触发**(标记不在行首) |

**这不是代码 bug**:平台(`serve.ts`)与界面(`MessageList.tsx`)的行首判据**逐字一致**,
而且两处都按行 `split` —— 我把真正文那一行**只把标记挪到行首**之后,分流立刻成立
(正样本对照在 `tests/web/w3-e2e-real-payload.test.ts`;负样本是行中引述,不得分流)。

**它是提示词的合规失败**:`business_manager.core.md:180-184` 明写「**它必须在正文的第一行**,
不是文末的备注」,而真模型把标记写进了段落中间 —— 按提示词自己的说法,那**「等于没写」**。
⇒ **修法不是「再加一句提示词」(§9.4 那条归因的教训),而是机制**:机制已经有了
(`detectUnannouncedTurn` 落一条 `system` 告警并广播),它这一次**如实报了**
—— 也就是说,**这条链路的每一环都对,只有模型的合规率是 0/2**。

**④ 顺带一条形状修正**:同一晚实测 `~/.sansheng` 已经是 **0 项目 / 0 工作项 / 0 工件**
(与 HANDOFF 里「1 根 + 4 子」的快照不是同一个库)。详见 §9.4 的第三次复核框。

#### 2.10.3 ⚠️ 与本次改动相邻的一条实缺陷:回合中途的播报会吞掉前半段

**先钉住现状(实测,不是推断)。** 临时探针直接驱动 `chat.ts` 的 `applyEvent`(它是 store 上的纯逻辑,见 `tests/web/ghost-echo.test.ts:33-37` 的同款用法;探针跑完已删):

```
输入序列: message_start(msgA) delta(msgA,"AAA") message_start(msgB) delta(msgB,"播报")
          message_end(msgB) delta(msgA,"BBB") agent_end
实际输出: turns = [{"id":"msgB","blocks":[{"kind":"text","text":"播报BBB"}]}]
```

⇒ 落进 `turns` 的**只有一轮**,id 是 `msgB`,内容是「播报BBB」;`msgA` 的前半段「AAA」**没有进过任何一轮**。而**刷新之后** REST 会给出两条独立消息(`msgA` 的正文由 `host/serve.ts:578-581` 落库,播报由 `hub.ts:256-263` 落库)⇒ **流式视图与刷新后视图不一致,而「少了半段」在界面上看不出来。**

| 项 | 内容 |
|---|---|
| **根因(两处,都在前端)** | ① `message_start` 无条件覆盖唯一的 `currentTurn`(`chat.ts:350-354`);② `delta` / `thinking_delta` / `message_end` 只判 `currentTurn` 存不存在、**不判 `messageId` 相符**(`chat.ts:368-369` · `:381-382` · `:410-411`) |
| **触发条件(平台侧)** | `tell_client` 在回合**内部** `await` 播报(`tools/client.ts:136`),而播报会发一整套信封(`hub.ts:265-267`)⇒ 业务经理一回合里「先说话 → 再播报 → 再说话」的形态**必然**踩中 |
| **修法** | 前端把 `currentTurn` 换成**按 `messageId` 索引的轮表**;`delta` / `thinking_delta` / `message_end` 按 `e.messageId` 找到那一轮再追加,找不到就丢(`chat.ts:360-367` 那条「不猜角色」的纪律保留) |
| **与 §2.10.2 的耦合** | **必须同批做。** 有了轮表,`agentId` 才只需要出现在**能建轮的那两个事件**上;没有轮表,`agentId` 加到四个事件上也救不了这一条(播报照样覆盖) |

#### 2.10.4 「思考」块与 `[未播报]` 那一行,在甲方视图里留不留

> ⚠️ **2026-10-06 已被取代(两处)。** 下面这张表是**当时**的落地方案(按角色两跳 + `[未播报]`
> 在甲方视图里「留、可展开」)。W2-④ 之后判据改成**按触发源**,于是:
>
> 1. **工件触发(平台叫醒)的回合正文整轮不进甲方视图** —— 不再有「留但要展开」这回事:
>    它根本不在这条通道里(`channelOf` 第 4 步 ⇒ `partitionTurns` 归入 `hidden`)。
>    页面上留下的是那条计数提示:「另有 N 条回合不在这条通道里(不是由你触发、也不是播报)
>    —— 到「成员」页逐人查看」。
> 2. **工作记录改到成员页查**(`Members.tsx` 的逐人会话清单)。**这是刻意的**:它是
>    「组织内部在动」的现场,不是对甲方说的话。
>
> ⇒ 本表整段作为**历史**保留(它解释 `thinking` 为什么不落库、`[未播报]` 为什么必须写得机器可判),
> 但**「甲方视图里留不留」那一列不再是现行判据**;现行判据只有上面 §2.10.2 那两半。

| 内容 | 今天落在哪 | ~~甲方视图里留不留~~(历史) | 判据 |
|---|---|---|---|
| **业务经理的 `thinking`** | **只在 WS 流里,从不落库** —— `thinkBuf` 被 push 之后**没有任何读者**(`host/serve.ts:539` 声明、`:1058` push、`:572`/`:683` 传参,再无第三处);`grep -rn 'kind: "thinking"' src/` = **0** | **留,但默认折叠** | 它是**与你对话的那个人的推理**,不是别人的;而且它**留不住** —— 一旦要求「历史里也能检查」,就得先落库(`session_messages.kind` 的 CHECK **已经允许** `'thinking'`,`migrations/009:47`),那是写入侧改动,不是展示改动 |
| **其他三个角色的 `thinking`** | 同样只在流里 | **成员页里看不到,而且这是结构性的** | 同上:**没有落库就没有历史**。要让「检查」覆盖推理,必须先落库(§12 #13) |
| **`[未播报]` 那一行** | 是业务经理**正文的一部分**,随正文落成 `assistant` 会话消息(`serve.ts:874`) | ~~留,但必须与「播报」视觉分开~~ ⇒ **整轮不进对话页;成员页可查** | 它是 §2.9 那条纪律的**唯一现场**(§2.9 末):删了它,「判断过」与「漏了」在记录里就长得一模一样。硬要求写在 `harness/system_prompts/business_manager.core.md:164-199`(「每个回合的正文都以一行工作记录开头」;平台按 `^[未播报]` 认它,写成列表项或放在文末**都不算**) |
| **分流的判据**(A4) | `web/src/components/chat/MessageList.tsx` 的 `splitWorkLog`(纯函数)**仍然在**,仍然有测试(`tests/web/a4-worklog-thinking.test.ts`) | **行首匹配 `[未播报]`** → 折进一块「工作记录」,不进甲方气泡 | 见下面「⚠️ A4 的输入变得很窄了」 |

**一句话判据(历史版)**:两者都属于**内部视图**,甲方视图要**能展开**而不是**看不到** ——
看不到就等于平台替他删了证据。

> ⚠️ **A4 的输入变得很窄了(2026-10-06 复核,如实记)。** `splitWorkLog` 只作用在
> **进了甲方通道的助手正文**上(`MessageList` 渲染的是 `partitionTurns().timeline`)。
> 而 `[未播报]` 那一行按提示词**只产生在平台叫醒(todo)的回合**里(`business_manager.core`
> 「平台把你叫醒的回合(工件触发),正文的第一行就是工作记录标记」;`detectUnannouncedTurn`
> 也只检查 `trigger.kind === "todo"` 的回合)—— 那种回合**现在整轮不进对话页**。
> ⇒ 于是那条分流对**它最主要的输入**是走不到的(不是死代码,但主路径已改道)。
>
> **残余缺口(不静默)**:①成员页只渲染 **90 字截断**的 `.truncate` 正文
> (`Members.tsx` 的 `excerpt(m.content, 90)`),全文只在 `title` 悬停提示里 ——
> 而「事后能看出当时发生了什么」(7-N)要的正是**那一段全文**;
> ②`splitWorkLog` 与 `[未播报]` 只对**没调 `tell_client` 的客户端可见回合**才有意义
> (一次用户触发、且该回合没播 —— 提示词 `business_manager.core:187-188` 的那半句)。
> 两条都不属于本批次的改动范围,记在这里以免被当成「已经处理」。

### 2.11 工件驱动的流水线:一张声明式规则表(2026-10-04 新增)

#### 2.11.1 现状复核:唤醒判据是状态驱动,而且**代码里明写「工件不是待办来源」**

| 用户的判断 | 实测 | 结论 |
|---|---|---|
| 唤醒判据是状态驱动,不是工件驱动 | `NUDGE_CAPABILITIES`(`runtime/dispatcher.ts:202-209`)列了 `project.open` / `work.*` / `collab.*` / `change.*` / `blocker.*`,**没有 `blackboard.write`**;注释把理由写死了:「`blackboard.write`(产出)**不在里面**:写工件**不产生新待办**(**工件不是待办来源**)」(`:194-196`) | ✅ **成立,而且比「没做」更强:这是刻意的** |
| 规则散在 `collectTodos` 的 8 个分支里 | `collectTodos`(`runtime/dispatcher.ts:310`)里逐条 push;`TodoKind` 是 8 值闭集(`:110-126`) | ✅ 成立(⚠️ 本文 §2.4.2 引的 `dispatcher.ts:186` **是漂的**,实际在 `:310`) |
| 没有一张「工件 → 动作」的表 | `grep -rn 'RULES\|Rule\[\]' src/platform/runtime/` = **0** | ✅ 成立 |
| 工件 kind 共 10 个,没有「交付物」 | `shared/types/platform.ts:64-74` = 10 个;`grep -rni 'deliver\|handover' src/ shared/ harness/ migrations/` = **0** | ✅ 成立 |
| (附)「交付物」不是新词,是**回归** | 旧系统有一个 `delivery`(交付物卡)块,随计划概念一起被删 —— 注释还在:`grep -rni 'deliver\|handover' web/` 的 3 处命中全部是这段历史说明(`web/src/components/chat/MessageList.tsx:4-5` · `stores/chat.ts:39`) | ✅ 成立 |
| `grep deliver\|handover\|交付 = 0` | **`交付` 在 `src/` + `harness/` 里有 26 处命中** | ❌ **不成立**(见 §2.11.5:「交付物」今天已经有**三个**所指) |
| `review_work ← works.status='done' AND review_state='pending'` | `listWorksPendingReview`(`repo/works.ts:612-621`)→ 待办 `dispatcher.ts:441-448` | ✅ 成立 |
| `execute_work ← works.status='open' AND 前置满足` | `pendingWork.ts:110-121`:`status ∈ {open, in_progress}` **且** `depsSatisfied` | ⚠️ **半对:不止 `open`**,`in_progress` 也算(重跑一条 `in_progress` 的工作项是合法的) |
| `decompose_project ← 项目零工作项` | `pendingWork.ts:131-133`:`listWorks(...).length === 0` **且** project `active` | ✅ 成立 |
| 「没有任何地方告诉项目经理要建树」(§9.4 的归因) | `grep -rn parentWorkId harness/` = **0** 是对的,但**作用域漏了运行期任务提示词**:`decompose_project` 渲染出的正文里就有「多件产出同属**一个交付物**时,用 `parentWorkId` 把它们挂到一条根工作项下面」(`runtime/dispatcher.ts:517-518`) | ❌ **结论错**(细节与影响见 §9.4 的修正框) |
| `bridge()` 两处、按角色分工 | 调用点确在 `serve.ts:572` 与 `:683`;但 **`runAgentTurn` 不只跑业务经理** —— `drainProject` 的 `runAgentTurn` 回调(`serve.ts:861-862`)让它同时跑**项目经理与质检** | ⚠️ **半对**:572 那条 = 业务经理(用户消息,`:347`)**+ 项目经理 + 质检**(待办);683 那条 = worker |

**缺的不是「判据」,是三个环节。** `TodoKind` 的 8 个取值(`dispatcher.ts:110-126`)里**没有**「整合」「交付」;`grep -rn '整合' src/` 只命中两处**测试数据注释**(`repo/works.ts:728` · `:862`)。⇒ 流水线今天**停在质检**,后面没有东西推动它。

#### 2.11.2 张力①的结论:条件侧 = 「**工件事件**触发」+「**状态/集合**谓词收口」

用户的原话里其实有**两个句子**,而只有一个能被「纯工件」表达:

| 说法 | 纯工件能表达吗 | 判据 |
|---|---|---|
| 「3 个子项**都跑完了**」 | ❌ **不能** | 它是**集合 + 状态**谓词(沿 `works.parent_work_id` 的子树全部终态),**不是任何一条工件的属性** |
| 「**产出了工件**」 | ✅ 能 | 它就是「`artifacts` 里多了一行」 |

**「跑完了」为什么不能改写成工件谓词 —— 两条反例,都指着已在册的语义:**

| 反例 | 纯工件判据会怎么错 | 依据 |
|---|---|---|
| 一个子项是 **`cancelled`** | 它**没有工件** ⇒ 「全部子项都有工件」永远为假 ⇒ **里程碑永不达成、整合永不触发,整条流水线静默停在原地** | `cancelled` 的定义就是「这块范围不要了,输入少了一块」,**不阻塞也不产出**(§2.8) |
| 一个子项产了工件但仍 `in_progress` | 纯工件判据**提前为真** ⇒ 在还有人写的时候就去整合 | 产出边(`artifacts.work_id`)记的是「**产出 ∪ 关于**」,**不是**「这条工作项结束了」(§2.6 末) |

**⇒ 结论(写给实现的人)。** 一条规则写成 `when <工件事件> and <谓词> then <动作>`:

| 成分 | 允许 | 不许 | 可测判据 |
|---|---|---|---|
| **触发侧** `on` | 必须是**库里新落了一行**这一事实:`artifacts` 插入 · `works` 状态迁移 · `asks` / `meetings` / `change_requests` 的行事件 · `tick`(兜底) | 不许「模型在回复里说了什么」;不许「上一轮观察到的」 | `collectTodos(db, projectId, now)` **不需要知道哪个事件触发**就能算出同一份待办(§9.4 的纯度纪律,逐字保留) |
| **条件侧** `if` | **可以是状态 / 集合谓词** —— 这是「3 个子项都跑完」唯一正确的表达 | 不许只读进程内状态;不许读「刚才发生了什么」;**不许读 `body`**(见 §2.11.3) | 同一个库状态 ⇒ 同一份待办;重启后结果不变 |

**一句话:「工件推动流程」成立在**触发侧**;条件侧必须放状态/集合进去,否则 `cancelled` 会把流水线钉死。**

#### 2.11.3 张力②的结论:规则判「该叫醒谁」,判不了「这个质检**通过**了吗」

| 问题 | 谁判 | 判据落在哪 | 证据 |
|---|---|---|---|
| 这条产出**该不该审** | **规则** | `works.status='done' AND review_state='pending'` | `repo/works.ts:612-621` → 待办 `dispatcher.ts:441-448` |
| **该叫醒谁**去审 | **规则** | 花名册里 `role='quality_reviewer'` | `dispatcher.ts:439-448` |
| 审**过**了没有(流程上) | **规则(只看回合成不成)** | 质检那个回合**成功结束后**平台写 `review_state='done'` | `dispatcher.ts:817-820` → `repo/works.ts:632-637` |
| 审**通过**了没有(内容上) | **角色判断 —— 而且今天它的话没有任何机械读者** | 结论在 `review_finding` 的 `status`(`board_write` 的模型入参,`tools/blackboard.ts:191-194`)或正文里 | `grep -rn 'review_finding' src/` 共 **12 处**命中(含 `shared/` 的联合声明才是 13),逐条看过:**只有 `runtime/execution.ts:163` 把它列进 `ABOUT_ONLY_ARTIFACT_KINDS`**,其余是联合声明 / `writeKinds` / 注释 / 一段任务提示词(`dispatcher.ts:527`)—— **没有一处按 `status` 分叉** |

**这条边界的原话就在代码里**:`markWorkReviewed` 的注释写着「**判据不是「模型有没有写 `review_finding`」**—— 那依赖模型自己建立 artifact_link,现有模型里没有保证……平台能确定的事实是:**这一份产出已经被交给质检看过一次了**」(`repo/works.ts:626-630`)。

**而且质检**改不动**工作项状态**:`quality_reviewer` 的 ceiling 里**没有** `work.update`(`identity/role.ts:225-236`,只有 `work.read` / `work.list`)。⇒ 「质检不通过 → 打回重做」今天**没有机械路径**。

**另有一条更靠前的事实:工件的 `status` 写完之后基本**改不了**。** 唯一的生产变更点是 `setArtifactStatus`(`tools/client.ts:193`,把 `client_question` 标成 `accepted`),而那个被设计成通用变更口的 `applyArtifactStatus`(`tools/blackboard.ts:285-295`,docstring 写着「供**派发器**与测试引用」)**全仓零调用方**(`grep -rn 'applyArtifactStatus' src/ tests/ web/ shared/` 只有它自己的定义),HTTP 面上也没有改工件状态的路(`transport/http.ts` 只有 projects / settings / harness / profile / client-questions 那几个 POST/PUT)。⇒ 质检的结论是 `board_write` 的**一次创建时入参**(`tools/blackboard.ts:191-194`,默认 `open`),**没有「复审后更新上一次结论」这条路**;要表达「改判」只能新写一条工件(§12 #14)。

**边界画法(三条,每条都可直接写成测试):**

| # | 规则**能**判 | 规则**不能**判 |
|---|---|---|
| 1 | **谁该被叫醒**(花名册 + ceiling) | 这条产出**够不够好** |
| 2 | **该被叫醒几次**(`dispatch_attempts` 预算 / 合并窗口) | 这次唤醒**值不值得**(措辞与播报取舍,§2.9) |
| 3 | **该看哪几条**(集合判据:未审的 / 终态的 / 有产出的) | 看完之后的**判定内容**(`review_finding.status`) |

**由此得到一条新增规则的硬约束**:规则的 `if` **只读结构化的列**(状态、集合、`kind`、`work_id`、`status`),**不读 `body`**。一旦哪条规则去读正文,「不需要大模型判断」这句话就失效了,而失效的表现是**规则开始做语义猜测** —— 本项目最贵的一类 bug。⇒ `review_finding.status` 是**结构化列**,所以「不通过要打回」这条**可以**机械化;它今天的缺口是**没有人读它**,不是它不可判(接不接,见 §12 #14)。

#### 2.11.4 规则表:形状与实例

**形状**(建议落在 `runtime/dispatcher.ts`,与 `collectTodos` 同文件 —— 判定只有一处,规则表也不该有第二处):

```
Trigger(闭合集) =
  artifact_inserted · work_status_changed · ask_opened · ask_answered
  · meeting_concluded · change_decided · tick(兜底)

Rule = {
  id      : string
  on      : Trigger[]        // 触发侧:哪一类**新事实**值得重查。不携带状态(§2.11.2)
  if      : (q) => TodoDraft[]   // 条件侧:纯查询;可含状态/集合谓词;不许读 body
  then    : TodoKind + 目标角色
  why     : string           // 有事故见证的写现场;补环的写「补的哪一环」
}
```

**四条实例(上两条已有、下两条是新补的):**

> ⚠️ **2026-10-06 更正:上表只是**当时**要新增的四条 —— `runtime/dispatcher.ts` 的
> `RULES` 现在共 **11 条**(`id: "…"` 数一遍即得,`grep -c '^    id: "' src/platform/runtime/dispatcher.ts`)。
> 下表把四条补成**全量 11 条**,行号与 `PRIORITY` 一起对齐(此前 §2.11.4 与本文件
> §9.4 的待办表都**缺第 11 条 `resolve_blocked_work`**,而它是「子项 blocked 没有
> 驱动者」那条真机静默停摆的修法 —— 缺它比缺别的更容易让人以为「卡住是设计如此」)。

| id | `on` | 动作(`then.kind` / 目标) | `PRIORITY` |
|---|---|---|---|
| `answer_pending_ask` | `ask_opened` · `ask_answered` · `tick` | `answer_ask` / 名册上那位 | 0 |
| `attend_pending_meeting` | `meeting_concluded` · `tick` | `attend_meeting` / 名册上那位 | 1 |
| `review_pending_change` | `change_decided` · `tick` | `review_change` / 名册上那位 | 2 |
| `fix_stranded_assignment` | `work_status_changed` · `tick` | `fix_work_assignment` / 项目经理 | 3 |
| **`resolve_blocked_work`** | `work_status_changed` · `tick` | `resolve_blocked_work` / 项目经理 | 4 |
| `decompose_empty_project` | `tick` | `decompose_project` / 项目经理 | 5 |
| `execute_assigned_work` | `work_status_changed` · `tick` | `execute_work` / worker | 6 |
| `review_done_works` | `work_status_changed` · `tick` | `review_work` / 质检 | 7 |
| `integrate_reviewed_subtree` | `work_status_changed` · `artifact_inserted` · `tick` | `integrate` / 项目经理 | 8 |
| `handover_deliverable` | `artifact_inserted` · `tick` | `handover` / 业务经理 | 9 |
| `report_downstream_events` | `work_status_changed` · `tick` | `report_downstream` / 业务经理 | 10 |

> `PRIORITY` 是**字典**(`dispatcher.ts` 的 `const PRIORITY`),所以「数字小的先跑」
> 是可查的,不是推断。两条「修」的待办(3 / 4)刻意挨在一起并排在拆解之前:
> 派活错了与活被卡住都是项目经理的**存量修复**,它们挡着下面的执行 / 审查 / 整合。

**四条实例的判据细节(原文保留,仍是这四条的设计理由):**

| id | `on` | `if`(机械判据) | 动作 | `why` |
|---|---|---|---|---|
| `review_done_works` **(已有)** | `work_status_changed` · `tick` | `works.status='done' AND review_state='pending'`(`repo/works.ts:616`) | 叫醒**质检** → `review_work` | 「等待审查」是库里的真状态(migration 013);重启后照样查得出来 |
| `fix_stranded_assignment` **(已有)** | `work_status_changed` · `tick` | 存在非终态工作项,其负责人**不存在或不是 worker**(`dispatcher.ts:334-341`) | 叫醒**项目经理** → `fix_work_assignment` | 真机现场:项目经理把活派给了业务经理,那条工作项至今 `open` |
| `integrate_reviewed_subtree` **(新)** | `work_status_changed` · `artifact_inserted` · `tick` | 存在根工作项 R:①R 的后代**全部终态**(`cancelled` 按 §2.8 算**收口**,不算阻塞);②其中每条 `done` 的后代都 `review_state='done'`;③**R 上还没有 `deliverable` 工件** | 叫醒**项目经理** → `integrate` | 流水线在质检之后**没有下一环**(§2.11.1);`grep 整合 src/` 只命中测试数据注释 |
| `handover_deliverable` **(新)** | `artifact_inserted` | 存在 `kind='deliverable'` 且 `status='accepted'` 的工件,且它**还没有**对应的交付会话(见 §2.11.6) | 叫醒**业务经理** → `handover` | 交付之后**没有下一环**;这条是「业务经理主动开一条对话」的唯一入口 |

> **③ 是不可省的,而且它正是 `deliverable` 这个 kind 存在的理由。** 没有「已整合」这个**结构化事实**,`integrate` 规则要么永不触发,要么**反复触发到尝试预算用尽** —— 而预算按 AGENTS.md 的定性「**不是判据,是限流**」,用它兜住一条每次都成立的规则,等于让流水线静默停在一个「看起来跑过很多次」的地方。

#### 2.11.5 张力③的结论:`works.status` **不退化成登记簿**;而「交付物」这个 kind 值一次**重建表**

**先回答关系问题:取代、并存,还是退化?—— 三者都不是,是「各管一段」。**

| 管什么 | 载体 | 今天的状态 |
|---|---|---|
| 「这块活谁在干、干到哪一步」 | `works.status`(6 值闭集 + 唯一写口 `repo/works.ts:547`,迁移规则见 §2.7) | **不动**。它是 `execute_work` / `fix_work_assignment` 的判据 |
| 「审没审」 | `works.review_state`(`none\|pending\|done`,migration 013) | **不动**。它是 `review_work` 的判据,而且是「**平台维护的记账**」这一形态的既有先例 |
| 「整合了没有 / 交付了没有」 | **`deliverable` 工件的存在性** | **新增**。判据是工件,不是 `works` 上再加一列 —— 这正是用户要的「**工件即推动流程**」 |

⇒ **不需要在 `works` 上加列**(备选方案 β 见下)。`works.status` 继续管执行,`review_state` 继续管审查,而**阶段的推进**由「**工件在不在**」表达。

**⚠️ 「交付物」这个词今天已经有三个所指,加第四个之前必须先分清:**

| # | 所指 | 证据 |
|---|---|---|
| 1 | **worker 的产出工件**(「工件就是你的交付物」) | `runtime/execution.ts:192`(拼给 worker 的任务描述) |
| 2 | **根工作项本身**(「根工作项就是甲方能听懂的那一层(它是交付物本身)」) | `repo/works.ts:327` |
| 3 | **项目终态**(UI 里 `projects.status='done'` 显示成「已交付」) | `web/src/lib/vocab.ts:37` |
| 4 | **新增:一份 `deliverable` 工件** | 本节 |

⇒ **文档与代码里从此不许单独写「交付物」**;一律写清是①worker 产出、②根工作项、③项目终态,还是④`deliverable` 工件。

**⚠️⚠️ `deliverable` 需要一次重建表。而朴素做法会不会静默清空 `artifact_links`,取决于库里恰好有没有数据 —— 下面用探针把这个分叉钉死。**

`artifacts.kind` 是 **CHECK 闭集**(`migrations/008_blackboard_change.sql:32-35`,10 个取值)。放宽闭集在 SQLite 上**只能重建表**:`ALTER TABLE ... ADD CONSTRAINT ... CHECK` 被接受、也真的生效,但多个 CHECK 之间是 **AND**,**只能收紧**。已实测(本仓真实迁移链 001→015,`foreign_keys = ON`):

```
ADD CONSTRAINT(含 'deliverable')  → 无错应用
写 kind='deliverable'             → 仍被拒:CHECK constraint failed: kind IN (…10 个…)
```

**而 `artifacts` 与 `dispatch_events` 不同:它有子表,而且是两个 `ON DELETE CASCADE`。**

```
谁引用 artifacts(静态核对 `grep -rn 'REFERENCES artifacts' migrations/` = 3 处):
  artifact_links.artifact_id        REFERENCES artifacts(id) ON DELETE CASCADE   (008:58)
  artifact_links.target_artifact_id REFERENCES artifacts(id) ON DELETE CASCADE   (008:60)
  asks.resolution_artifact_id       REFERENCES artifacts(id)                     (009:75)
                                     ↑ 无 ON DELETE 子句 = NO ACTION
```

⇒ 于是「建 `_new` → 拷 → `DROP` 旧 → 改名」那套(015 在 `dispatch_events` 上用过的)**在这张表上会分叉成两种行为,而哪一种发生取决于运行时数据**:

| 探针(真实迁移链 001→015,`foreign_keys = ON`,带正负样本自检) | 结果 |
|---|---|
| 正样本:迁移链跑通后 `artifacts` / `artifact_links` | `2 / 1` ✅(探测器没坏) |
| 负样本:`foreign_key_check` | `[]` ✅ |
| 探针 A:`asks` 有非空 `resolution_artifact_id` | 重建**响亮失败**:`FOREIGN KEY constraint failed`,事务回滚,**什么都没丢**(NO ACTION 那条外键在拦) |
| 探针 B:`asks` 全部为 `NULL` | 重建**成功**,`artifacts` 完好(2),而 **`artifact_links` 从 1 变成 0**;`foreign_key_check` = `[]` —— **一声不响** |
| 真机库(`~/.sansheng/sansheng.db`)现状 | `asks = 0` · `artifact_links = 0` —— **今天走的是探针 B 那条路** |

**这就是那个「会静默删光数据」的地方**,而且它比 012 那次更坏一层:**它是否删数据取决于库里恰好有没有一条作答记录。** 「在我机器上它报错了,所以我加了对的处置」这句经验**不可移植** —— 换一个 `asks` 为空的库,同一个迁移文件会安静地清空 `artifact_links`(今天恰好是 0 行,所以看不出差别)。

**⇒ 唯一的正确 recipe 是 012 那套「先把内容移出去 → 重建 → 灌回」**(`migrations/012_intake_session.sql:38-78` 写明了它为什么是唯一安全的路)。已实测通过:

```
1  CREATE TABLE artifact_links_backup AS SELECT * FROM artifact_links;   ← 必须先备份**子表**
2  CREATE TABLE artifacts_backup      AS SELECT * FROM artifacts;
3  DROP TABLE artifacts;               -- 级联清空 artifact_links —— 内容已在①
4  CREATE TABLE artifacts (… kind CHECK 含 'deliverable' …);
5  INSERT INTO artifacts … SELECT … FROM artifacts_backup;
6  INSERT INTO artifact_links … SELECT … FROM artifact_links_backup;      ← 少了这步就是静默删数据
7  DROP TABLE artifacts_backup; DROP TABLE artifact_links_backup;
8  显式重建 008 的**全部五个索引**—— `DROP TABLE` 会连索引一起丢掉
     idx_artifacts_project / _kind / _status / _author / _recent(008:46-51)
实测:重建前后 artifacts/links = 2/1 → 2/1 ✅;foreign_key_check = [] ✅;写完 'deliverable' 成功 ✅
```

**落地前的前提核对(照 015 的形态,逐条要对真机库的**副本**跑,不是在内存库上跑):**

| # | 核对 | 怎么算过 |
|---|---|---|
| 1 | `grep -rn 'REFERENCES artifacts' migrations/` = **3 处**(上表),不得多 | 多一处就要重新评估 |
| 2 | 备份 + 灌回之后 `artifact_links` 行数与重建前**相等** | 正样本:重建前必须 `> 0`;`= 0` 的库上看不出这条错 |
| 3 | `PRAGMA foreign_key_check` = `[]` | 与 2 一起才有意义(`[]` 单独不说明任何事 —— 探针 B 也是 `[]`) |
| 4 | 五个索引都在 | `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='artifacts'` |
| 5 | 重建后**写得进** `kind='deliverable'` | 负样本:重建前必须写不进 |
| 6 | `INTENTIONAL_REBUILDS` 登记(`tests/platform/migrations.test.ts`) | 未登记的重名仍然是错误(批次 5 的事故形态) |
| 7 | 迁移文件头写清「为什么不是 ALTER」+「为什么必须备份 `artifact_links`」 | 照 012 / 015 的头注释形态 |

**备选方案 β(零重建风险,代价是一处启发式)**:不加 kind,改用 `ALTER TABLE works ADD COLUMN integrated_at INTEGER`(已实测:纯加法、成功),让 `integrate` 规则的终止判据落在**列**上。**代价**:「哪一条工件是交付物」就没有结构化答案了,`handover` 只能按「项目经理写得最晚的那一条」猜 —— 那正是本项目反复拒绝的**启发式代理**。**推荐 α(加 kind + 按上表重建),把 β 留作退路。**

**⚠️ 加一个 kind 的同步面(六处,漏一处就是红灯)**:`shared/types/platform.ts:64`(协议契约)· `identity/role.ts:51`(内部联合)+ `:63`(`ARTIFACT_KINDS` 数组)· 本文 §6.1(与代码**必须逐字相同**,由 `tests/platform/design-conformance.test.ts:217` 钉住)· `DESIGN-AGENTS.md` §8 汇总表 **与**各角色段内的 `**writeKinds**` 内联声明(**E13 要求两处互相一致**)· `web/src/lib/vocab.ts:78` / `:91`(`Record<ArtifactKind, …>` —— 漏了它 `tsconfig.web.json` 会红,这是**唯一一处编译器替我们守着的**)。

#### 2.11.6 交付之后:谁能建会话、建了之后甲方看到什么

**判据先定:建会话是平台的事,不是模型的动词。** 四个角色的能力闭集里没有「建会话」这种东西,今天也没有任何工具能建它(§2.4.2:`ProjectSession` 的维护者一栏写的是「平台」)。⇒ **业务经理的「主动」体现在它决定了要不要交付、怎么交代;会话由平台在它那个回合成功结束后落地**(与 `markWorkReviewed` 完全同形:回合成功才记账,失败/中断就下次重来 —— `dispatcher.ts:817-820`)。

| 问题 | 结论 |
|---|---|
| **谁建** | **平台**,在 `handover` 待办那个回合**成功结束后**(判据同 `markWorkReviewed`) |
| **建什么** | 一条新的 `project_sessions` 行。**表结构今天就允许**(§8.1:`1 Project — 1:N Session`;`migrations/012:88-89` 实测「同一项目插三条会话依然全部成功」) |
| **怎么关联** | `project_sessions` 加一列 `deliverable_artifact_id TEXT REFERENCES artifacts(id)`,**纯加法**(已实测:`ADD COLUMN … REFERENCES` 成功;悬空引用被外键拒掉)。它同时是 `handover` 规则的终止判据 |
| **甲方看到什么** | 对话页多出**一条**会话,首屏是这场交付的往来;**其他角色的回合不在里面**(它们被 §2.10 的 `agentId` 过滤挡掉) |
| **旧会话怎么办** | 留着。`listProjectMessages` 已经把同项目的多条会话**按时间归并**(`views.ts:238-254`),所以「历史」不会丢 |

**⚠️ 这里有一条必须先处置的接线地雷:`ensureSession` 会挑「最新那一条」。**

```
listSessions(db, projectId)  ORDER BY created_at DESC      (repo/sessions.ts:86-97)  ← 新的在前
ensureSession(...)           const existing = listSessions(...); if (existing.length > 0) return existing[0]!.id
                                                                                    (hub.ts:291-305)
```

⇒ 交付会话一建出来,`ensureSession(db, projectId, …)` 就会开始把**后续所有角色的消息**写进那条新会话(它在六个地方被调:`serve.ts:327` 用户消息 · `:424` 接待迁移 · `:535` `runAgentTurn` · `:657` `runWorkInSession` · `:915` 系统消息 · `hub.ts:255` 播报)。后果:**「对话页 = 甲方 ↔ 业务经理」的过滤仍然成立(按 `agentId` 过滤),但「这条消息属于哪个对话」就没有答案了**;而它的表现是**静默的**(消息都在库里,只是分错了会话)。

⇒ **因此「新建一条对话」这一步必须同时把 `ensureSession` 改成显式的**:给它一个**通道**参数,并把通道落到数据上(建议 `project_sessions` 再加一列 `channel TEXT NOT NULL DEFAULT 'internal' CHECK (channel IN ('internal','client'))` —— 已实测:`ADD COLUMN … NOT NULL DEFAULT … CHECK` 成功,非法值被拒)。六个调用点各自声明它写的是内部通道还是甲方通道,**默认值只是为了让既有行有值,不许当成判据**。**这一条不做,就不要做「新建对话」。**

**成员页的清单(点 1 的另一半)**:按用户的原话读 —— **「他产生了什么对话」= `session_messages` 按 `agent_id` 分组的清单**,不新增数据源、不新增端点(读面已有 `GET /api/projects/:id/messages`,`SessionMessageView.agentId` / `.agentName` 都在,§2.10.1)。**按 agent 分组而不是按 role**:`agentId` 是身份,`role` 是属性(§2.4.2 的 M:N 基数)。工件那一面已经有「工件」页,不在这里重复。

### 2.12 落地顺序与每步验收判据(2026-10-04 新增)

**排序理由只有三条**:①**契约先于实现**(否则前后端没有共同目标);②**重构先于新功能**(规则表骨架先落地并保持行为不变,否则「回归」与「新功能」的失败分不清);③**危险的那一步单独走、单独评审**(§2.11.5 的重建表)。

> **为什么不写进 §10.3 的阶段表。** `docs/DESIGN-AGENTS.md` §11 与 `ADR-001` 按**名字**引用「阶段 12」,插阶段会让那些引用错位,而 E14 抓不住(它只校验「指得着」)。这与 §2.4 开头那条理由是同一件事。§10.3 作为**当时**的路线记录保持不动。

| 步 | 做什么 | 为什么在这个位置 | 验收判据(可执行的) |
|---|---|---|---|
| **A1** | 契约:`message_start` / `tool_start` 加必填 `agentId`;`hub.emitMessageStart` 加参数;`tell_client` 把 `ctx.agent.id` 透传进通道(§2.10.2 末) | 先定契约,4 个构造点才有共同目标 | 两条 `tsc --noEmit` 全 **0 error**;`git grep -n 'emitMessageStart'` 的每个调用点都显式传了 agent |
| **A2** | 前端:**按 `messageId` 的轮表**取代 `currentTurn` 单槽(`chat.ts:350-411`) | 不做它,`agentId` 救不了 §2.10.3 的吞字 | **新增一条回归测试**,钉住 §2.10.3 那段序列的输出 = 两轮(`msgA` = 「AAABBB」、`msgB` = 「播报」);`tests/web/ghost-echo.test.ts` 5 条**不改**仍绿 |
| **A3** | 对话页只渲染 `agentId IS NULL`(甲方)或该 agent `clientFacing`;成员页加「他产生了什么对话」清单 | 有了 A1/A2 才有判据 | 真机库(13 条:`wk`5/`bm`4/`pm`1/`qa`1/`null`2)打开对话页**只看到 `bm`4 + `user`2**;成员页四个角色各自的条数正确;`npm test` 全绿(**≥840**,含 A2 新增的那条回归测试)<br>⚠️ **判据已被取代(W2-④)**:两跳只是 `origin === unknown` 时的**回退**,主判据是 `source` / `trigger`(§2.10.2)。A3 的**验收事实**(成员页八个分组、条数来自 `GROUP BY`)仍然有效 |
| **A4** | `[未播报]` 行首分流成「工作记录」块;`thinking` 保持折叠(§2.10.4) | 与 A3 同一处渲染 | 含 `[未播报]` 的消息在对话页**可见**且**不在甲方气泡里**;**负样本**:行中出现的 `"[未播报]"` 不得被分流<br>⚠️ **判据已被取代(W2-④ + W3-③)**:`[未播报]` 只产生在**平台叫醒(todo)的回合**里,而那种回合**整轮不进对话页** ⇒ 分流的**主输入走不到了**。真机实测还发现它常常**不在行首**(见 §2.10.2c 的③与 `.probe/w3-e2e-turn2-reset-prompts.txt`):`splitWorkLog` 在真正文上**不触发**,而同行首化之后立刻触发 |
| **B1** | 规则表骨架:现有 8 个分支改写成 `RULES`(`on`/`if`/`then`/`why`),**行为完全不变** | 先重构再加规则 | `tests/platform/dispatcher.test.ts` **一字不改**全绿;`collectTodos` 的入参仍只有 `(db, projectId, now, 预算)`,不读进程内状态 |
| **B2** | 触发侧接线:`NUDGE_CAPABILITIES` 加 `blackboard.write`;宿主把 `execution.producedArtifacts` 当**「值不值得重查」的布尔**用(不是判据) | 工件事件必须真能叫醒一次,规则才有机会跑 | 新测试:`board_write` 成功后 nudge 被敲一次;且 `collectTodos` 在「有事件 / 无事件」两种输入下**输出相同**(纯度回归) |
| **B3** | **接线那条今天被丢掉的产出**:`producedArtifacts` 已经算出来了,但 `host/serve.ts:673-713` 只读 `turn` / `work`,**没有读者**(全仓引用 = `execution.ts` 内 7 处 + `tests/platform/execution.test.ts` 7 处) | 它是「工件驱动」现成的钩子,不用它就得另外偷听 `board_write` | 宿主路径上能观察到「本回合产出了 N 个工件」;`renderExecutionReport`(`execution.ts:397`)的 CLI 行为不变 |
| **C1** | **migration 016:重建 `artifacts`,`kind` 加 `deliverable`** —— 按 §2.11.5 的 8 行 recipe 与 7 条前提核对 | 它是 `integrate` 规则的**终止判据**(§2.11.4 的③);同时它是最危险的一步,必须单独评审 | §2.11.5 那 7 条逐条过,并且**在真机库的副本上跑过一次**,不是在内存库上 |
| **C2** | `writeKinds` 给项目经理加 `deliverable`;六处同步面全改(§2.11.5 末) | 闭集六处不同步 = 红灯 | `npm run check:design`(E8/E9/E13)绿;`npm test` 的 `design-conformance`(§6.1 ↔ 代码 `ARTIFACT_KINDS`)绿;`vocab.ts` 的 `Record` 补齐 |
| **C3** | 新 `TodoKind`:`integrate`(项目经理)/ `handover`(业务经理)+ 两条规则(§2.11.4) | 补上流水线缺的两环 | 真机:`子项全部终态 → 项目经理被叫醒一次 → 写出 `deliverable` → 业务经理被叫醒一次`;且**第二次 tick 不再重复叫醒**(③ 生效) |
| **C4** | 业务经理主动开一条对话:**migration 017**(纯加法)给 `project_sessions` 加 `deliverable_artifact_id` 与 `channel`;平台在 `handover` 回合成功后建会话;把 `ensureSession` 改成显式通道(§2.11.6) | 放在最后:它依赖 C3 的 `deliverable`,而且 `ensureSession` 那条地雷必须先拆 | 交付后对话页多出一条新会话;**回归**:交付之后再跑一轮 worker,消息**不得**落进交付会话(这正是 `ensureSession` 那条地雷的判据) |

**全局验收(A/B/C 全做完之后)**:`npx tsc -p tsconfig.server.json --noEmit` = 0 · `npx tsc -p tsconfig.web.json --noEmit` = 0 · `npm test`(**≥839**,新增测试后条数只增不减)· `npm run check:design` E1–E14 全绿 · `git status --short` 只有 `docs/DESIGN-PLATFORM.md`(设计阶段)。

---

### 2.13 运行态读面:「此刻在做什么」(2026-10-06 新增)

**问题(用户的原话)**:「现在只有做了些什么,没有正在做什么……我担心系统已经挂了,而实际还在运行」。这不是「再加一个页面」,而是**读面缺了一维**:此前所有读面都是**过去时**(`session_messages` 落库的行、`works` 的状态、`turn_usage` 的行),而「现在」**结构上**不在其中 —— 一个正在跑 16 分钟回合的 worker 与一个已经停了三小时的 worker,在「他产生了什么对话」里长得**一模一样**。

**三条判据(决定了这一维的划法)**

1. **「现在」只能来自宿主内存,而内存事实必须与库事实分开呈现。** 忙闩(`transport/hub.ts` 的 `busy`)与排空兜底定时器的心跳(`host/scheduler.ts` 的 `lastRunAt()`)是**进程内**的,重启即清零;`works.status='in_progress'` 与 `collectTodos` 的待办是**库里**的,重启后照样成立。混成一个字段之后,「重启后还没跑过任何回合」与「一切正常但没有在跑的回合」在界面上会长得一样。
2. **判定只有一处,读面不许重算。** `ProjectLiveView.agents[].todos` 直接来自 `collectTodos`(排空器的判据),连合并唤醒的两个旋钮(`reportBatchSize` / `reportMaxDelayMs`)都由宿主**原样交付**(`LiveCollectOptions`)—— 各写一份默认值的后果是:命令行改了阈值,而页面继续**自信地说一个排空器不会做的动作**。
3. **「读不到」不是「空闲」。** 只挂 HTTP 的装配拿不到内存快照,那时契约返回 `runtime: "unavailable"`、`turn` 一律 `null`、`lastRunAgeMs` 为 `null`,并且在界面上**必须**与「此刻没有回合在跑」分开显示。这是本次新增里最容易退化成假话的一格(两者在屏幕上长得一样)。

**落地**

| 层 | 落点 |
|---|---|
| 内存登记 | `PlatformHub.busy` 从 `Set<string>` 改为 `Map<string, BusyTurn>`:`{ projectId, agentId, startedAt, trigger }`;新增 `runningTurns()`。`setBusy` 的 `true` 重载**强制**传 `trigger`(漏填编译不过)。交班(排队者接闩)时**换一份登记** —— 沿用上一轮的 `startedAt` 会把「已跑多久」算成两段之和 |
| 心跳 | `FixedDelayLoop.lastRunAt()`,记在**开始**跑的那一刻(不是跑完:一次排空可以跑十几分钟,记在结束会让页面在整个长回合期间显示「上一次 0 秒前」) |
| 读面 | `transport/views.ts` 的 `toProjectLiveView(db, row, now, runtime, collect)`;`LiveRuntimeSnapshot` 是宿主注入的**只读**端口(`HttpDeps.live?`),三项都是惰性闭包 |
| 端点 | `GET /api/projects/:id/live` → `{ live: ProjectLiveView }`(**不参与任何判定**,纯投影) |
| 前端 | `lib/data.ts` 的 `useProjectLive`(全项目唯一一处轮询,2.5s)+ `stores/chat.ts` 的 `activityRevision`(WS 敲门砖)。成员页按角色分栏显示「正在做什么」,工件页的产出图用它点亮正在跑的环节 |

**「工件是流程的关键节点」的另一半:产出边有了读面。** `ArtifactView.workId`(migration 014 的 `artifacts.work_id`)此前只在运行时判据里有读者(`execution.ts`),前端拿不到 ⇒ 工件页只能按 kind 平铺。现在它进契约:工件页按 `works` 的 `parentWorkId` ∪ `dependsOn` 画一张**产出图**(环节 = 工作项、边 = 拆解 / 前置、工件挂在产出它的环节上);`workId IS NULL` 的决策 / 会议 / 变更 / 甲方问答**另立一处**列出 —— 它们不是「还没归位」,而是本来就不由某条工作项产出。

**删掉的一个字段(值得记下)**:`MemberActivityView` 曾经有 `lastTool`(按 `session_messages.kind='tool'` 查最近一次工具调用)。真机库实测 `SELECT kind, COUNT(*) … GROUP BY kind` 只有 `user` / `assistant` / `system` —— **`tool` 从不落库**(工具调用只走 WS 广播)。那个字段因此恒为 `null`:一个**没有写入方**的字段比没有读者更坏,它让人以为「这个角色从没动过手」。已删;「现在正在调什么工具」由前端从 WS 在飞轮(`stores/chat.ts` 的 `inFlight` 里 `kind: "tool"` 的块)读 —— 那是唯一有这个信息的地方。

**验收判据(可执行)**

| 判据 | 落点 |
|---|---|
| 缺失 `deps.live` ⇒ `runtime:"unavailable"` 且 `turn` 全 `null`;**接上** ⇒ `"host"`(负样本,防这条判据空转) | `tests/platform/project-live.test.ts` |
| 只认本项目的闩;`elapsedMs` / `trigger` 来自登记;跨项目的回合**不许**落到这个角色上 | 同上 |
| `currentWorks` 只收 `in_progress`/`blocked` 且按负责人分开;`readyWorks`/`waitingWorks` 来自 `collectPendingWork` | 同上 |
| 待办来自 `collectTodos`:`attempts/maxAttempts` 来自库里的账本,预算用满后**不再叫醒但 `exhaustedTodos` 看得见** | 同上 |
| `ArtifactView.workId`:证据 / 评审发现带边、`decision` 为 `null`;列表与详情**同形** | 同上 |
| 心跳记在**开始**(mutation 实测:改成记在结束 ⇒ 测试变红) | `tests/platform/scheduler.test.ts` |
| 交班后登记换成新回合那一份(`trigger` 与 `startedAt` 都不是上一轮的) | `tests/platform/busy-latch-granularity.test.ts` |
| 分层是**最长路径**;重复边去重、自环不画、环上节点一个不丢且如实标出 | `tests/web/work-graph.test.ts` |
| 工件分三堆(挂着的 / 本来没环节的 / 挂到读不到环节上的),分堆是**划分**不是筛选 | 同上 |

**工件页的主视图:时间轴泳道(2026-10-06 同一轮改)**

用户对第一版产出图的判词是「现在都缠在一起了」,并给了形状:**横轴是时间、纵轴是工件的类型**。真机渲染图证实了原因,而且**不是手写 SVG 的锅**:

> 真机库(`~/.sansheng` 副本)里 `khu → kv0`(父子)与 `kv0 → khu`(`work_deps`)构成**真实的依赖环** ⇒ `workGraph` 的 Kahn 分层把**五条工作项全部**收进「排不出先后」那一列,五张卡片叠在同一列、边互相穿。**分层 DAG 对这份数据在结构上给不出可读的图。**

所以主视图换成 `web/src/lib/timeline.ts` 的纯函数布局:

| 维度 | 判据 |
|---|---|
| x | 时间(线性映射 + 自适应刻度步长;**x 是时间的函数,位置不需要解** ⇒ 不存在边交叉) |
| y | 泳道:上区**一条工作项一道**(条 = 创建 → 收口),下区**一种工件 kind 一道**(点 = 一件工件) |
| 工件 | **每一件都画**,含 `workId === null` 的决策 / 会议 / 变更 / 甲方问答(它们落在自己 kind 的那一道上) |
| 工作项的完成 | 条尾端点:终态 = 实心(**收口**),未终态 = 开口 + 右端 = 此刻。⚠️ **文案只敢说「最后一次变更」**:`works.updated_at` 会被 `markWorkReviewed` 也碰一次,它不是精确完成时刻 |
| 工件的产出 | 条上的**里程碑刻度**(该环节的工件在**它自己那一道**上打点)⇒「完成」与「产出」在同一行读得出来,而且不画任何边 |
| 在跑 | 复用 §2.13 的 `live`:`runtime: "unavailable"` ⇒ **一个呼吸点都不点亮** |

分层 DAG **降级成默认折叠的「依赖关系图」**(它答的是「谁在等谁」,时间轴答不了 —— 一个信息都没删)。验收判据:`tests/web/timeline.test.ts`(25,布局语义 + 计数 + 端点语义 + `unavailable` 不许点亮)· `tests/web/artifact-timeline.test.ts`(29,页面与图形钩子)· `tests/web/artifact-dag.test.ts`(22,**一字不改**仍绿,证明折叠没有删信息)。

**同一轮的另一处:界面用词只有一处来源。** 用户提的是「harness 页面 和 成员页面 的四个角色的命名统一一下,就不要有解释了」。查下来同一个角色有**三个名字**:harness 页 `transport/http.ts` 的私有表(`Worker(执行者)` —— 名字里塞了解释)、成员页 `agents.display_name`(播种自 `runtime/org.ts` 的 `ORG`)、前端兜底 `web/src/lib/vocab.ts` 的 `ROLE_LABEL`(`执行者` / `质检审查员`)。现在:角色中文名的唯一来源是 **`runtime/org.ts` 的 `ORG`**,harness 视图与播种共用它,前端兜底表逐项对齐,并由 `tests/web/role-names.test.ts` 做**跨边界对照**(角色名里出现括号 / 斜杠 / 空格即红 —— 那就是「解释」的机器表达)。

---

## 3. 能力模型(Capability)

### 3.1 闭合联合

```ts
export type Capability =
  // BC1 项目与工作
  | "project.open"        // 立项
  | "project.read"
  | "project.update"      // 改 name / goal / status(active|paused),非终态
  | "project.close"       // 终态 done|abandoned,不可逆
  | "work.create"         // 拆解
  | "work.update"
  | "work.assign"         // 改派(create 之后换人)
  | "work.read"
  | "work.list"
  // BC2 协作
  | "collab.ask"          // 向某角色提问(提问者进入 blocked)
  | "collab.answer"
  | "collab.read"         // 列出 / 读取提问与升级(否则拿到 askId 也无从发现)
  | "collab.convene"      // 发起对焦会议
  | "collab.meeting.read"
  | "collab.meeting.respond"   // 参会者表态:支持 / 反对 / 待定 + 说明
  | "collab.meeting.conclude"  // 主持人出纪要,会议落终态
  | "collab.escalate"     // 向上一层升级
  // BC3 工件
  | "blackboard.read"
  | "blackboard.write"
  // BC4 变更与阻塞
  | "change.propose"
  | "change.review"
  | "change.read"         // 列出 / 读取变更请求
  | "blocker.open"
  | "blocker.update"
  | "blocker.read"        // 列出 / 读取阻塞 —— 缺了它「未解决阻塞反馈给用户」无从落地
  // BC7 记忆
  | "memory.read"
  | "memory.write"
  // 面向甲方(受 scope 门控,见 §4.3)
  | "client.ask"
  | "client.message"
  // 执行
  | "code.read"           // 读代码
  | "code.write"          // 改代码
  | "code.exec"           // 跑命令
  | "work.report"         // 汇报进度
```

> **2026-10-03 补录**:上表在首版里漏了 8 条,全部属于同一类缺陷 —— **有动词却无法发现动词的输入**。最严重的两条是 `collab.meeting.respond` / `collab.meeting.conclude`:§5.4 描述了完整的会议流程并引用了这两个动词,但联合里没有定义,意味着**会议一旦发起就永远无法表态、无法收尾**。另外 `collab.read` 是修这一批时发现的同类问题:`collab.answer` 要 `askId`,但没有任何能力能**发现**待答的提问。

### 3.2 能力 → 工具的展开

一个 capability 展开成 1~N 个**工具**(工具是模型实际能调的东西,capability 是权限判定的东西)。

| Capability | 工具名 | 参数 | 返回 |
|---|---|---|---|
| `project.open` | `project_open` | name, client, goal | project 摘要 |
| `project.read` | `project_read` | projectId | 项目全貌(成员/工作/变更/阻塞计数) |
| `project.update` | `project_update` | projectId, name?, goal?, status? | 更新后摘要 |
| `project.close` | `project_close` | projectId, outcome: done\|abandoned, reason? | 终态确认 |
| `work.create` | `work_create` | projectId, title, goal, assignee{role, spec?}, dependsOn[], parentWorkId? | work id |
| `work.update` | `work_update` | workId, status?, progress?, note? | 更新后摘要 |
| `work.assign` | `work_assign` | workId, assignee{role, spec?}, reason? | 更新后摘要 |
| `work.list` | `work_list` | projectId, status?, assignee? | 列表 |
| `work.read` | `work_read` | workId | 详情 + 关联工件 |
| `collab.ask` | `ask_role` | target{role, spec?}, question, hypothesis, options[], needs | `{ askId, blockedUntil }` |
| `collab.answer` | `answer` | askId, body, decision? | 确认落库 |
| `collab.read` | `ask_list` / `ask_read` | projectId, status?, toMe? / askId | 提问与升级的列表 / 详情 |
| `collab.convene` | `convene` | projectId, topic, participants[{role, spec?}][], agenda | `{ meetingId }` |
| `collab.meeting.read` | `meeting_read` | meetingId | 纪要 + 参会者立场 |
| `collab.meeting.respond` | `meeting_respond` | meetingId, stance: 支持\|反对\|待定, comment | 确认落库 |
| `collab.meeting.conclude` | `meeting_conclude` | meetingId, summary, decisions[], actions[] | 会议落终态 + 纪要入黑板 |
| `collab.escalate` | `escalate` | reason, context, hypothesis, options[] | `{ escalationId, escalatedTo }` |
| `blackboard.read` | `board_list` / `board_read` | 见下 | |
| `blackboard.write` | `board_write` | projectId, kind, title, body, status?, links? | artifact id |
| `change.propose` | `change_propose` | projectId, title, rationale, impact[], affectedWorkIds[] | changeId |
| `change.review` | `change_review` | changeId, verdict, comment | |
| `change.read` | `change_list` / `change_read` | projectId, status? / changeId | 变更的列表 / 详情 |
| `blocker.open` | `blocker_open` | projectId, title, detail, blocksWorkIds[], severity | blockerId |
| `blocker.update` | `blocker_update` | blockerId, status, resolution? | |
| `blocker.read` | `blocker_list` / `blocker_read` | projectId, status?, severity? / blockerId | 阻塞的列表 / 详情 |
| `memory.read` | `memory_search` | query, limit? | 片段列表 |
| `memory.write` | `memory_remember` | kind, content, importance? | fragment id |
| `client.ask` | `ask_client` | question, options[], lean? | `{ questionId }`(挂起等待用户) |
| `client.message` | `tell_client` | text | 播报 |
| `code.read` | `read` / `grep` / `find` / `ls` | SDK 内置 | |
| `code.write` | `edit` / `write` | SDK 内置 | |
| `code.exec` | `bash` | SDK 内置 | |
| `work.report` | `report` | workId, status, summary, artifacts? | |

**33 条 capability 展开成 41 个工具。**

`work.assign` 与 `work.create` 共用同一套 `assignee{role, spec?}` 解析(见 §3.3)—— 改派和分派走同一条路径,避免「改派绕过了歧义检查」这种不一致。

**`board_list` / `board_read` 签名变更**(相对现状):

```
board_list(projectId, kind?, status?, author?, limit?)   ← 不再按 conversationId
board_read(artifactId)
```

这是本次升级最关键的一处签名破坏 —— 作用域从「对话」变成「项目」。

### 3.3 角色解析:工具收角色,存储存 agent

因为**角色就是那个「全局的人」**,工具参数用 `{role, spec?}` 表达最自然 —— agent 想的是「交给算法负责人」,不是「交给 `agent_7f3a`」。

但存储层的外键是 `agent_id`。所以中间有一次解析:

```
工具参数 assignee{role: "worker", spec: "algorithm"}
        ↓ Resolve(project, role, spec)
project_assignments 里该项目中符合 (role, spec) 的那个 agent
        ↓
works.assignee_agent_id = agent_xxx
```

**解析失败是必须显式处理的路径**,三种情形:

| 情形 | 行为 |
|---|---|
| 该项目里没有该角色的 agent | 结构化错误 + 列出本项目可用角色 |
| 该角色有多个 agent,且未给 `spec` | 歧义错误 + 列出候选(迫使模型明确) |
| 给了 `spec` 但没有匹配 | 错误 + 列出该角色下实际存在的 spec |

**不做隐式兜底**(比如「随便挑一个同角色的」)—— 那会让「交接给了谁」变成不可预测的事,与 7-L「落库路径唯一」的纪律相冲突。

### 3.4 与 SDK 内置工具的关系

`code.*` 三个能力直接映射到 Pi SDK 的 `read/grep/find/ls/edit/write/bash`,通过 `customTools` 与 `tools` allowlist 一起交给 `createAgentSession`,由 `isAllowedTool` 统一过滤。平台不重复实现它们。

`canvas_*` / `net_*` 这批沙箱工具在本次设计中**降级为内部实现**:canvas 是代码工作根的抽象,net 出口对所有角色**永久关闭**(7-E 已裁决,本设计维持)。

---

## 4. 作用域与授权(核心机制)

### 4.1 作用域定义

```ts
export type Scope =
  | { kind: "project";  projectId: string }
  | { kind: "role";     role: ProjectRole; specialization?: string }  // 全局角色
  | { kind: "client" }
```

### 4.2 授权求解

给定一个全局 `Agent` 与它当前所处的项目,其有效工具集。

**求解分两个阶段**,因为它们依赖的输入不同:

```
── 求解期(装配工具集时)────────────────────────────────────────
effective = Solve(agent, project, userToolSet)

  1. spec         = ROLE_SPECS[agent.role]          代码内,全局,不可变
  2. ceilingTools = Expand(spec.ceiling)            架构上界,展开成工具
  3. requested    = userToolSet.allow \ userToolSet.deny   (未给 → ceilingTools)
  4. inCeiling    = requested ∩ ceilingTools        越界项进 blockedByCeiling
  5. tools        = inCeiling ∩ ScopeGate(cap, agent, project)
                                                    越界项进 blockedByScope

── 调用期(模型真正发起调用时)──────────────────────────────────
  6. WriteKindGate(cap, params.kind, spec)          ← 第三维,见 §4.4
  7. 目标门(collab.ask / collab.escalate 的 target 须在本项目内)
```

**粒度是工具级,不是能力级。** 集合文件列的是工具名,而 `blackboard.read` 这类能力展开成多个工具(`board_list` + `board_read`)。若按能力粒度授权,用户只写 `allow: ["board_list"]`(只想让它看列表)就会连带拿到 `board_read`(按 id 读任意工件正文)—— **那是用户没要的权限**。所以有效工具面是工具的集合,能力集只是由它反推出来的**报告字段**。

**第 6/7 步必须在调用期**,因为 `kind` 与 `target` 都是**调用参数** —— 求解期根本不知道模型要写哪种 kind、要问谁。把它们塞进求解期会得到一个「假装校验过了」的假门。

**第 1 步用的是 `agent.role` 而不是「项目成员记录」。** 角色全局化之后,求解的输入是两个稳定量(全局角色、项目参与关系),中间没有可变数据能篡改角色属性。

**第三道门在调用期**:即便 `board_write` 这个工具已经在手,模型每次调用时仍要校验 `kind` 参数落在该角色的 `writeKinds` 内 —— 手里有工具 ≠ 什么都能写:

```ts
function WriteKindGate(cap: Capability, spec: RoleSpec, call: ToolCall): GateResult {
  if (cap !== "blackboard.write") return GRANT;
  const kind = call.params.kind;
  if (!spec.writeKinds.includes(kind)) {
    // 结构化错误 + 回灌合法 kind 列表 —— 沿用 8-F:工具协议段必须渲染参数清单,
    // 否则模型会传错参数名,而「传错」的表现形式往往是编造。
    return DENY(`角色 ${spec.role} 不能写 kind=${kind}`, { legalKinds: spec.writeKinds });
  }
  return GRANT;
}
```

### 4.3 ScopeGate —— 本设计的关键规则

```ts
function ScopeGate(cap: Capability, agent: Agent, project: Project): GateResult {
  const spec = ROLE_SPECS[agent.role];
  // 规则 1:client.* 是本角色固有的属性,与项目无关
  if (cap === "client.ask" || cap === "client.message") {
    return spec.clientFacing ? GRANT : DENY(`角色 ${spec.role} 不是客户接口`);
  }
  // 规则 2:通信目标必须是本项目的参与方
  if (cap === "collab.ask" || cap === "collab.escalate") {
    return isAssigned(project, targetAgentId) ? GRANT : DENY("目标不在本项目");
  }
  // 规则 3:项目内能力需要 active 项目
  return project.status === "active" ? GRANT : DENY("项目非 active");
}
```

**规则 1 就是「甲方只与业务经理交互」的机器表达。** 判定依据是 `ROLE_SPECS[agent.role].clientFacing` —— **代码内常量,全局,不可变**。即便用户往 `planner.json` 里手写 `"client.message"`,求解器也会在 scope 这一步拒掉,并把原因落到 `blockedByScope` 里对用户可见 —— 沿用 7-E/7-O 的 fail-closed + 可见性纪律。

比原设计更强的一点:因为 `clientFacing` 不再是运行时数据,它**不存在被数据篡改的路径**。原先「项目成员表里给项目经理加个 clientFacing」这种误配置,现在在结构上就不可能发生。

### 4.4 三重门控的诚实性

| 门 | 位置 | 失败表现 |
|---|---|---|
| ceiling 门 | 代码内常量 `ROLE_CAPABILITY_CEILING` | `blockedByCeiling` + `log.warn` + UI 琥珀划线 |
| scope 门 | 运行时按全局角色 + 项目参与关系求解 | `blockedByScope` + 理由对用户可见 |
| **writeKind 门** | 运行时按工具调用参数校验 | 结构化错误 + **回灌合法 kind 列表给模型** |

三道门都**只减不增**。集合文件永远突破不了任何一道。这是 7-E 裁决的延伸,不是推翻。

三道门各有分工,不是冗余:

- **ceiling** 管「这个角色原则上能不能做这类事」
- **scope** 管「在这个项目里、以这个身份,能不能对**这个人**做」
- **writeKind** 管「能写,但能写哪**几种记录**」

最窄的一例是质检审查员:它有 `blackboard.write`,但 `writeKinds` 只有 `["review_finding"]` —— **能发言,但不能污染其他记录**。

---

## 5. 通信模型

### 5.1 通信形态:纵向与横向并存

组织不是一棵严格的树。**同一层级之间必须能直接沟通** —— 项目经理与质检审查员对交付标准有分歧、两个 worker 的接口对不上,这些都不该先升级再传达。

| 形态 | 方向 | 语义 | 阻塞? | 载体 |
|---|---|---|---|---|
| `ask_role` → `answer` | **任意方向**(横向 / 向上 / 向下) | 点对点提问 | 提问者进 `blocked` | Conversation 工件 + Blocker |
| `escalate` | **严格向上**(系统计算) | 「我卡住了,需要上一级决定」 | 提问者进 `blocked` | Escalation 记录 + 上级的 `answer` |
| `convene` → 会议 | 多边 | 对焦会议 | 否 | Meeting + 各方立场工件 |
| `ask_client` / `tell_client` | 对甲方 | 仅业务经理 | 提问者进 `blocked` | Question 工件 + WS 推送 |

**横向与纵向的分工**:

- **`ask_role` 是通用的点对点通道**,目标只要在本项目内即可 —— 包括横向同僚。它解决「我需要一个信息/一个确认」。
- **`escalate` 专用于「需要上级拍板」**,目标由系统按组织图计算,模型不能指定。它解决「我无权决定,必须往上走」。

**两者不是替代关系。** 有了横向通道之后,`escalate` 反而更重要:因为「能横向问」很容易退化成「到处问一圈,谁也不拍板」,而 `escalate` 是唯一能把决定权交给有权者的动词。

### 5.2 保持工件通道,不退回阻塞 RPC

**明确不做**:不引入 `bus.ask(): Promise<string>` 这类阻塞 RPC。

理由是本项目已经付过一次学费:`MessageBus` 的阻塞问答应答模型(266 行,带 JSONL 持久化)在 `ask()` 唯一调用方是被删除的 `runner.ts` 之后,始终未接入生产;真正跑通 7-L 升级链的是**异步消息 + 状态机**。7-L 的核心纪律:

> 「用户回答与沟通员自答必须共用同一条落库路径,否则审计面上会出现『执行者拿到了一份没有 decision 工件的指令』,那种问题事后查不出来。」

**这条纪律就是新通信模型的设计原则:任何改变流程状态的通信,必须落成可审计的工件。** `MessageBus` 在本次升级中**整体删除**,它的 `snapshot/restore` 语义由工件表的查询承担。

### 5.3 `ask_role` 与 `escalate` 为什么必须分开

| | `ask_role` | `escalate` |
|---|---|---|
| 目标 | 模型**指定** `targetRole` | **系统计算**:按组织图向上一级 |
| 方向 | 横向 / 向上 / 向下均可 | 严格向上 |
| 语义 | 「我问你一个问题」 | 「我无权决定,请上一级拍板」 |
| 目标合法性 | 必须在本项目内 | 由平台决定,模型无法指定 |
| 授予 | 所有角色 | **除业务经理外的所有角色** |

**为什么要分开**:如果只靠 `ask_role` 表达一切,「需要上级拍板」就退化成「模型自己挑个合理的 targetRole」—— 那又是一条提示词约定,7-B/7-L 已经证明这类约定会失效。

`escalate` 的目标由平台按项目参与关系计算,模型**无法指定**。worker 调用 `escalate`,必定路由到项目经理;项目经理调用,必定路由到业务经理。**「不越级」因此是机制保证的,不是自觉。**

业务经理不持有 `escalate` —— 它上面没有人了,它的升级出口是 `client.ask`(向甲方)。

**允许横向之后,R1 仍然是唯一不可协商的一条**:横向沟通不改变「只有业务经理能见甲方」。同僚之间随便聊,但甲方那道门只有一个把手。

### 5.4 会议(多边对焦)

```
convene(projectId, topic, participants[{role, spec?}][], agenda)
  → 建 Meeting(status=convened)
  → 为每个参会方建一条「待表态」记录
  → 参会方在各自回合用 meeting_respond(meetingId, stance, comment)
        stance ∈ 支持 | 反对 | 待定        ← 反对必须写理由
  → 主持人用 meeting_conclude(meetingId, summary, decisions[], actions[])
  → Meeting(status=concluded),纪要作为 meeting_note 工件落到 Blackboard
```

对应能力:`collab.convene` → `collab.meeting.respond` → `collab.meeting.conclude`,读面是 `collab.meeting.read`。

**谁能 conclude**:只有**发起人**(持有 `collab.convene` 的角色,即业务经理与项目经理)。参会者能表态但不能替主持人收尾 —— 否则「会议结论」就没有责任人。

**会议是异步的**:不阻塞任何 agent 的当前回合。参会方在自己的下个回合被提示有未表态会议(平台注入),也可以用 `meeting_read` 主动查。

---

## 6. 工件模型

### 6.1 kind 闭合联合

```ts
export type ArtifactKind =
  // 协议类(沿用现状)
  | "decision"          // 决策 —— 任何改变流程状态的通信的落点
  | "note"              // 自由记录
  | "evidence"          // 执行产出
  | "hypothesis"        // 未证实的判断
  // 新增
  | "project_brief"     // 立项书(业务经理产出,项目根工件)
  | "work_brief"        // 工作项说明
  | "meeting_note"      // 会议纪要
  | "review_finding"    // 质检意见
  | "change_record"     // 变更记录(accepted 后)
  | "client_question"   // 向甲方提出的问题
  | "deliverable"       // 交付物(项目经理在根工作项上整合产出;§2.11.5)
```

### 6.2 工件的两种来源

| 来源 | 工件 | 谁能产生 |
|---|---|---|
| **协议工具自动创建** | `client_question`(`ask_client` 副产物) · `decision`(`answer` 副产物) · `meeting_note`(`meeting_conclude` 副产物) · `change_record`(`change_review` 判定 accepted 副产物) | 不经 `board_write`,由工具在建记录时一并落库 |
| **`board_write` 显式创建** | `project_brief` / `work_brief` / `evidence` / `hypothesis` / `review_finding` / `note` / `deliverable` | 受该角色 `writeKinds` 白名单约束 |

**为什么分开**:凡「工具本身的语义就是一条通信」的场景(提问、应答、开会收尾、变更裁定),记录必须与动作**原子地**落库 —— 这正是 7-L 的纪律「用户回答与沟通员自答共用同一条落库路径,否则执行者会拿到一份没有 decision 工件的指令」。让模型自己去 `board_write` 一条 decision 就多了一个失败点。

因此 `client_question` / `meeting_note` / `change_record` **不在任何角色的 `writeKinds` 里** —— 它们不是模型能写的东西,而是特定动词的必然产物。

**`decision` 是唯一的例外**,两边都可:`answer` / `escalate` 流程里由工具原子创建;业务经理或项目经理也可以独立 `board_write(kind="decision")` 记录一个不来自问答的决策。因此它同时出现在协议创建表与这两个角色的 `writeKinds` 里。

### 6.3 status 状态机

**不再使用** `waiting_for_decision` 作为通用等待态 —— 等待是一个**实体状态**(Blocker / Question),不是工件状态。这消除了 7-N 那次「未收敛只有一句 note、零现场」问题的结构性来源。

```
Artifact:  open → accepted | rejected | superseded
Work:      open → in_progress → blocked → in_progress
                    └→ done | failed | cancelled
Blocker:   open → acknowledged → resolved | deferred | rejected
Change:    proposed → under_review → accepted → implemented
                         └──────→ rejected
Meeting:   convened → in_progress → concluded
Project:   draft → active → paused → done | abandoned
```

### 6.4 与 7-D/7-M/7-N 的关系

「信封偏差」三次事故的根因是:模型的输出被**一个硬编码的解析点**消费,包装错了就被当失败丢掉。

新模型的应对不是加更多容错(那已经是 `unwrapOutcomeEnvelope` / `inferOutcome` 在做),而是**把产出从「解析模型输出」改成「调用工具」**:

> agent 不再交出一个 `{outcome: ...}` 让框架猜,而是**直接调 `board_write(kind, title, body)`**。
> 参数由 SDK 的 schema 校验,类型错了 SDK 直接报错并把 schema 回灌给模型 —— 不存在「包装摆错」这种失败模式。

这是本设计对 7-D/7-M/7-N 那族问题的**结构性解法**,而不是又一个容错补丁。

---

## 7. Harness 装配

### 7.1 三层结构

```
┌─────────────────────────────────────────────────────────────┐
│ L1  RoleSpec                  (代码内常量,可审计)          │
│     capability ceiling + writeKinds + 默认集合 + 提示词单元    │
│     架构上界。改它 = 一次显式代码评审。                        │
├─────────────────────────────────────────────────────────────┤
│ L2  ToolSetFile               (harness/tools/{role}.json)   │
│     用户可编辑的增减意图。永远突破不了 L1。                    │
│     读取在 `harness/toolSet.ts`;坏文件退化成出厂行为并如实报出, │
│     **不是**退化成空 allowlist(那等于悄悄收回全部权限)。       │
├─────────────────────────────────────────────────────────────┤
│ L3  ProjectAssignment + Scope (运行时数据)                    │
│     「当前在哪个项目、能对谁做」。L1/L2 管不了这一维。         │
└─────────────────────────────────────────────────────────────┘
         ↓ 求解(三重门控,见 §4)
   EffectiveToolSet(agent, project)  →  customTools + allowlist
```

L1/L2 沿用 7-E 的两层设计,已验证有效;**L3 与 writeKinds 是本次新增**。

`RoleSpec` 的形状(**以 `src/platform/identity/role.ts` 为准**):

```ts
interface RoleSpec {
  role: ProjectRole;
  clientFacing: boolean;                 // 仅业务经理为 true
  ceiling: readonly Capability[];        // 架构上界
  writeKinds: readonly ArtifactKind[];   // blackboard.write 的 kind 白名单
  promptUnits: readonly PromptUnitId[];  // 该角色装载哪些提示词单元
  boundaryDeny: readonly ToolName[];     // 仅供 UI 展示,**不参与授权判定**
}
```

> **没有 `factorySet` 字段。** 出厂集合由 `ceiling` 推导(`factoryToolset`)——
> 少一个真相源就少一处漂移(旧 `enabledTools` 字段就是这么烂掉的:它是一份独立名单,
> 于是可以声称有而实际没有)。

### 7.2 提示词单元

沿用 7-G 的 harness 版本链,每个角色一组提示词单元:

```
harness/system_prompts/{role}.{unit}.md
```

| unit | 作用 | 何时注入 |
|---|---|---|
| `{role}.core` | 角色定义与职责边界 | 总是 |
| `{role}.protocol` | 输出协议 / 工具调用规约 | 总是 |
| `collaboration.ask` | 提问规约(带 hypothesis 全文) | 有待答提问时 |
| `collaboration.meeting` | 会议参与规约 | 有未表态会议时 |
| `business_manager.align` | 与甲方对齐规约 | 仅 `client.ask` 持有者 |

**关键设计:提示词单元的内容由 capability 决定。** 一个角色拿到 `client.ask` 就该有 `business_manager.align` 单元;拿不到就不注入。**提示词与能力同源**,这是对 1.1 节那个病根的正面修复 —— 不再靠人工保持两者同步。

### 7.3 版本链纪律(7-J/5a/7-B 三次踩坑的固化)

```
出厂默认值变更 → 必须追加进 LEGACY_DEFAULTS / LEGACY_TOOL_SETS
否则存量用户文件被永久误判为「用户手笔」,新配置永远到不了用户
```

本设计**不豁免**这条。既然决定重置数据,仍保留版本链机制:它防的是「用户改过配置之后我们再发新版」这个长期问题,与是否重置数据无关。

### 7.4 写盘四规矩(7-O 沿用,不重新发明)

实现落点:`src/platform/harness/write.ts`(提示词单元写面)。

1. **id 必须来自闭合注册表**(`promptUnitIds()` / `PROJECT_ROLES` / `CAPABILITIES`),先查表再拼路径 —— 唯一挡路径穿越的地方
2. **备份是写的前置**,落 `harness/backups/prompts/<unitId>.<ts>.bak`(留最近 10 份),备份失败就不写
3. **报成功 = 真生效** —— 返回的是回读那份
4. **恢复出厂 ≠ 删文件** —— 删文件 = empty 态,写回出厂字节 = default 态,且必须显式 confirm

> L2 工具集合文件(`harness/tools/{role}.json`)复用第 1 条(文件名来自 `PROJECT_ROLES`
> 这个闭合注册表,见 `harness/toolSet.ts`);它**本批不提供写面** —— 用户直接编辑文件,
> 读取侧会如实报出它的状态与它收掉了什么。

---

## 8. 存储模型(重置后)

### 8.1 表清单

> **2026-10-03 修订(批次 3 落地时)**:原清单漏了两处多对多关系,已补。
> ① `blocker_open` 的签名带 `blocksWorkIds[]`,但 blockers 表既没有这个字段
> 也没有关联表 —— 传进来的 work id **无处可放**。② `change_requests` 的
> `affected_work_ids_json` 是不可查的 JSON 列。两者都改为关联表:JSON blob
> 无外键完整性、SQL 层问不出「哪些变更影响了 work X」,而旧
> `blackboards.artifacts_json` 正是这么烂掉的。

```sql
-- BC0 Identity(全局,不随项目变化)
agents(id PK, role, specialization, display_name, created_at)
  -- role ∈ business_manager | project_manager | worker | quality_reviewer
  -- 无 client_facing 列:那是 RoleSpec 的代码内属性,不入库

projects(id PK, name, client, goal, status, created_at, closed_at)

-- 关联表:只回答「这个项目里有谁」,不复制角色属性
project_assignments(project_id, agent_id, added_at, removed_at,
                    PRIMARY KEY(project_id, agent_id))

works(id PK, project_id, parent_work_id, title, goal, status,
      assignee_agent_id, created_at, updated_at)
work_deps(work_id, depends_on_work_id)

artifacts(id PK, project_id, conversation_id, kind, status, author_agent_id,
          title, body, metadata_json, created_at, updated_at,
          work_id NULL)                          -- ← migration 014(见 §2.6)
artifact_links(artifact_id, rel: parent|depends_on|answers, target_artifact_id)

asks(id PK, project_id, from_agent_id, to_agent_id, question, hypothesis,
     status, created_at, resolved_at, resolution_artifact_id)

meetings(id PK, project_id, topic, agenda_json, status, convening_agent_id,
         concluded_at, summary)
meeting_participants(meeting_id, agent_id, stance, comment, responded_at)

blockers(id PK, project_id, raised_by_agent_id, title, detail, severity, status,
         created_at, resolved_at, resolution)
blocker_blocks(blocker_id, work_id)               -- ← 修订补入
change_requests(id PK, project_id, title, rationale, impact_json, status,
                decided_by_agent_id, created_at, decided_at)
change_affects(change_id, work_id)                -- ← 修订补入(取代 affected_work_ids_json)

-- ⚠️ 表名**不能**叫 conversations / messages:001 已占用这两个名字,而
--    CREATE TABLE IF NOT EXISTS 撞名时静默无操作(见批次 5 报告)
project_sessions(id PK, project_id NULL, created_at)
--   ↑ project_id **可空**:那条 NULL 的会话就是**接待会话**(第一个项目之前,
--     全局唯一一条 —— 见 §9.3 与 migrations/012)。非空行不受影响:
--     「一个项目一条连续对话」仍是常态,表结构允许多条只是不为它加约束。
session_messages(id PK, session_id, agent_id, kind, content, created_at)

-- BC7 Memory:本设计只定契约,存储形态可替换(见 §8.3)
memory_fragments(id PK, kind, content, importance, decay_factor, access_count,
                 last_accessed_at, created_at, source_project_id)
memory_profile(id PK, payload_json, updated_at)
```

> **2026-10-04 顺手修正**:上面这三行原写作 `fragments` / `user_profile` / `agent_states` —— 那是**旧系统的表名**,已由 `migrations/011_drop_legacy.sql` DROP,现名是 `memory_fragments` / `memory_profile`(`migrations/010_memory.sql:29` 与 `:52`);`agent_states` 在新架构里没有对应物(角色是全局的人,没有运行态)。

> **2026-10-04 修正(批次 21 之后)**:上面那行原写作「`artifacts.work_id` 是草案,migration `014` 尚未落地」—— **它已经为假**:`migrations/014_artifact_work.sql` 已落地(可空列 + 部分索引 `idx_artifacts_work`),`board_write` 的 `workId` 参数与 `listArtifacts(projectId, { workId })` 都已接线,`runtime/execution.ts` 的产出采集也已改走这条边(§2.6 的「已落地」横幅就是同一件事);真机库的 `schema_version` 已到 **15**。清单里的这一行因此补上了 `work_id`。

> **`artifacts.conversation_id` 是一个恒空列,建议删。** 008 的注释写着「BC2 落地时补 `REFERENCES`」,而 BC2(009)落地时**没补**,理由也写下了:「工件必须比会话活得久」。于是它今天是:① 无外键;② **所有生产写入者的实参都是 `null`**(`tools/blackboard.ts:184` · `tools/collab.ts:177` 与 `:562` · `tools/client.ts:71` 与 `:182`);③ 没有任何读方按它过滤(§3.2 的签名变更把作用域从对话改成了项目)。这与 §8.2 点名批评的 `blackboards.goal` / `plan_json` / `todos_json` 是同一形态:**一个留着会被当成「还有用」的空列**。
> **实测**:它不在任何索引或 CHECK 里,`ALTER TABLE artifacts DROP COLUMN conversation_id` **成功**(SQLite 3.53.4)。所以删它是一条纯减法,但**它是一次真迁移**,且要先确认没有外部消费者 —— 列入未决(§12 #11)。

**外键一律指向 `agent_id`,不再存 `role` 字符串。** 这样角色的属性只有一处真相(BC0 的 `agents` 表 + 代码内 `ROLE_SPECS`),工件与工作的作者/负责人不会因为字符串拼错而出现「幽灵角色」。

### 8.2 彻底删除的东西

- `blackboards` 表(连同 `goal` / `plan_json` / `todos_json` / `produced_artifacts_json` 恒空列)
- `fragments_vec` 虚表与整条 embedding 写入链路(零读方,纯付费)
- `MessageBus` 及其 JSONL 持久化
- `shared/prompts/`(运行期零读取的 536 行)
- `AgentRunner`、以及全部零调用方的 repo 函数

### 8.3 记忆:先简单做,经端口预留第三方接入

**决策(2026-10-03)**:记忆系统本轮**做简单实现**,不做复杂设计,但**接口要预留好**,将来能接第三方记忆系统。

现状问题先修掉:`agentKernel` 对每条 fragment 发真实 embedding HTTP 调用写 `fragments_vec`,而唯一读向量分支的 `searchFragments()` **生产调用方为 0** —— 持续付费、零收益。**本次删除整条向量链路。**

本轮实现 = 现有 bigram 文本匹配(`search_fragments_by_text`),不做语义检索。

**预留的接口**:

```ts
/** BC7 Memory 的唯一对外契约。上层只依赖它,不依赖任何具体存储。 */
export interface MemoryPort {
  /** 写入一条记忆。返回记忆 id。 */
  remember(input: {
    content: string;
    kind: FragmentKind;          // fact | preference | project | context | summary
    importance?: number;
    sourceProjectId?: string;
  }): Promise<string>;

  /** 按文本检索。本轮实现走 bigram;将来可换成向量/第三方。 */
  recall(query: string, opts?: { limit?: number; kinds?: FragmentKind[] }): Promise<Fragment[]>;

  /** 可选:衰减维护。第三方实现若不支持,可声明 no-op。 */
  decay?(): Promise<void>;
}
```

**为什么是端口而不是直接调存储**:这样「换记忆后端」= 换一个 `MemoryPort` 实现,不动任何 agent 代码。第三方记忆系统(向量库 / 托管记忆服务 / 知识图谱)只要能包出这三个方法就能接入。

**本轮不做但接口已预留的三件事**:

| 预留项 | 为什么现在不做 |
|---|---|
| 向量/语义检索 | 现状是零读方纯付费;应先有读方再谈实现 |
| 记忆衰减的真实调度 | `decay?()` 是可选方法,本轮可 no-op |
| 跨项目的记忆合并与去重 | 等真实使用中暴露出重复问题再做 |

**一条纪律**(沿袭 AGENTS.md):`FragmentRow.kind` 是闭合联合,**不要扩展**。第三方接入时若需要新的记忆类型,应映射进现有五个 kind,而不是加第六个。

---

## 9. 运行时结构

### 9.1 单进程组件

```
HttpServer (Hono)
├── ArtifactRoutes        /api/projects, /api/works, /api/artifacts
├── CollaborationRoutes    /api/asks, /api/meetings, /api/blockers, /api/changes
├── HarnessRoutes          /api/harness/{roles,specs,tool-sets,prompts}
└── MemoryRoutes           /api/memory/fragments

WebSocket
├── 事件多播:sink 集合(7-ODR 的正确形态:连接增减不重新 subscribe)
└── 提问/播报:client.ask 的等待与 client.message 的投递

AgentRuntime
├── SessionRegistry        一个项目 N 个 agent 会话
├── ToolResolver           §4.2 的求解器
└── ToolLoop               多轮工具循环(收敛判据:连续 N 轮无工具调用)
```

### 9.2 一个项目的会话拓扑

```
                        ┌────────────────────┐
     client ───────────►│  业务经理          │
     (ask_client /      │  business_manager  │
      tell_client)      └─────────┬──────────┘
                                  │ ask_role / convene / escalate
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
      ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
      │  项目经理      │◄─►│  质检审查员    │◄─►│  Worker       │
      │ project_      │   │  quality_     │   │  (工程/算法/   │
      │ manager       │◄──┼───────────────┼──►│   数据,可多个)│
      └───────┬───────┘   └───────────────┘   └───────┬───────┘
              │ work_create                            │ work.execute
              │ (分派,向下)                            │ code.read/write/exec
              └────────────────┬───────────────────────┘
                               ▼
                    ┌─────────────────────┐
                    │  Worker(可多个)     │
                    │  code.*  ·  evidence│
                    └─────────────────────┘

  ◄─► = ask_role 横向通道(同级对等沟通,可自由使用)
```

**读法**:

1. **横向通道 `◄─►` 是存在的。** 项目经理、质检审查员、各 worker 之间可以互相 `ask_role` —— 对交付标准有分歧、接口对不上,直接聊,不必先升级再由上级转达。
2. **纵向只有 `escalate` 一条**,目标由平台计算,严格向上一级。
3. 三个非 worker 角色**(业务经理 / 项目经理 / 质检审查员)**都不持 `code.*`,只有 **Worker** 持。
4. **甲方那道门只有一个把手。** 横向沟通再自由,`client.*` 仍然只有业务经理有 —— 这是唯一不可协商的一条。

**一处实话**:这个组织图里没有画「项目经理向 worker 分派」的箭头细节 —— 分派是通过 `work.create(assignee)` 落成数据,不是一次通信。分派之后 worker 若有疑问,走的是横向 `ask_role` 回来。

### 9.3 第一个项目之前:接待会话

**§9.2 画的是一个项目内部的拓扑,它没有回答更前面的那个问题:项目还不存在时,甲方与谁说话?**

这是一个**设计的空白**,不是 UI 的疏忽。它的后果在接口面上很具体:每条用户消息都要 `projectId`(`handleUserMessage(projectId, content)`),`solveToolset` 的作用域门要求项目 `active`,而项目本身只能由 `project_open` 建 —— 于是「第一个项目」这件事在结构上无从发生。上一版前端的临时处置是摆一张 name / client / goal 表单,用户提交时撞上 `project_open` 的参数校验报「goal 不能为空」。**那等于让甲方替业务经理立项** —— 而业务经理是唯一 clientFacing 的角色(§4.3),在这条路上它没有位置。

所以这一段被正式建模,而不是给它开一个后门:

**1. 接待会话 = `project_id IS NULL` 的那条会话,全局唯一一条。**
数据的形状不加新表:同一条 `project_sessions`、同一张 `session_messages`,只是那一条没有项目。唯一性落在**部分唯一索引**上(见 migrations/012)。⚠️ 索引的表达式必须是非空值 —— 写成 `ON project_sessions(project_id) WHERE project_id IS NULL` 是**拦不住的**:UNIQUE 索引里 NULL 互不相等,而部分索引收录的每一行 `project_id` 都是 NULL,于是约束永不触发(实测:连插三条 NULL 会话全部成功)。索引建在 `(project_id IS NULL)` 上才真正约束「接待会话只能有一条」,且非空行不进这个索引 —— 「一个项目一条会话」不受影响。

**2. 接待模式的能力面是「不需要项目」的那几条,不是「除了项目之外的」。**
`project.open`(立项这件事本身就是接待模式的出口)、`memory.read` / `memory.write`(记忆关于**用户**,项目无关)。项目内能力(`work.*` / `blackboard.*` / `collab.*` / `change.*` / `blocker.*` / `project.read|update|close`)全部被 scope 门挡下。

**3. `client.ask` / `client.message` 在接待阶段不可用 —— 这是刻意的。**
`ask_client` 落的 `client_question` 是**工件**,而工件必须挂 `project_id`(§6)。所以接待阶段的澄清走**正常对话**:「一次只问一件事、带候选项、带你的倾向」这套纪律不变,变的是通道。它是 `business_manager.align` 里明写的规则 —— 那条规约原本只说「问题必须走 `ask_client`」,在接待阶段并不成立。

**4. 立项是业务经理的动作,不是甲方的动作。**
对齐谈拢之后由业务经理调 `project_open`。工具结果**结构化地带回新项目 id**(`ToolResult.data.projectId` → SDK `details` → `runTurn` 的 `openedProjectIds`),宿主据此收口:把接待会话的消息**迁进**新项目的会话、丢掉接待会话、广播 `project_opened` 让前端切过去。不走「解析工具返回的文本抠 id」—— 文案改一个字就会让那条路径静默失效。

**5. 前端没有「创建项目」表单。**
一个项目都没有时首屏就是接待对话;左栏的「+ 新建」等于「和业务经理谈一个新项目」。立项完成后前端自动切到那个项目,并在那里看见刚才谈过的全部内容(消息已迁入)。

**这条界线的意义**:甲方从第一句话起就只与业务经理打交道 —— 包括**第一个项目还不存在**的时候。§4.3 的「甲方那道门只有一个把手」因此没有例外段。

### 9.4 驱动者循环:谁被唤醒

§9.1–§9.3 描述了拓扑与接待阶段,但没有回答一个更基本的问题:**四个角色里,谁在什么时候真的跑一个回合?**

在此之前只有两个驱动者:宿主跑业务经理(用户消息触发)、CLI 跑 worker(手工命令)。于是 `project_manager` 与 `quality_reviewer` **从来没有被叫醒过** —— 立项之后组织停在那里,真机实测的形态是 `projects=1, works=0, artifacts=0`。**四个角色定义齐了,但它不是一个组织。**

判定与排空落在 `src/platform/runtime/dispatcher.ts`,形式是两句话:

> **判定**:`collectTodos(db, projectId, now)` —— 一次**纯查询**,全系统唯一一处「下一步该谁跑」。
> **排空**:`drainProject(deps)` —— 查到就跑到没有为止(有硬上界)。

| 角色 | 「可执行的待办」 | 判据来源 |
|---|---|---|
| `business_manager` | **有下游结果还没向甲方交代**(且过了**合并窗口**:攒够 N 条 / 最老的一条等到 T)**或**有立刻可播的(失败 / 高危阻塞) | `dispatch_events`(outbox)里未消费的行 |
| `project_manager` | 有人问它;有变更待评;**项目一个工作项都没有**(还没拆解);**有工作项被派给了非 worker**;**有工作项停在 `blocked` 而没有驱动者**(第 11 条规则 `resolve_blocked_work` —— 2026-10-06 补记,此前本表漏了它) | `pendingWork.ts` + `works` |
| `worker` | **分派给它、前置已满足、还没到终态**的工作项 | `pendingWork.ts` 的 `myOpenWorks` |
| `quality_reviewer` | 有人问它;有变更待评;**有做完但没审的产出** | `works.status='done' AND review_state='pending'` |

**「等待审查」是一个真状态,不是一条被硬编出来的假查询。** 它落在 `works.review_state`(`none | pending | done`,migration 013):

- 迁入 `done` → `pending`;迁出 `done` → `none`。维护点是 `works.status` 的**唯一写口**(`repo/works.ts` 的 `updateWorkStatus`),不是散在各调用方。
- 质检那个回合**成功结束之后**由平台置 `done`(失败/中断就不置 —— 下次排空重来,at-least-once)。
- 于是质检的待办就是**一条查询**,重启之后照样查得出来。批次 20 的形态(判据是级联观察到的内存事件,不持久、重启不补跑)随之消失。

**下游结果同理落进 outbox**(`dispatch_events`):工作项迁入 `done` / `failed` / `blocked`、或登记了新阻塞时写一行。业务经理的汇报待办 = 「这个项目还有没被交代的事件吗」。它因此**不会因为撞上排空上界而消失** —— 批次 20 真机跑出来过「工作项做完了而没有人向甲方汇报」。

**触发有两个入口,两者都不携带任何状态**:

1. **事件 nudge**:可能改变流水线状态的工具调用成功后(`project_open` / `work_create` / `work_update` / `ask_role` / `change_review` / `blocker_open` …),平台敲一下门铃。门铃只有一句含义 —— 「现在去查一下」。
2. **fixed-delay 定时器**:默认 **10 秒**(`--dispatch-interval` 可配),上一轮排空跑完再等 10 秒。它是**兜底**:重启恢复、nudge 漏掉的、以及外部直接改库的场合。

**接待会话里那次立项刻意不 nudge** —— 用户刚被切进新项目、还没看过目标就自动开工,是在他确认之前花他的 token。

判定与状态全在库里,所以宿主**不持有任何跨排空的状态**;「刚才发生了什么」不参与判定,那正是批次 20 六个补丁的同一个根因。

**一定会停**,三层:

1. **硬上界** `maxRounds`(默认 8,`--max-cascade-rounds` 可配)。到界**不静默停**:返回 `stopReason`,宿主广播 `cascade_stopped` + 落一条 `system` 会话消息。界面回到 `idle` 而用户以为「还在跑」或「已经做完了」,两种误解都会让他在错误的时刻做决定。
2. **尝试预算** `maxAttemptsPerTodo`(默认 3),记在 `dispatch_attempts` 的 `(project_id, todo_key)` 上。某条待办被叫醒若干次而目标一动不动 → 不再叫醒它,并**广播一次**(不静默)。待办消失时账本行被删掉,所以「同一件事再次出现」自动拿到新预算。

   ⚠️ 这与批次 20 的 `stallStore` + 项目状态签名的本质区别有两条,而正是那两条让它安全:
   - **它在库里**:重启后预算还算数(重启不会让预算重新开始)。
   - **它不需要状态指纹**:不存在「指纹漏了一类状态 → 把真实进展读成没有进展 → 整条链被掐死」这条失败路径(真机跑出来过:签名漏了 `meetings`,项目经理成功表态却被判无进展,那个项目最后 `works=0`)。计数的失效方向永远是「多跑一次」,不会是「误判停住」。

   顺带地,「卡住一条待办不拖停整条」不再需要专门的补丁:预算按待办逐条记账,到界只影响它自己。

3. **墙钟上界** `wallClockTimeoutMs`(`runtime/turn.ts` 的 `DEFAULT_WALL_CLOCK_TIMEOUT_MS` = **10 分钟**;`--turn-wall-clock-ms` 可配)。前两层管的是「**还要不要叫醒**」,这一层管的是「**已经叫醒的那一个回合还能跑多久**」—— 一个回合卡在某个工具上时,前两层都拦不住它:它占着该项目的 busy 闩,预算也不会变(目标没动过,账本记的是次数,不是时长)。真机现场是一个 worker 回合跑了 **16 分钟**还在 `curl` 文档。

   到点由平台调 `AgentSession.abort()` **真的打断**这个回合(`abortGraceMs` 默认 15 秒 —— 宽限到点就不再等一个不会收敛的 `prompt()`),然后**按超时处置**:

   | 打断时工作项的状态 | 平台怎么做 | 回报 |
   |---|---|---|
   | 还没终态、也没 blocked | **记 `failed`** | `marked_failed` |
   | 它自己已到终态(done / failed / cancelled) | 不覆盖它(那是它自己更权威的判定) | `left_terminal` |
   | 它自己登记了阻塞(blocked) | 不覆盖它(`blocked` 的语义是「已登记阻塞」,平台这里没有阻塞记录可指) | `left_blocked` |

   **为什么是 `failed` 而不是留在 `in_progress`**:留在 `in_progress` 是**静默死**。它不在任何 outbox 事件里(`updateWorkStatus` 只对 done / failed / blocked 写事件),所以业务经理永远不会向甲方交代「这条活没做完」;而它会作为 `execute_work` 待办被反复叫醒,直到尝试预算用尽 —— 每次叫醒再买一个完整的墙钟上界,然后它**再也不被叫醒**。`failed` 是终态里唯一诚实的落点:它不假装成功、不假装有人登记过阻塞、也不假装还活着;它经 `updateWorkStatus` 这个唯一写口写出 `work_failed` 事件 → 业务经理的汇报待办 → 甲方可见。要人(项目经理)介入才能继续,这是对的失效方向。

   ⚠️ **这个上界在 Wave 1 只做完了判定与打断,运行期吃不到它** —— 宿主没有把 `ServeOptions.turnWallClockMs` 接出去,于是「我调了上界」与「它根本没生效」在真机上长得一样。Wave 2 补上了那条线(CLI → `ServeOptions` → `runAgentTurn` / `runWorkInSession` 两条路都要接,**只接聊天那条等于没接**)。

**会不会打扰甲方:合并唤醒(判定侧的时机收窄)。**

「谁被唤醒」这件事还有第二个问题 —— 不是「该不该叫醒业务经理」,而是「**为一条事件就叫醒一次值不值**」。用户的原话:

> 我觉得现在**业务经理干的事情太多了** …… 业务经理就不需要再将项目实际执行的**细节进展**直接同步给用户,你看聊天记录里面的一长串,**真真甲方不关心这些**

写入侧已经收过一刀(`updateWorkStatus` 只对**根工作项**终态 / 里程碑 / `work_failed` / severity ∈ {high, critical} 的阻塞写 outbox)。**但真机复核发现那一刀在扁平结构下是空转的**:库的形状是 `9 work → 9 root → 0 中间`。扁平结构下**每条工作项终态都是「根终态」**,写入侧的判据条条命中,一条也没筛掉。

> ⚠️ **2026-10-05 复核(第三次,形状又变了 —— 所以判据要写成「不看形状也对」)。**
> 当天 `~/.sansheng/sansheng.db` 的形状先后是:①`9 work → 9 root`(上面那次实测的库)
> → ②`1 根 + 4 子`(2026-10-05 早些时候的复核,由 `runtime/dispatcher.ts:51-55` 记着)
> → ③**`0 work`(同一晚 W3-③ 实测:该库被清过,只剩 4 个 agent、1 条接待会话、8 条
> 会话消息、0 项目 / 0 工作项 / 0 工件)**。
> 判据:`SELECT COUNT(*) FROM works` 与 `SELECT COUNT(*) FROM works WHERE parent_work_id IS NOT NULL`。
> **教训**:「真机库是什么形状」这件事**没有稳定答案**(用户会重置、会重开),所以
> 任何判据都不许建立在「库是扁平的 / 库是树」之上 —— 这也是 `deliveryCollected` 那条
> 「没有后代时判 R 自己」的写法(§2.11.4 的③)成立的同一个理由。下面那段 2026-10-04
> 的归因修正**仍然有效**,它讲的是「不要从 grep 不到推出不存在」,与形状无关。

> ⚠️ **2026-10-04 修正:那条「为什么是扁平的」归因是错的(结论不变)。** 原文写「`grep -rn parentWorkId harness/` 是空的 —— **没有任何地方告诉项目经理要建树**」。**grep 的结果对,推出来的结论错**:作用域只扫了 `harness/`(提示词单元目录),而**运行期的任务提示词**里明明白白写着这句话 —— `decompose_project` 那个待办渲染出的正文里有一行「多件产出同属**一个交付物**时,用 `parentWorkId` 把它们挂到一条根工作项下面 —— 中间工作项的完成只对项目内部可见,整个交付物收口才向甲方交代一次」(`runtime/dispatcher.ts:517-518`)。
>
> 两件事因此要分开:①**事实**不变 —— 真机库确实是扁平的,合并唤醒那一刀确实必要;②**归因**要改 —— 不是「没人告诉它」,而是**告诉了但没做到**。而它所在的那条通道恰恰是这个文件自己认定为最强的那一条(同文件 `:536-540`:那段文字在 **user message** 里,「recency 比 system prompt 强」)。⇒ 要修的是**合规与激励**(拆解之后有没有东西**校验**树形),不是再加一层提示词。归因错了,下一次的修法也会错。
>
> **对 §2.11 的影响**:`integrate` 规则按「根工作项的子树」判定,所以它**必须同时容忍扁平库** —— 扁平时每个根就是它自己,子树判据退化成单条工作项判据,那条规则仍然成立。

所以第二刀落在**判定侧**,而且它收窄的是**时机**,不是**资格**:

| 条件 | 缺省 | 含义 |
|---|---|---|
| `reportBatchSize`(攒够 N 条) | **3** | 攒够 3 条未消费事件就叫醒一次 |
| `reportMaxDelayMs`(最老的一条等了 T) | **5 分钟** | 它是**延迟上界** —— 保证「事件永远等不到叫醒」不可能发生 |

两个都可配(`--report-batch-size` / `--report-max-delay-ms`)。

**默认值的依据**:N = 3 是因为真机库的规模就是 9 条工作项(⇒ 大约 3 次唤醒),攢 3 条把「3 次唤醒」压成 1 次;取 2 省得太少,取 5 会让只有 2~4 条工作项的小项目永远靠 T 兜底(那等于把攒批换成定时)。T = 5 分钟是因为它是延迟上界、不是省 token 的手段:排空兜底定时器是 10 秒,所以到点后最多再等一个 tick;而一次 agent 回合本身就是 2–3 分钟,取到分钟以下等于「每条都立刻叫醒」(合并根本不生效)。

⚠️ **该立刻说的不许被 debounce 掉**:`work_failed` 与 severity ∈ {high, critical} 的 `blocker_opened` **绕过合并窗口**,立刻叫醒 —— 它们影响时间表,甲方要能据此重新决策(§2.9 那张表)。判据在 `dispatcher.ts` 的 `isImmediateEvent`,与写入侧 `repo/dispatch.ts` 的 `worthInterrupting` 是**同一个判据的两道独立防线**(刻意不共用常量:一处判「值不值得记」,一处判「值不值得立刻叫醒」;两层不一致的表现是「多叫醒一次」,不是静默漏掉)。

**「判定侧收窄会让 `consumed_at` 撒谎」这条论证的适用边界**(Wave 1 提出,Wave 2 复核后修正):

- 那条论证**只在「不可打扰的事件仍然进库」时成立**。写入侧收紧之后它们大多根本不进库 ⇒ 库里剩下的每一行都值得交代,全量消费(`consumePendingDispatchEvents` 无差别标记全部未消费行)**不再是缺陷**。
- 合并唤醒与那条论证**不是同一件事**:它决定**什么时候叫醒**,不决定**哪一行算交代过**。攒着没到阈值的行**根本没被消费**(没有待办 → 没有回合 → 不消费),它们的 `consumed_at` 仍是 `NULL`;一旦叫醒,被消费的正好是 `renderDownstream` 在同一回合里逐行渲染给业务经理的那一批。
- ⇒ **结论:合并唤醒不因「合并」而让 `consumed_at` 撒谎。** 唯一残留的谎是一条**先于本次改动就存在**的竞态:业务经理回合**进行中**新落库的事件会被同一次全量消费扫进去,而它没进那一回合渲染的名单(窗口 = 一个 agent 回合的时长,改动前后一样宽)。要修得把消费从「全量」改成「按 seq 集合」,落在 `repo/dispatch.ts`,列入 §12。

**为什么项目上下文进回合消息,而不是系统提示。** 系统提示在会话建立时算一次,而一个项目的会话是**常驻**的;项目状态会在它活着的时候变(`project_update` 改目标、`project_close` 关项目、成员增减)。拼进系统提示等于把建立那一刻的快照当成永久事实,而且不会有任何东西提醒它过期。回合消息则每回合现算 —— 与待办注入同一条理由。注入的层次是:

```
我在哪(项目上下文) → 我手上有什么(待办清单) → 这回合干什么(任务)
```

接待会话(`project_id IS NULL`)没有项目可注入,那一段保持原样(不注入、也不拼一段空壳)。

**会话池的键是 `(上下文, agent)`**,不再只是上下文 —— 一个项目里四个角色各要一条自己的会话(工具面与提示词都不同),否则三个角色会抢同一条会话。

---

## 10. 迁移路线

### 10.1 测试策略(先定,因为它决定排序理由)

**旧测试随其模块一起删除,不改造、不保留。** 它们是旧契约的编码,移植到新架构只会把旧设计的假设带进来。

**但新模块必须配新测试** —— 这不是「保住旧的」,而是「新代码怎么知道没写错」。没有这一条,重构期间「有没有写坏」就没有答案。

两者合起来的意思是:**安全网不是继承来的,是每写一个模块现织的。**

### 10.2 为什么要并行建新,而不是原地重置

既然数据已弃、旧测试也不要了,原地重置看起来更省事。但有一条独立于测试的理由:

**过渡期始终要有一个能跑的产品。** 原地重置会让整套系统在数周内处于「编译不过 / 跑不起来」的状态,而每个阶段的验证只能等到全部完成 —— 一旦中途发现设计问题,你面对的是一个半成品,而不是一个可回滚的提交。

所以:新模块建在新目录,旧模块保持可用;每完成一个 BC,就把它对应的旧模块与旧测试一起删掉。最后一步是删除残留。

### 10.3 阶段(2026-10-04 按实际实施修正)

> **本节已按实际重写。** 原表的 §10.3 是在动手前写的,两处与事实不符,已在下方「与原表的偏差」中如实记下 —— 那两处偏差本身就是有价值的信息,不抹掉。

| # | 阶段 | 产出 | 旧系统动作 | 风险 | 状态 |
|---|---|---|---|---|---|
| **1** | **BC0 + BC5 求解器** | `RoleSpec` 常量 + 三重门控纯函数 | 不动 | **低** ← 纯逻辑,无 DB/无 LLM/无 HTTP | ✅ `fe3dd47` |
| 2 | Schema 落地 | 新表(新名字,与旧表并存);BC0 的 `agents` | 不动 | 低 | ✅ `f04e026` |
| 3 | BC1 ProjectManagement | `projects` / `project_assignments` / `works` + repo | 不动 | 低 | ✅ `f04e026` |
| 4 | BC3 + BC4 | `artifacts` / `blockers` / `change_requests` | 不动 | 中 | ✅ `7b3cf1d` |
| 4b | **工具层 + 派发器** | 21 个工具 + 四道调用期拦截 | 不动 | 中 | ✅ `7083618` |
| 5 | **BC5 接线** | `assembly` / `sdkAdapter` / `session` | 不动(平台侧新建) | **高 · 单独评审** | ✅ ADR-001 + `5bfe9ca` |
| 6 | BC2 Collaboration | `asks` / `meetings`,含 7-L 升级链迁移 | 不动 | 中高 | ✅ `5a78107` |
| 6b | BC7 Memory | `MemoryPort` + bigram 检索 | 不动 | 低 | ✅ `7b2bb75` |
| 6c | 甲方接口 + 待办注入面 | `ClientChannel` 端口 + `pendingWork` | 不动 | 中 | ✅ `1ed35eb` |
| 7 | BC6 Execution | 一个回合 + 跑工作项 + CLI 驱动 | 不动 | 中高 | ✅ `bf2283b` |
| 7b | 角色提示词单元 | 四角色 12 个单元(693 行) | 不动 | 中 | ✅ `4b7e1c6` |
| **12** | **传输层 + 宿主** | 平台侧 HTTP/WS + `ClientChannel` 真实实现 + 托管前端 | 不动 | **中高** | ⬜ 未做 |
| 13 | 前端改接 | 换父节点:会话 → 项目;补项目/工作项/待办三屏 | 不动 | 中 | ⬜ 未做 |
| 14 | 调度器 | 超时巡检 + 周期对焦 | 不动 | 中 | ⬜ 依赖 12 |
| **8** | **清场** | — | DROP 旧表;删旧模块与它们的测试 | **中高(原标"低")** | ⬜ 依赖 12–14 |

**阶段 1 故意选成纯逻辑**,因为它零依赖、可穷举测试,且是整个设计的支点(§4)。事后看这个排序是对的:后面每一步都站在一个已验证的授权模型上,返工为零。

**阶段 5 是枢轴** —— 这个预判也对,它确实需要单独 ADR,而且 ADR §4 定的三条验证在真机上抓到了两个单元测试抓不到的缺陷。

#### 与原表的偏差(如实记录)

**偏差一:阶段 8 不是低风险清场,它有硬前置。**

原表把清场标成「低」。实测:

```
平台侧 HTTP/WS 服务        0 个
旧系统 HTTP 路由           21 条
旧系统托管前端             src/server/http.ts:575  serveStatic(dist/web)
前端                       31 文件 8123 行,全部调旧系统
```

**今天删掉 `src/server`,整个应用就死了** —— 没有服务、没有界面。清场的前提是新系统能接管旧系统对用户提供的一切,而那需要先有传输层。

**偏差二:原表没有「传输层」这个阶段。**

它只在通用域(§2.1 的图)里画了一个 Transport 框,从未排进路线。但实测表明它是三件事的**公共前置**:

- 界面能用(现在平台只能命令行驱动)
- `client.*` 真正闭环(`ClientChannel` 当前只有日志实现,`ask_client` 的问题到不了用户)
- 调度器有地方待(平台无任何长驻进程,现在写调度器就是死代码)

**教训**:阶段表是按「领域模型怎么拆」排的,而漏掉了「用户怎么碰到它」。领域拆得再干净,没有传输层就是一个只有 CLI 的系统。**排期时要单独问一遍:这个阶段做完,用户能不能用上?**

**偏差三:实际做了 5 个表中没有的批次**(4b 工具层、6b 记忆、6c 甲方接口、7b 提示词、以及 CLI 入口)。它们不是计划外膨胀,而是阶段的前置或收尾 —— 但原表确实漏了。

**旧测试的删除时机**:每个阶段完成时,连同它替代掉的旧模块一起删。不提前删(留着看旧行为有参考价值),不滞后删(避免僵尸测试拖慢 CI)。**实际执行时全部推迟到了阶段 8** —— 因为阶段 5 的决策是「平台侧新建、旧系统一行不动」,于是旧模块在整个过程中保持可用,删它们自然集中到最后。

---

## 11. 与已删除的 ARCHITECTURE.md 的差异(历史对比)

> **这一节保留作历史对照。** `ARCHITECTURE.md` 已被删除(批次 18),它描述的
> 12 层实现在批次 15 清场时整体移除。保留此节是因为它记录了**这次升级改掉了
> 什么** —— 那对理解「为什么会有这份设计」仍然有用。

现有 12 层图是**实现结构**的描述,本设计是**目标结构**。关键分歧:

| 现有 | 本设计 | 理由 |
|---|---|---|
| 6 层 AgentKernel 承担 10 项职责 | 拆进 BC0~BC7 | 单类 2099 行,一个类做十件事 |
| 「组织」= 角色数组 + 硬编码调用链 | BC0 全局 Agent + 项目参与关系 | 角色是「全局的人」,不随项目变化 |
| `BlackboardScope = global \| conversation` | project 为第一等实体 | 对话活不过项目 |
| 提示词承载组织规则 | capability 授予 | 7-B/7-L 两次失效 |
| `MessageBus` | 工件通道 | 阻塞 RPC 已验证不适配 |
| executor 交 `{outcome}` 由框架解析 | 调 `board_write` | 消除信封偏差那族问题 |
| 向量检索 | 文本检索(经 `MemoryPort`) | 零读方,纯付费 |

---

## 12. 未决问题(2026-10-04 更新)

### 已决

**1. 一个用户能否同时持有多个 active 项目?** ✅ **已决**

- **允许**同时持有多个 active 项目(一个 Agent 可被多个 Project 引用)—— 保持不变
- **呈现方式:按项目分组**(2026-10-04 经 jev 校准,confidence 0.67 / margin 0.66)

  理由:`client_question` 工件本来就带 `project_id`,数据模型已经支持;而「项目是一等实体、对话活不过项目」正是本设计的第一性主张(§1),分组呈现与它同源 —— 让用户在某个项目的上下文里看这个项目的问题,而不是把所有项目的问题混成一条流。

  **对传输层的要求**(阶段 12):WS 消息携带 `projectId`;前端需要项目切换器或按项目分组的折叠列表。

  **一个不冲突的补充**:分组呈现**不排除**一个全局待答计数徽标 —— 它是聚合查询,不改变消息形状。分组解决「上下文不混淆」,计数解决「不漏答」,两者可以并存。

**2. worker 的 specialization 是枚举还是自由文本?** ✅ **已决:枚举** `engineering | algorithm | data`

  选枚举的理由与 §1.3 一致:枚举是**代码内常量**,自由文本是数据 —— 前者改需要代码评审,后者可以被任何有写权限的东西改。用户想加「前端」时改的是代码,这是**特性不是缺陷**。

**4. `works` 表的 `progress` 列用数字还是状态?** ✅ **已决:只用状态,不设 progress 列**

  状态机已有 `open | in_progress | blocked | done | failed | cancelled`。数字进度的收益(甲方汇报更直观)不足以抵消它的代价:数字一旦存在,就会被当成事实,而它往往是估算 —— 「70% 完成」是最容易骗人也是最容易自我欺骗的一种表述。需要叙述时用 `board_write(kind=note)`。

**5. 旧 `shared/prompts/` 的设计文档价值** ✅ **已决:已提取完毕,可删**

  2026-10-04 起草四角色 12 个提示词单元时,逐份读了 `~/.sansheng/harness/system_prompts/` 下的旧文件,把经得起新模型考验的判断迁移进来了:

  | 旧内容 | 迁到哪 |
  |---|---|
  | 8-E「不许口头交付」实机事故(conv_murrw192_wxbg) | `business_manager.protocol` |
  | 7-L「默认动作是答不是问」+ 四类升级判据 | `collaboration.ask` |
  | planner 的拆解归类表与三条硬规则 | `project_manager.core` / `.protocol` |
  | executor 的「事实来自工具,不是来自记忆」 | `worker.core` |

  **丢弃的是全部 JSON 输出协议** —— 旧提示词花大量篇幅描述 `{"outcome":...}` / `{"tool_call":...}` 信封,而 §11 已经把那套整个去掉了。留着只会教模型交一个不存在的信封。

  `shared/prompts/`(536 行)可以删。注意它与 `~/.sansheng/harness/system_prompts/`**不是同一份** —— 前者是仓库内的死副本(`loadPlannerPrompt` / `loadExecutorPrompt` 只有声明无调用方,代码注释自己写着「全项目无调用方」),后者是运行副本。删的是前者;后者的旧文件在阶段 8 与旧角色一起删。

### 仍未决

**3. 横向沟通的留痕密度?** `ask_role` 横向畅通,但同级之间聊了什么是否需要默认落库?留痕太密会淹没审计面,太疏则横向协调变成黑箱。(与设计 2 §11 第 5 条同题)

**6. 调度器的巡检策略**(2026-10-04 新增)。`listOverdueAsks` / `expireAsk` 已实现但无调用方。超时之后该做什么有几种选择:只surface 给知情方(当前注入文本的处置)、自动升级给上一级、还是标记为失效。7-L 的 fail-safe 原则(「判断轮缺席/超时/解析失败一律退回升级」)倾向于自动升级,但那会产生噪音。**前置依赖:阶段 12 的宿主进程** —— 没有长驻进程时这题连实验都做不了。

**7. `artifacts.work_id` 只表达「产出」吗?「关于」这条边怎么办?**(2026-10-04 新增,§2.6;**Wave 2 更新:前提被真机推翻**)。原题是「`work_id` 只表达产出,那 M:N 的『关于』边要不要建」。**真机第一跑就证明它不只表达产出**:质检把 `review_finding` 挂到被审的那条工作项上 —— 「关于」已经**在同一个列里**表达了,只是没有字段区分它。所以今天的状态是**一条边承载两个语义**,而 `runtime/execution.ts` 用「作者 + kind」两条判据把它们分开(见 §2.6 末)。

**仍然未定的那一半**没变,而且更清楚了:一份决策可能同时关乎三条工作项,一份质检意见天然覆盖多条 —— 那是 **M:N**,`work_id` 这个 N:1 的列表达不了。**建议不变:先看真实用量。** 但新增一条更该先做的:**给 `work_id` 加一个 `rel ∈ {produces, about}`**,让「产出 ∪ 关于」那个并集在 schema 上分开 —— 否则每个读产出的地方都要自己复刻那两条判据,漏一处就是静默把质检意见算成交付物。

**8. 人员移出项目时,他手上在办的工作项怎么办?**(2026-10-04 新增,§2.4.3)。`removeMember`(`repo/projects.ts:134`)与 `deleteWork`(`repo/works.ts:267`)**都零生产调用方**,所以这条规则今天触发不了 —— 它是**潜伏的**而不是活的。但两条已有的机制边界已经画出来了,值得先定规则再开路径:① 负责人**不存在或不是 worker** 时,`dispatcher.ts:210` 会把项目经理叫醒来处置(`fix_work_assignment`);② 负责人**仍存在、角色仍是 worker,但已不在本项目**时,**没有任何判据会命中** —— `myOpenWorks` 按花名册算(`dispatcher.ts:192`),被移出的人不在花名册里,于是那条工作项**静默停在原地**。**建议:先定「移出时其未终态工作项必须改派」为规则,再开 `removeMember` 的路径**;顺序反了会先制造出一批静默停住的工作项。

**9. `done → in_progress`(审查后退回重做)算不算合法迁移?**(2026-10-04 新增,§2.7;**前半已裁决并落地**)。**合法性那一半已经定了**:`WORK_TRANSITIONS`(`repo/works.ts:83`)把 `done → in_progress` 判为**允许**,理由三条写在 `repo/works.ts:98-116`(核心一条:收紧它会把模型推回「取消旧的 + 新建一份」那个真机事故路径),判定点在唯一写口 `updateWorkStatus`(`:547`)。**仍未决的是代价那一半**: `review_state` 被清成 `none` 而**已消费的 outbox 事件不撤回** —— 于是「已向甲方交代」与「其实还没做完」可以同时成立,`consumed_at` 这个字段开始撒谎。两条出路:(a) 判定为非法,退回重做走「新建一条工作项并 `supersedes` 旧的」;(b) 判定为合法,但要求退回时**写一条新的 outbox 事件**(让甲方知道先前那次交代作废)。(b) 更贴合真实工作流,但它要求 `dispatch_events.kind` 再加取值 —— 与 #10 是同一笔迁移。

**10. `cancelled` 要不要写 outbox 事件?**(2026-10-04 新增,§2.8;**✅ 已决并落地:migration 015**)。「要写」,而且已经落地:`repo/works.ts` 的写入侧会为 `cancelled` 判定事件,`migrations/015_dispatch_event_kinds.sql` 把 `dispatch_events.kind` 的闭集从 4 个取值放宽到含 `work_cancelled`(办法是**重建表** —— §2.6 实测过 `ADD CONSTRAINT` 只能收紧不能放宽,拿它放宽会得到一次**无错、约束一个字节都没变**的应用)。重建的静默失败面(隐式 DELETE 级联子表、索引随 `DROP TABLE` 消失、`sqlite_sequence` 回退)由 `INTENTIONAL_REBUILDS` 登记与 `tests/platform/migrations.test.ts` 的 015 一组钉住。**015 刻意不加 `work_reopened`**,理由逐条记在那个迁移文件里(核心一条:放进 CHECK 却没有写出方的取值 = 一句「本系统会发这种事件」的假话)。

**11. `artifacts.conversation_id` 删还是补?**(2026-10-04 新增,§8.1 修订)。它是 008 留的悬空列,BC2(009)落地时刻意没补外键。今天它**恒为 `null`**(五个生产写入点全部写 `null`)、无读方、不在任何索引或 CHECK 里 —— `ALTER TABLE artifacts DROP COLUMN conversation_id` **实测成功**(SQLite 3.53.4)。**建议:删。** 未定的只是顺序:它要与「真机库上跑一次迁移」一起做,而现有一份真机库(`~/.sansheng/sansheng.db`)在跑 —— 删列会让**旧版进程读新库时读不到这一列**,而 `rowToArtifact`(`repo/artifacts.ts:89`)是显式读列的。所以这条要么等一个明确的停机窗口,要么与 #10 那次重建合并成一次迁移。**不要**在没有停机窗口时单独发它。

**12. `consumePendingDispatchEvents` 是「全量」消费,那它会不会交代掉没有被渲染过的事件?**(2026-10-04 新增,§9.4;Wave 2 复核 `consumed_at` 那条论证时发现)。**会,但窗口很窄。** 消费的落点是 `drainProject` 里那一句无差别的 `WHERE project_id = ? AND consumed_at IS NULL`(`repo/dispatch.ts`),而 `renderDownstream` 渲染给业务经理的名单是**回合开始时**查出来的 —— 于是**业务经理回合进行中**新落库的事件会被同一次消费扫进去,却从没出现在它眼前。窗口 = 一个 agent 回合的时长(真机 2–3 分钟),改动前后一样宽:**合并唤醒不引入它,也修不了它**(合并唤醒收窄的是「什么时候叫醒」,不是「哪一行算交代过」)。

**建议:把消费从「全量」改成「按 seq 集合」** —— `collectTodos` 生成 `report_downstream` 待办时把那一批的 `seq` 放进 `todo.refs`,消费时 `WHERE seq IN (...)`。这样「被消费的」与「被渲染的」在定义上就是同一批。**为什么列在这里而不是顺手做掉**:`consumePendingDispatchEvents` 的签名与语义在 `repo/dispatch.ts`,而它正好是 015 那笔迁移的同一层;两处同时改会让「谁负责哪一半」说不清。**在它修掉之前,`consumed_at` 的诚实边界是**:「这一行在某次成功回合的快照里」(不是「业务经理见过这一行」)。

**13. 业务经理的 `thinking` 要不要落库?**(2026-10-04 新增,§2.10.4)。今天 `thinkBuf` 被 push 之后**没有任何读者**(`host/serve.ts:539` · `:1058`),`grep -rn 'kind: "thinking"' src/` = **0** —— 也就是说**推理只存在于流式的那几秒里,刷新即无**。而 `session_messages.kind` 的 CHECK **已经允许** `'thinking'`(`migrations/009:47`),所以这不是「能不能」的问题,是**要不要**:(a) **不落库** —— 推理是过程噪音,落库会让会话表体积与审计噪音一起上去;(b) **落库** —— 「甲方检查成员的对话」这件事才覆盖得到推理,而且 §2.10.3 那条吞字缺陷在历史里也留得下现场。**未定的只是 (a)/(b) 的取舍,而 (b) 有一个必须先算的账**:13 条消息的真机库里,落库之后同样的回合会多出多少行。

**14. `review_finding.status = 'rejected'` 要不要接一条「打回重做」的规则?**(2026-10-04 新增,§2.11.3)。它**可机械化**(`status` 是结构化列,不是正文),但今天**没有人读它**;而质检**改不动** `works.status`(`identity/role.ts:225-236` 没有 `work.update`)。结论里**已经有答案一半的是「怎么退回」** —— `done → in_progress` **已明确允许**(§2.7 的裁决 ①),所以一条规则**可以把 `rejected` 的工作项退回 `in_progress` 并要求改派**,不需要新机制。**仍未定的是两件事**:①这条规则该叫醒**谁**(质检自己改不动工作项状态,所以只能是项目经理);②退回一次就会撞上 §12 #9 的代价那一半(`consumed_at` 开始撒谎)。⇒ **先定 §12 #9 的代价那一半,再接这条规则**;顺序反了会先造出一条会撒谎的状态路径。

**15. `deliverable` 工件的 `workId` 是「产出」还是「关于」?**(2026-10-04 新增,§2.11.5)。它由**项目经理**写在**根工作项**上,而 `runtime/execution.ts:280-300` 的产出判据要求「作者 = 本回合的执行者」—— 项目经理不在执行者位置上,所以它会被判成「**关于**」。今天这**不出错**(产出采集只发生在 worker 的回合里),但它意味着「这条根工作项产出了什么」的答案里**没有交付物**。⇒ 与 **§12 #7「`artifacts.work_id` 只表达产出吗」** 是同一笔:要么给这一列加 `rel ∈ {produces, about}`,要么把 `deliverable` 加进 `ABOUT_ONLY_ARTIFACT_KINDS`(`execution.ts:163`)**并把这条判断写进那张表的注释**。**建议:先做 §12 #7,不要为 `deliverable` 单开一个例外。**
