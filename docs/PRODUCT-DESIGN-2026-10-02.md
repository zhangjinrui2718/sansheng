# Sansheng 产品侧设计 · 六个面的重做方案

> 触发:用户反馈「产品侧太简单了」,并逐条点名 blackboard / agent 状态 / agent harness / 总线 / 工件 / harness tab。
> 日期:2026-10-02 · 基线 HEAD `702968f` · 481 passed / 1 skipped · typecheck 0 error。
> 性质:**设计文档,零代码改动**。实施范围由本文末尾的 P0/P1/P2 排期决定。
> 证据纪律:本文每条事实都带 `file:line`;涉及真实数据的部分标注了库内实测结果
> (`~/.sansheng/sansheng.db` / `~/.sansheng/pi/`,只读查询)。凡是没查证的推断,一律标为「假设」。

**修订记录(同日内)**
- **r1 · §2.1** —— 推翻了初稿「planner/executor 的 token 级过程 P2 前拿不到」的结论。
  核查发现 `completeSimple` 返回的是完整 `AssistantMessage`(含 thinking / usage / cost / stopReason),
  `ws.ts:220-224` 只是把它扔了。**相关工作从 P2 提前到 P1(编号 9/10)。**
- **r2 · §1 / §6** —— 用户决定 critic/memory/reflection **暂不实现**,
  界面改为**不列出**它们(而非标「未接线」);徽章体系相应从四档缩到三档。
- **r3 · §6.1** —— 用户确认 `enabledTools`/`redLines`/`budget` 属于 **harness 自身设计未完成**,
  不是 UI 欠债;补了「什么条件下问题才真正消失」的判据。

---

## 0. 一句话诊断

**产品不是「太简单」,是「展示的系统模型和真实系统对不上」。**

用户想要的东西,系统大部分**已经算出来了**,只是在出进程的边界上被丢掉;同时 UI 展示的角色表
**比真实系统多了一倍**,多出来的一半永远亮不起来。三个具体错位:

| # | 错位 | 证据 |
|---|---|---|
| 1 | **角色表在撒谎** —— 展示 6 个 agent,系统只跑 4 个 | `critic`/`memory`/`reflection` 无 class 实现、无 prompt 消费者(grep `class Critic` 无结果;`loadHarness(...).systemPrompts[role]` 的消费方只有 communicator/planner/executor 三处,见 `agentKernel.ts:940`、`orchestrator.ts:186`、`orchestrator.ts:188`) |
| 2 | **真数据在出进程时被丢弃** —— 「每个 agent 在执行什么」不是难,是根本没往外发 | `Orchestrator` 持有 `activeExecutors`/`waiting`/`depthByTodo`(`orchestrator.ts:157-162`)但全是 `private` 无 getter;`ws.ts:358-373` 把 9 个 `ProgressEvent` 里的 **7 个**丢进 `default: break`;`GET /api/agents/:id` 硬编码返回 `{agents: []}`(`http.ts:243-246`) |
| 3 | **工件被当成日志渲染** —— 模型是对的,呈现把它拉回成了流水账 | artifact 有 10 kind / author / status 生命周期 / refs / metadata(`shared/types/blackboard.ts:21-44,144-166`),但 `Artifacts.tsx:149-155` 纯按 `createdAt` 倒序平铺 |

所以这次不是「往页面上加东西」,是**把产品重新挂在 agent 身份上,并如实标注每个面的真假**。

---

## 1. 主脊:一切以 agent 为键

贯穿六个面的唯一结构决策:**agent 身份是主脊,其它都是它的视图。**

用户最后那句「harness tab 最好和 agent 的 harness 关联起来」不是特例,就是这条主脊的直接推论 ——
Harness 页不是全局报表,而是**每个 agent 的雇员手册**;Agent 页不是状态表,而是**每个 agent 的工作台**。
两者共享同一个「当前聚焦的 agent」状态(`focusedAgent`),在 A 页选 executor,B 页就展示 executor 的手册。

> 取舍:也可以把两个页合成一个带子 tab 的页面。本方案推荐**共享选中态**(改动小、可逆、不动路由),
> 合成页留到 P2 再评估。

### 1.1 术语规则(集成期定,六个面统一遵守)

P0 四个子任务并行实施后出现了称呼不统一,集成时按**一条规则**收口,而不是逐页拍脑袋:

| 场景 | 用什么 | 例 |
|---|---|---|
| 角色作为**配置键 / 文件名 / 代码标识** | 英文 id | `planner` / `executor.md` / `PLANNER_EXECUTOR_MAX_TOKENS` |
| 角色作为**叙事主语**(谁产出、哪条通道、谁来决定) | 中文读法 | 沟通员 / 规划员 / 执行员 |

理由:英文 id 出现在 `file:line` 依据、harness 文件名、配置键旁边时,和它们**指同一件东西**,
译成中文会打断这条对应关系;而「这条工件是谁产出的」是叙事,中文更可读。
`Artifacts.tsx` 的 `AUTHOR_LABEL` 与 `Timeline.tsx` 的通道名属于后者,
`Harness.tsx` / `Agents.tsx` 里跟文件/配置并排出现的角色 id 属于前者 —— **不是例外,是规则的应用**。

未知角色值一律**原样透出**(`AUTHOR_LABEL[a.author] ?? a.author`),不吞、不猜。

`AUTHOR_LABEL` 保留 critic/memory/reflection 的中文读法是**有意的**:
它是「任意 author 值的翻译表」而非「角色名册」,若历史数据或沉淀服务产出过这些 author,
原样显示 `critic` 反而是信息丢失。这与 §1「界面不列出这三个 agent」不冲突 ——
一个是**名册**(不列),一个是**翻译表**(列全)。

角色清单必须**按真实实现**呈现(不是按类型联合):

| agent | 实现 | 运行时入口 | harness 提示词去向 |
|---|---|---|---|
| communicator | ✅ `Communicator`(`communicator.ts:574`) | `agentKernel` 每次用户消息 | `agentKernel.ts:940`(每次建 session 重读) |
| planner | ✅ `Planner`(`planner.ts:165`) | `Orchestrator.spawnPlanner`(`orchestrator.ts:592`) | `orchestrator.ts:186`(**构造时读一次**,下次 plan 生效) |
| executor | ✅ `Executor`(`executor.ts:108`) | `Orchestrator.spawnExecutor`(`orchestrator.ts:722`) | `orchestrator.ts:188`(同上) |
| harness_manager | ✅ `HarnessManager`(`harnessManager.ts:145`) | 订阅 `artifact_created` | ❌ **无文件**,用编译进代码的 `FALLBACK_HARNESS_PROMPT`(`harnessManager.ts:127`) |
| critic | ❌ **无实现** | — | `critic.md` 240 字节,**无任何代码读取** |
| memory | ❌ **无实现** | — | `memory.md` 191 字节,**无任何代码读取** |
| reflection | ❌ **无实现** | — | `reflection.md` 217 字节,**无任何代码读取** |

后三个**不进 agent 列表**(2026-10-02 用户决定:**暂不实现**)。
展示策略随之调整:不是标成「未接线」灰行,而是**根本不出现在 agent 列表和 harness 手册里** ——
三行永远点不亮的灰行是噪声,不如不列。

> 代码层面它们仍留在 `RoleKind`(`shared/types/agents.ts:97`)和 `ArtifactAuthor`
> (`shared/types/blackboard.ts:75-83`)里作为字符串。**是否从类型联合里删掉是另一件事** ——
> 会动共享类型和 481 个测试的基线,收益仅是消除几个没人用的成员,不划算,建议**保留不动**。
> 只需保证 UI 与 Harness 的提示词清单**不再枚举它们**。

---

## 2. Agent 状态:三层结构(此刻 / 概要 / 过程)

用户要的三级非常准确,直接落成三层下钻,而不是把三种信息挤进一张表。

### Layer 1 · 此刻 —— 一行能扫完

每个 agent 一行,常驻:

- **状态点**:运行中 / 空闲 / 阻塞中 / 未接线(灰,不可点)
- **正在处理什么**:一个**有名字的对象** —— todo 标题、artifact 标题、或用户消息摘要。
  这是「在执行什么」的核心,必须是名词短语而不是「处理中」。
- **计时**:从 run 开始 / `WaitingEntry.startedAt`(`orchestrator.ts:126-132`)算起
- **阻塞标记**:阻塞了多久 + 在等谁(等用户拍板 / 等 harness 决策)

**数据来源(诚实分层)**:

| 能力 | 现状 | 成本 |
|---|---|---|
| communicator 的此刻状态 | ✅ 已有 —— `communicator_thinking` 事件(`agentKernel.ts:1163-1168`)正在用 | 0 |
| planner/executor 的此刻任务 | ⚠️ **被丢弃** —— `todo_started` 事件存在(`orchestrator.ts:59`)但 `ws.ts:370` 丢弃 | P1 补发即可 |
| 阻塞计时 | ⚠️ **不可见** —— `waiting` map 是 private,无 getter、无 HTTP、无事件 | P1 加快照 getter |
| 未接线角色 | ✅ 编译期即可确定 | 0 |

### Layer 2 · 概要 —— 这一轮的来龙去脉

形状**已经存在**:`AgentRunSummary`(`shared/types/agents.ts:166-175`,含 role/sessionId/startedAt/endedAt/status/inputPreview/outputPreview/usage)。
配套的 `AgentRunner.toSummary()`(`runner.ts:163-180`)也写好了 —— 但 `new AgentRunner` 在生产代码里
**零调用方**,`AgentRunner` 整类是死代码(已被 `AgentKernel` + `Communicator` 取代)。

> 决策:**复用 `AgentRunSummary` 这个契约,不复用 `AgentRunner` 这个类。** 契约是对的,类是被淘汰的实现。

**P0 就能拿到 v1 概要,零后端改动**:每个 todo artifact 本身就是一次 executor 运行 ——
`title` = input preview,产出的 `evidence`/`hypothesis`/`note` = output preview,
`status` = outcome,`createdAt→updatedAt` = 时长。planner 同理(intent → 它产出的 todos 集合)。
用 `/api/artifacts` 就能拼出概要页,P1 再换成真 `AgentRunSummary`。

### Layer 3 · 过程 —— 逐步的轨迹

这层是「具体的执行过程」,也是当前**最空**的一层。目标粒度就是现成的 `ProgressEvent`
九元组(`orchestrator.ts:56-65`),它本来就是对的:

```
intent_received → todos_planned → todo_started ⇄ callback_routed
    → [decision_received | callback_escalated] → todo_resolved | todo_failed → completed
```

对应到人话:

- **planner**:收到意图 → 产出 N 个 todo(带依赖边)→ 结束
- **executor**:领取 todo → 执行 → 产出 evidence / 升级为 hypothesis 阻塞 / 失败
- **communicator**:用户消息 → decide(chat/task/**clarify**/feedback,`shared/types/agents.ts:140-144`)→ 确认 / 澄清提问 / 委派

**必须如实说明的缺口 → 见 §2.1(2026-10-02 修订:本节原写「planner/executor 拿不到 token 级过程」,
经核查**该结论错误**,数据一直在内存里,只是被丢弃)。**

communicator 例外:`messages.tool_calls` / `messages.thinking` 里**已经有**真实工具与思考轨迹,从没被展示过;
Pi 自己还落了一份更全的 session log(见 §2.1)。

### 2.1 修订:planner/executor 的过程数据**一直都在**,只是被扔掉了

> 2026-10-02 修订。原文写「它们的 LLM 调用走 `completeSimple` 返回纯文本,**从不写库** → Layer 3 拿不到」。
> **前半句对、后半句错** —— 它返回的不是「纯文本」,而是一个完整的 `AssistantMessage`。

`makeLlmCall`(`ws.ts:179-226`)拿到的 `completeSimple` 返回值
(`node_modules/@earendil-works/pi-ai/dist/types.d.ts:353-373` 的 `AssistantMessage`)是:

| 字段 | 内容 | 现状 |
|---|---|---|
| `content: (TextContent \| ThinkingContent \| ToolCall)[]` | 含 **thinking 块** | ❌ `ws.ts:220-224` 只 `if (c.type === "text")` 收文本,**thinking 直接丢弃** |
| `usage: Usage` | input / output / cacheRead / cacheWrite / totalTokens | ❌ 整个丢弃 |
| `usage.cost` | **真实美元成本**(分 input/output/cache 计价) | ❌ 整个丢弃 |
| `stopReason` / `rawStopReason` | 截断信号(批次 7-A 刚为此加过逻辑) | ⚠️ 用来判截断,但**没被记下来** |
| `responseId` / `model` / `provider` / `diagnostics` | 可追溯性 | ❌ 整个丢弃 |

**结论:planner/executor 的 Layer 3 不必等 P2,它是一次「把已经在手里的东西写下去」的改动。**

- **成本不在于技术难度**:调用点记一行 + 一张表(006)+ 约 20 行代码。
- 建议表 `agent_run_traces`(migration 006,006 是当前下一个空号),字段:
  `conversation_id, role, subject_id(intent/todo), user_prompt, response_text, response_thinking,
   stop_reason, usage_json, cost_usd, duration_ms, created_at`。
  这一张表同时喂 §2 的 Layer 2(概要)和 Layer 3(过程),**并让 §7 P1 第 9 项
  (复活 `AgentRunSummary`)真正有数据可填** —— 现在那一项只能靠 artifact 反推。
- 「让 planner/executor 走 Pi 的 session 层」是**另一个更大更重的选项,不推荐**:
  它会顺带给这两个 agent 装上工具能力,而 executor 的提示词明确建立在「没有工具能力」之上
  (`~/.sansheng/harness/system_prompts/executor.md`「没有工具能力时:用你掌握的领域知识…」),
  那是**行为变更**,不是日志变更。

**另:communicator 的全量轨迹其实已经在盘上。** Pi 把 session 落成
`~/.sansheng/pi/sessions/<cwd-slug>/<timestamp>_<uuid>.jsonl`(实测 48K / 14 行),
含 `session` / `model_change` / `thinking_level_change` / `message`(assistant 消息的 content 块实测为
`thinking+text+toolCall+toolCall`,外加逐条 `usage` 与**真实 cost**)、`toolResult`(带 `isError` / `details`)。
**它是 `messages` 表的超集。** v1 不必去读它(`messages` 够 communicator 用),但它是「原始现场」的
权威副本 —— `npm run diagnose` 那类排查应该指向它,而不是只有 `artifacts_json`。

---

## 3. Blackboard:从卡片列表到工作面

现状(`Agents.tsx:136-157`):intent 卡片 + `todo n/m done` 一行进度。

**全系统最被浪费的数据就在这张卡片下面**:每个 todo artifact 都带
`dependsOn` / `parentIntent` / `executors` / `status`(`shared/types/blackboard.ts:156-160`),
**UI 里一个字段都没用**。而一次计划本来就是一个 DAG,现在被画成了列表。

### 四区布局

**① 意图头** —— 目标、状态、提出者(communicator)、已耗时、一行健康度。
> 实测问题:`conv_muqsidb0_wgru` 的 6 个 todo + 2 个 evidence **全部 `failed`**,而当前 UI 只显示
> 「todo 0/6 done」,**失败原因完全不可见**。这是真实的产品缺陷,不是假设。失败原因在
> `ws.ts:360-365` 发的 `error{code:"todo_failed"}` 和 artifact 的 `metadata.errorReason` 里,
> 现在都只进了 `error` 字段,没进 blackboard。

**② DAG 区** —— todo 作为节点,`dependsOn` 作为依赖边。节点显示:标题、状态色、承接的 executor、
以及它产出的结果工件(evidence / hypothesis / failure)直接挂在节点下。

- 用**缩进/树状布局**,不用画布图。6–20 个 todo 的规模,树状可读性足够,画布的成本不划算
  (这是判断,不是数据结论)。
- `waiting_for_decision` 的节点要**最醒目** —— 这是整个系统最有信息量的状态
  (executor 卡住等人拍板),现在完全不可见。

**③ 阻塞队列** —— 独立一条泳道,放所有 `waiting` 的 todo,显示已等待时长。
后台的升级阈值是 **5 分钟升级 / 1 小时判失败**(`orchestrator.ts:207-208`),
这是一个真实 SLO,用户应该能对着它看,而不是只在日志里。

**④ 沉淀区** —— 本轮跑完后活下来的 decision / note / reflection,即「事后」的状态。

---

## 4. 工件:把它定义清楚(用户的直觉是对的)

用户问「工件里面是不是要展示所有的对话内容,而不是经过挑选后、定义后的工件」——
**数据模型早就是后者了,只有 UI 把它渲染成了前者。**

artifact 的 10 个 kind(`shared/types/blackboard.ts:21-31`)不是聊天记录,是**受控词汇表**:
每个都有 author(谁产出的)、status(生命周期状态机)、refs/dependsOn(关系)、metadata(结构化字段)。
这正是「agent 之间互相沟通」和「agent 和沟通员沟通」的载体。

> 所以这一面的设计原则是:**不改数据,改呈现和分组的语义。**

### 改法

**① 不再按时间倒序平铺,改按「沟通职能」分组** —— 因为这就是模型的用途:

| 分组 | kind | 语义 |
|---|---|---|
| 待决 | `hypothesis`(status=`waiting_for_decision`) | 卡住等人拍板的工作 |
| 决策 | `decision` | 已定、具约束力 |
| 证据 | `evidence` | executor 的产出 |
| 批驳 | `critique` | 评审结论 |
| 沉淀 | `note` / `reflection` | 长期记忆 |
| (移走) | `harness_proposal` / `implementation_preview` | 属 Harness 页,不属于这里 |

> **实施补充(P0-B,commit `ee80ca0`)**:上表只列了 5 组,实施时发现 `intent` / `todo` **必须单列一组**。
> 实测那批工件里 6 个 todo + 2 个 evidence 是真实数据,旧页面也一直在显示它们 ——
> 不给它们建组等于**把真实数据静默藏起来**,违反反造假。故增设「意图与待办」组
> (kinds = `intent` + `todo`),组描述里注明这是 §4 表未列、为不藏数据而增设。
> 另保留一个兜底「其它」组:将来 `ARTIFACT_KINDS` 加新成员时不会被静默丢弃,
> 标题里写明它是兜底而非正常分组。
> 移走的两类 `harness_proposal` / `implementation_preview` 在**所有 filter 之前**剔除,
> 保证它们进不了任何分组、也进不了兜底组;真拉到了(scope 默认 conversation,通常不会)
> 就在页首如实说明「另有 N 个在 Harness 页」。

**② 展示每个工件的生命周期** —— 工件是一条**带着状态机的消息**,不是一行文本:
`open → in_progress → waiting_for_decision → resolved / superseded / failed`
(`shared/types/blackboard.ts:54-58`)。页面应该读起来像「agent 之间一组开着口的对话,每条写着现在轮到谁」。

**③ 加「待转述」视图** —— 这是直接服务「也能让 agent 和沟通员沟通」的那块:
筛出沟通员**应当转达给用户**的工件(executor 产出的 hypothesis/decision,或 status=`waiting_for_decision`),
把它变成沟通员的**待发件箱**。现在这个角色分工在 UI 上完全不存在。

**④ 页首一行教学文案** —— 明确写「工件 = 挑选后的结构化产出;聊天记录在「对话」页」。
成本一行字,直接消除「我为什么在这里找不到聊天记录」的困惑。

> 实测:`conv_muqtyu3w_d3an` 里有 2 个 communicator 产的 `hypothesis` 永远停在 `open`。
> 正是这个视图该把它们顶到眼前的东西。

---

## 5. 总线:它是什么、该显示什么

**总线的定位**(先定义,再设计):总线是 **agent 之间的实时通道**,承载**提问 / 广播 / 回复**
(`shared/types/agents.ts:103`),而**不是**工件的搬运工。区别是:

- **总线消息** = 瞬时、对话式、可能无解(`question` 会一直挂着等人回答)
- **工件** = 持久、有状态机、是结论

现状(`Timeline.tsx`):把 `BusMessage` 按 `ts` 排成行转储,除了方向图标和 kind 徽章之外没有结构。

### 该显示什么

**① 线程化,不是行平铺** —— `question` 和它的 `reply` **共用 `questionId`**
(`shared/types/agents.ts:114-115`),现在被当成两条无关的行。把它们折成一条线程。

**② 按方向分道** —— `comm→worker`(委派)、`worker→comm`(升级求助)、
`comm↔user`(对话)语义完全不同,现在混在一个流里,只靠 `↗↙→←` 四个图标区分。

**③ 结果回链工件** —— 一个被回答的提问,应该落到它产出的那个 `decision` 上。
**总线 → 工件的闭环**是多 agent 系统唯一真正「看得懂」的地方:提问 → 回答 → 决策 → 下游工作。
`pending_question` 的交互 UI 其实已经存在(`Timeline.tsx:145-194`),缺的只是把结果指回工件。

**④ 阻塞上下文** —— 提问挂起时,标明哪个 agent 正卡在它上面、等了多久
(join §2 Layer 1 的阻塞计时)。现在只显示「Worker 升级了 N 个问题给你」,不显示代价。

**⑤ 一句范围说明**(防误解) —— 总线只承载**升级/求助**,不是所有 agent 间往来。
planner/executor 之间的大部分协作是**通过工件**完成的,不经过总线。
不写这句,用户会一直找「为什么看不到 planner 和 executor 的对话」。

---

## 6. Harness:从全局报表到「每个 agent 的雇员手册」

用户说「harness 的 tab 还是太空」—— 这个感受有精确的技术成因,不是错觉:

1. **6 行里 3 行是装饰** —— critic/memory/reflection 的提示词**没有任何代码读取**(见 §1 表)
2. **配置项是摆设** —— `enabledTools` / `redLines` / `budget` 是 `loader.ts:40-42` 的硬编码字面量,
   **无磁盘来源、无消费者、从不强制执行**;`maxIterations|perStepTimeoutMs|maxCostUsd` 在 `loader.ts` 之外**全项目零引用**。
   但页面上它们和真配置长得一模一样。
   → **2026-10-02 用户已确认:这不是 UI 问题,是 harness 本身还没设计完。** 见 §6.1。
3. **proposals 结构性永远为空** —— `harness_proposal` **没有生产发射点**。
   `HarnessManager` 只对 `kind === "harness_proposal"` 的工件反应(`harnessManager.ts:234`),
   而 executor 阻塞时**恒**产出 `kind: "hypothesis"` 的工件(`executor.ts:346`),
   即使它带 `callbackReason: "harness_proposal"`(`executor.ts:351-353` 已正确写进顶层和 `metadata` 两处)。
   **全仓没有任何代码把「带 harness_proposal 理由的 hypothesis」转换成 `harness_proposal` 工件** →
   manager 的触发条件永不满足,永远只输出空态。`http.ts:280-284` 的 note 已在如实交代这件事。

   > ⚠️ 排查时容易踩的坑:`shared/prompts/executor.md:52,68` 那份**死代码**提示词把
   > `callbackReason` 写在 `metadata` 下,与 `executor.ts:343` 读顶层看起来矛盾。
   > 但**真正生效**的是 `loader.ts:DEFAULT_PROMPTS.executor` 写到
   > `~/.sansheng/harness/system_prompts/executor.md` 的那份,它明确要求顶层
   > `{hypothesis:{title,body,callbackReason,metadata?}}` —— **与代码一致,不是问题所在**。
   > 真正的断点是上面第 3 条的 kind 不匹配。
4. **和屏幕上的任何 agent 都没有关系** —— 它是一张全局表,不是一个 agent 的档案。

### 改法:以 agent 为单位的雇员手册

**① 每个 agent 一张卡**,包含:角色职责、**真实生效的** system prompt 全文(可查看)、
它真正有的工具、预算、红线 —— **每个字段带「生效状态」徽章**:

| 徽章 | 含义 | 例子 |
|---|---|---|
| 🟢 生效中 | 真的被读取并注入模型 | planner / executor / communicator 的提示词 |
| 🔵 硬编码兜底 | 没有自己的文件,用的是编译进代码的常量 | harness_manager(`harnessManager.ts:127`) |
| 🟡 仅声明未强制 | 展示了,但代码里不执行 | enabledTools / redLines / budget |

> ⚪「未接线」这一档**在 2026-10-02 之后不再需要出现在用户可见的界面上** ——
> critic/memory/reflection 决定不实现(§1),所以它们根本不出现在手册里,
> 不存在「标注」的场景。徽章体系因此缩到三档。

> **实施补充(P0-C,commit `a70f464`)—— 三档的判定必须是数据推导,不能写死。**
> 实施时补齐了两条本设计没查到的判定依据:
> ① **`state === "empty"` 的真实后果不是「没有提示词」,而是回退到模块内默认常量** ——
> `Orchestrator.loadHarnessPrompt` 对空文件返回 `undefined`,于是 `planner.ts:176` /
> `executor.ts:124` 落回 `DEFAULT_PLANNER_PROMPT` / `DEFAULT_EXECUTOR_PROMPT`;
> communicator 侧则是「不传 resourceLoader,走 SDK 默认」。**所以 `empty` 属于 🔵 硬编码兜底,不是 🟢。**
> ② `harnessManagerPrompt.source === "builtin_fallback" || editable === false` 是 harness_manager
> 判为 🔵 的数据依据(不写死角色名,跟着 API 走)。
> 好处:用户哪天把 `planner.md` 清空,🟢 会**自动**降级成 🔵;API 哪天返回真实文件,也会自动转 🟢。
> API 少返回某角色摘要时**不给档位**,显示「摘要缺失」,不用「看起来像兜底」糊过去。

**光是这一层徽章,就把「太空」页变成了全 app 信息量最高的一页** —— 它如实告诉用户:
「planner 有一份 3766 字节的手册在生效;executor 有一份 1424 字节的;
harness_manager 压根没有文件,用的是代码里写死的那份」。

**② 「生效时机」是编辑功能的关键细节** —— 用户未来要能改,但必须告诉他改完什么时候生效:

| 角色 | 编辑后何时生效 | 依据 |
|---|---|---|
| planner / executor | **下一次 plan 运行时**(构造时读一次盘) | `orchestrator.ts:183-188`;每次 `run_plan` 新建实例(`ws.ts:327-339`)→ 不用重启 |
| communicator (Pi 直答) | **下一次 start/resume/reset** | `agentKernel.ts:933-940` |
| communicator (Communicator 实例) | **需要 kernel 失效重建** | 实例被 memoize(`agentKernel.ts:364-365`) |
| harness_manager | **需要改代码** —— 它没有 md 文件,用编译内置的 fallback | `harnessManager.ts:127` |

(原表还有「critic / memory / reflection → 永远不生效」一行,因三角色决定不实现、界面不再列出,已删除。)

没有这张表,用户改完 prompt 发现没反应,会直接判定产品坏了。

**③ 编辑(future)** —— 技术上很轻:每个角色一个 `PUT /api/harness/system_prompts/:role` →
写 `~/.sansheng/harness/system_prompts/{role}.md`(仓库里目前**没有任何 harness 写接口**,
`http.ts:254-257` 明确写了「本批只读」)。另外 `harness_manager` 需要**进版本链**(补一个
`harness_manager.md`,让 `FALLBACK_HARNESS_PROMPT` 退化为兜底而非唯一来源),
 communicator 实例那条还需要编辑后触发 `kernel.invalidate()`。
写接口会动用户自己的 prompt 文件,属于需要单独确认的改动,**不放在 P0/P1**。

**④ 自我改进提案区** —— 保留,但如实标注「尚未触发」**并写明原因**
(§6.3 的 kind 不匹配)。修它很小:executor 阻塞时若 `callbackReason === "harness_proposal"`,
就额外发一条 `kind: "harness_proposal"` 的工件(或让 manager 也接受
`kind==="hypothesis" && metadata.callbackReason==="harness_proposal"`),manager 第一次真的会活过来。

### 6.1 `enabledTools` / `redLines` / `budget`:等 harness 设计完成就消失了吗?

**是,但有前提 —— 前提是 harness 设计必须回答「谁执行它」。**

现状是「harness 设计没做完」的症状,不是三个独立 bug。三条支持「它属于 harness 范围」的证据:

- 它们现在是**全局**的,但按角色给才有意义。**「按 agent 约束工具」这条路已经走通过一次** ——
  communicator 已有白名单 `["read","grep","find","ls"]`(`agentKernel.ts:965`),
  不是从零开始。
- `loader.ts:6-7` 的文档注释**早就承诺过**磁盘布局 `harness/enabled_tools.json` + `harness/policies/*.json`,
  **但从未实现**(实测 `~/.sansheng/harness/` 下只有 `system_prompts/`,这两个路径不存在)。
  也就是说文件格式的方案早就想好了,只是没落地。
- `redLines` / `budget` 要真正生效需要**执行点**。budget 已有现成落点:
  `makeLlmCall` 的 `maxTokens`(`ws.ts:204`,批次 7-A 刚加的 `PLANNER_EXECUTOR_MAX_TOKENS`)
  和 `SettingsStore.costBudgetUsd`(已存储但无消费者)。

| 情形 | 结果 |
|---|---|
| harness 设计完成(有磁盘格式 + per-agent 化 + budget 至少有一个执行点) | 三个字段自然变成真配置,徽章转 🟢,**问题消失** |
| 只把字面量搬进 JSON 文件、不加执行点 | 变成「持久化的谎言」,比现在更糟(用户会以为它生效) |
| 什么都不做 | 维持现状,用 🟡 徽章如实标注 |

**过渡期唯一诚实的做法是 🟡 徽章**(§6①),并且不要在 P0/P1 里假装它们即将生效。
是否推进到「真配置」属于 harness 设计本身的范围 —— 但要记的是:它已经是 harness 设计的一部分,
**不是产品 UI 的欠债**,不该由 UI 批次来还。

---

## 7. 实施排期

### P0 —— 零后端改动,全用已有数据(信息密度最高)

| # | 内容 | 复用现成数据 |
|---|---|---|
| 1 | Blackboard → 四区工作面,DAG 用树状布局 | `dependsOn`/`parentIntent`/`executors`/`status`(当前 0 使用) |
| 2 | 工件 → 按沟通职能分组 + 生命周期展示 + 「待转述」视图 + 教学文案 | `kind`/`author`/`status` |
| 3 | Harness → 每角色「生效状态」徽章 + 「生效时机」表 | `describePrompts` 已有的 `state` 字段(`loader.ts:416-437`) |
| 4 | Agents 页角色表 → **只列 4 个真实 agent**(critic/memory/reflection 不再出现) | 编译期事实 |
| 5 | 总线 → question/reply 线程化 + 方向分道 + 范围说明 | `questionId`/`direction` |
| 6 | 失败原因进入 blackboard 展示(修 §3.① 的真实缺陷) | `error{code:"todo_failed"}` + `metadata.errorReason` |

P0 全部是**已有数据的重新组织**,不动 DB、不动 schema、不动事件流,回归风险低。
其中 #1 和 #6 修的是真实缺陷(丢掉的 DAG 结构、看不见的失败原因),不是锦上添花。

### P1 —— 小幅后端接线 + 一张新表(2026-10-02 修订:原 P1 全部「不需新迁移」的说法已作废)

| # | 内容 | 依据 |
|---|---|---|
| 7 | 补发被丢弃的 7 个 `ProgressEvent` | `ws.ts:358-373` 的 `default: break` —— 事件本身已定义 |
| 8 | `Orchestrator` 状态快照 getter + 替换 `/api/agents/:id` 的硬编码 stub | `orchestrator.ts:157-162` 已有数据,缺 getter 和路由 |
| 9 | `agent_run_traces` 表 + 在 `makeLlmCall` 调用点落库(thinking / usage / cost / stopReason / duration) | **原列 P2,现提前** —— 数据已在 `AssistantMessage` 里,只是被 `ws.ts:220-224` 丢弃(详见 §2.1) |
| 10 | 用 `AgentRunSummary` 契约做 planner/executor 概要(**数据源改为 #9**) | 原方案只能靠 artifact 反推,#9 落地后可直接读 |
| 11 | 真实 `/api/executors/:id/state` 替换 mock | `blackboardRoutes.ts:210-220` 现返回 `status:"idle", note:"mock · B1 stub"` |
| 12 | 补上 `harness_proposal` 发射点(executor 阻塞时按 `callbackReason` 发对应 kind 的工件) | `harnessManager.ts:234` 过滤 + `executor.ts:346` 恒发 `hypothesis` |

> **#9 动 schema**(migration 006),所以 P1 不再是「零迁移」批次。它提前到 P1 的理由是:
> 它的**技术风险最低**(写自己刚拿到的数据,不碰解析路径),而它解锁的产品面最大
> (Layer 2 概要 + Layer 3 过程 + #10 的真实数据源)。如果仍然想保持 P1 零迁移,
> 就把 #9/#10 整体留在 P2 —— 二者的差别只在于 Agent 详情页的概要/过程是「反推」还是「真读」。

### P2 —— 写接口 / 闭环(需单独确认)

| # | 内容 | 代价 |
|---|---|---|
| 13 | Harness 写接口 + `harness_manager.md` 入版本链 + `kernel.invalidate()` | 写用户 prompt 文件,需确认 |
| 14 | 总线提问 → 决策工件的闭环回链 | 依赖 7/8 的事件补全 |
| 15 | `enabledTools`/`redLines`/`budget` 变成真配置(per-agent 化 + 至少 budget 有执行点) | **属 harness 设计范围,不是 UI 欠债**(见 §6.1);P0/P1 期间用 🟡 徽章如实标注 |

---

## 8. 本设计**不**解决的问题(避免过度承诺)

- **critic / memory / reflection 三个 agent 没有实现** —— **用户 2026-10-02 已决定:暂不实现。**
  UI 的处置是**不列它们**(§1),但 `RoleKind` / `ArtifactAuthor` 里的字符串成员**保留不动**。
- **planner/executor 的 token 级过程** —— **2026-10-02 修订:不需要新架构,数据已经在手里。**
  原文把这列为「P2 前拿不到」是错的,详见 §2.1:它们从 P2 提前到 P1,成本是一张表 + 调用点一行。
- **Harness 的 enabledTools / redLines / budget** —— 用户已确认这属于 **harness 自身设计未完成**,
  不是 UI 欠债,§6.1 给了三条支持证据和「什么条件下问题才真正消失」的判据。

---

## 附:核查方式

本文所有事实可用以下方式独立复核(只读):

```bash
# 角色实现清点
grep -rn "^export class" src/server/agents/ src/server/kernel/

# harness 提示词的真实消费方(应只有 3 处)
grep -rn "loadHarness" src/ --include=*.ts | grep -v "loader.ts:"

# 被丢弃的 ProgressEvent
sed -n '356,375p' src/server/ws.ts

# 硬编码 stub
sed -n '243,247p' src/server/http.ts

# 真实工件(只读)
node -e "const D=require('better-sqlite3');const db=new D(process.env.HOME+'/.sansheng/sansheng.db',{readonly:true});\
console.log(db.prepare('select conversation_id,artifacts_json from blackboards').all().map(r=>[r.conversation_id,JSON.parse(r.artifacts_json||'[]').length]))"
```
