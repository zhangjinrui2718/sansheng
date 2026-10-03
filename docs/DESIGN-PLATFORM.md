# 设计 1 · Sansheng 工程平台设计

**状态**:草案 · 2026-10-03
**取代**:`ARCHITECTURE.md`(v1.0,12 层模块图)—— 该图描述的是当前实现的结构,本文描述的是**目标结构**。两者差异见 §11。
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
```

### 6.2 工件的两种来源

| 来源 | 工件 | 谁能产生 |
|---|---|---|
| **协议工具自动创建** | `client_question`(`ask_client` 副产物) · `decision`(`answer` 副产物) · `meeting_note`(`meeting_conclude` 副产物) · `change_record`(`change_review` 判定 accepted 副产物) | 不经 `board_write`,由工具在建记录时一并落库 |
| **`board_write` 显式创建** | `project_brief` / `work_brief` / `evidence` / `hypothesis` / `review_finding` / `note` | 受该角色 `writeKinds` 白名单约束 |

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
├─────────────────────────────────────────────────────────────┤
│ L3  ProjectAssignment + Scope (运行时数据)                    │
│     「当前在哪个项目、能对谁做」。L1/L2 管不了这一维。         │
└─────────────────────────────────────────────────────────────┘
         ↓ 求解(三重门控,见 §4)
   EffectiveToolSet(agent, project)  →  customTools + allowlist
```

L1/L2 沿用 7-E 的两层设计,已验证有效;**L3 与 writeKinds 是本次新增**。

`RoleSpec` 的形状:

```ts
interface RoleSpec {
  role: ProjectRole;
  ceiling: readonly Capability[];        // 架构上界
  writeKinds: readonly ArtifactKind[];   // blackboard.write 的 kind 白名单
  factorySet: ToolSetFile;               // 出厂集合(L2 的初值)
  promptUnits: readonly PromptUnitId[];  // 该角色装载哪些提示词单元
  clientFacing: boolean;                 // 仅业务经理为 true
}
```

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

1. **id 必须来自闭合注册表**(`PROMPT_UNIT_IDS` / `CAPABILITIES` / `TOOL_ROLES`),先查表再拼路径 —— 唯一挡路径穿越的地方
2. **备份是写的前置**,落 `harness/backups/<facet>/<id>.<ts>.bak`(留最近 10 份),备份失败就不写
3. **报成功 = 真生效** —— 返回的是回读那份
4. **恢复出厂 ≠ 删文件** —— 删文件 = empty 态,写回出厂字节 = default 态,且必须显式 confirm

---

## 8. 存储模型(重置后)

### 8.1 表清单

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
          title, body, metadata_json, created_at, updated_at)
artifact_links(artifact_id, rel: parent|depends_on|answers, target_artifact_id)

asks(id PK, project_id, from_agent_id, to_agent_id, question, hypothesis,
     status, created_at, resolved_at, resolution_artifact_id)

meetings(id PK, project_id, topic, agenda_json, status, convening_agent_id,
         concluded_at, summary)
meeting_participants(meeting_id, agent_id, stance, comment, responded_at)

blockers(id PK, project_id, raised_by_agent_id, title, detail, severity, status,
         created_at, resolved_at, resolution)
change_requests(id PK, project_id, title, rationale, impact_json,
                affected_work_ids_json, status, decided_by_agent_id,
                created_at, decided_at)

conversations(id PK, project_id, created_at)      -- 对话作为项目的会话
messages(id PK, conversation_id, agent_id, kind, content, created_at)

-- BC7 Memory:本设计只定契约,存储形态可替换(见 §8.3)
fragments(id PK, kind, content, importance, decay_factor, access_count,
          last_accessed_at, created_at, source_project_id)
user_profile(id PK, payload_json, updated_at)
agent_states(agent_id PK, state_json, updated_at)
```

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

### 10.3 阶段

| # | 阶段 | 产出 | 旧系统动作 | 风险 |
|---|---|---|---|---|
| **1** | **BC0 + BC5 求解器** | `RoleSpec` 常量 + 三重门控纯函数 | 不动 | **低** ← 纯逻辑,无 DB/无 LLM/无 HTTP |
| 2 | Schema 落地 | 新表(新名字,与旧表并存);BC0 的 `agents` | 不动 | 低 |
| 3 | BC1 ProjectManagement | `projects` / `project_assignments` / `works` + repo | 不动 | 低 |
| 4 | BC3 + BC4 | `artifacts` / `blockers` / `change_requests` | 不动 | 中 |
| 5 | **BC5 接线** | 工具展开 + `createAgentSession({customTools})` | 动 `harness/tools.ts` | **高 · 单独评审** |
| 6 | BC2 Collaboration | `asks` / `meetings`,含 7-L 升级链迁移 | 删 `MessageBus` | 中高 |
| 7 | BC6 Execution | 工具循环接新工具集 | `board_write` 取代 outcome 硬编码解析 | 中高 |
| 8 | 清场 | — | DROP 旧表;删旧模块与它们的测试 | 低 |

**阶段 1 故意选成纯逻辑**,因为它零依赖、可穷举测试,且是整个设计的支点(§4)。把它先做扎实,后面每一步都站在一个已验证的授权模型上。

**阶段 5 是枢轴**,改动的是 7-E / 7-H / 7-O 三批已验证裁决的形状,必须单独出 ADR 评审。

**旧测试的删除时机**:每个阶段完成时,连同它替代掉的旧模块一起删。不提前删(留着看旧行为有参考价值),不滞后删(避免僵尸测试拖慢 CI)。

---

## 11. 与现有 ARCHITECTURE.md 的差异

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

## 12. 未决问题

1. **一个用户能否同时持有多个 active 项目?** 当前设计允许(一个 Agent 可被多个 Project 引用),但 `client.ask` 挂起时用户面对多个项目的问题如何呈现,未定。
2. **worker 的 specialization 是枚举还是自由文本?** 枚举更安全(`engineering|algorithm|data`),但用户想加「前端」就得改代码。
3. **横向沟通的留痕密度?** `ask_role` 横向畅通,但同级之间聊了什么是否需要默认落库?留痕太密会淹没审计面,太疏则横向协调变成黑箱。(与设计 2 §11 第 5 条同题)
4. **`works` 表的 `progress` 列用数字还是状态?** 状态机已能表达,数字进度对甲方汇报更直观,可能需要 `progress_note` 而非 `progress: number`。
5. **旧 `shared/prompts/` 的设计文档价值**:内容已浓缩进 `promptUnits.ts`,本设计定为删除。若认为其中有不可再生的设计依据,应在删除前提取进本文件。
