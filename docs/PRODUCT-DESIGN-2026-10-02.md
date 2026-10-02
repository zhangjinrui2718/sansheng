# Sansheng 产品侧设计 · 六个面的重做方案

> 触发:用户反馈「产品侧太简单了」,并逐条点名 blackboard / agent 状态 / agent harness / 总线 / 工件 / harness tab。
> 日期:2026-10-02 · 基线 HEAD `702968f` · 481 passed / 1 skipped · typecheck 0 error。
> 性质:**设计文档,零代码改动**。实施范围由本文末尾的 P0/P1/P2 排期决定。
> 证据纪律:本文每条事实都带 `file:line`;涉及真实数据的部分标注了库内实测结果
> (`~/.sansheng/sansheng.db`,只读查询)。凡是没查证的推断,一律标为「假设」。

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

后三个**必须显式展示为「未接线」**,而不是留一行永远灰的 idle(沿用 `Agents.tsx:1-19` 头注释里
那条「反造假纪律」:宁可如实显示空态,不摆假数据)。

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

**必须如实说明的缺口**:planner / executor 的过程**目前只有阶段转换,没有 token 级轨迹**。
它们的 LLM 调用走 `completeSimple` 返回纯文本(`ws.ts:179-226`),**从不写库** ——
`messages` 表的唯一写入点是 `agentKernel.ts:1563`,只存沟通员的对话轮次。
所以 Layer 3 对这两个角色 v1 是「阶段 + 计时」,想要逐步细节需要 P2 的 trace 表。
communicator 例外:`messages.tool_calls` / `messages.thinking` 里**已经有**真实工具与思考轨迹,从没被展示过。

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
| ⚪ 未接线 | 文件在,但没有消费者 | critic / memory / reflection |
| 🟡 仅声明未强制 | 展示了,但代码里不执行 | enabledTools / redLines / budget |

**光是这一层徽章,就把「太空」页变成了全 app 信息量最高的一页** —— 它如实告诉用户:
「planner 有一份 3766 字节的手册在生效;critic 有一份 240 字节的草稿没人读」。

**② 「生效时机」是编辑功能的关键细节** —— 用户未来要能改,但必须告诉他改完什么时候生效:

| 角色 | 编辑后何时生效 | 依据 |
|---|---|---|
| planner / executor | **下一次 plan 运行时**(构造时读一次盘) | `orchestrator.ts:183-188`;每次 `run_plan` 新建实例(`ws.ts:327-339`)→ 不用重启 |
| communicator (Pi 直答) | **下一次 start/resume/reset** | `agentKernel.ts:933-940` |
| communicator (Communicator 实例) | **需要 kernel 失效重建** | 实例被 memoize(`agentKernel.ts:364-365`) |
| harness_manager | **需要改代码** —— 它没有 md 文件,用编译内置的 fallback | `harnessManager.ts:127` |
| critic / memory / reflection | **永远不生效** | 无消费者 |

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

---

## 7. 实施排期

### P0 —— 零后端改动,全用已有数据(信息密度最高)

| # | 内容 | 复用现成数据 |
|---|---|---|
| 1 | Blackboard → 四区工作面,DAG 用树状布局 | `dependsOn`/`parentIntent`/`executors`/`status`(当前 0 使用) |
| 2 | 工件 → 按沟通职能分组 + 生命周期展示 + 「待转述」视图 + 教学文案 | `kind`/`author`/`status` |
| 3 | Harness → 每角色「生效状态」徽章 + 「生效时机」表 | `describePrompts` 已有的 `state` 字段(`loader.ts:416-437`) |
| 4 | Agents 页角色表 → 4 真实 agent + 3 个显式「未接线」 | 编译期事实 |
| 5 | 总线 → question/reply 线程化 + 方向分道 + 范围说明 | `questionId`/`direction` |
| 6 | 失败原因进入 blackboard 展示(修 §3.① 的真实缺陷) | `error{code:"todo_failed"}` + `metadata.errorReason` |

P0 全部是**已有数据的重新组织**,不动 DB、不动 schema、不动事件流,回归风险低。
其中 #1 和 #6 修的是真实缺陷(丢掉的 DAG 结构、看不见的失败原因),不是锦上添花。

### P1 —— 小幅后端接线(全部在已有类型/事件上,**不需要新迁移**)

| # | 内容 | 依据 |
|---|---|---|
| 7 | 补发被丢弃的 7 个 `ProgressEvent` | `ws.ts:358-373` 的 `default: break` —— 事件本身已定义 |
| 8 | `Orchestrator` 状态快照 getter + 替换 `/api/agents/:id` 的硬编码 stub | `orchestrator.ts:157-162` 已有数据,缺 getter 和路由 |
| 9 | 用 `AgentRunSummary` 契约复活 planner/executor 概要 | 类型已定义,实现是死代码 |
| 10 | 真实 `/api/executors/:id/state` 替换 mock | `blackboardRoutes.ts:210-220` 现返回 `status:"idle", note:"mock · B1 stub"` |
| 11 | 补上 `harness_proposal` 发射点(executor 阻塞时按 `callbackReason` 发对应 kind 的工件) | `harnessManager.ts:234` 过滤 + `executor.ts:346` 恒发 `hypothesis` |

### P2 —— 需要新迁移 / 新写接口(需单独确认)

| # | 内容 | 代价 |
|---|---|---|
| 12 | 步骤 trace 持久化(`migration 006`,006 是当前下一个空号) | 新 schema,动用户真实数据库 |
| 13 | Harness 写接口 + `harness_manager.md` 入版本链 + `kernel.invalidate()` | 写用户 prompt 文件,需确认 |
| 14 | 总线提问 → 决策工件的闭环回链 | 依赖 7/8 的事件补全 |

---

## 8. 本设计**不**解决的问题(避免过度承诺)

- **critic / memory / reflection 三个 agent 没有实现** —— 这是**后端产品缺口,不是 UI 缺口**。
  本设计最多让它们被**诚实地标成「未接线」**;要它们真的会跑,是另一件事(实现三个 agent,
  或从 `RoleKind` 里删掉)。删掉是更小的改动,但会动共享类型和 481 个测试的基线。
- **planner/executor 的 token 级过程**在 P2 之前拿不到 —— 它们的 LLM 输出从不落库(见 §2 Layer 3)。
- **Harness 的 enabledTools / redLines / budget 要么变成真的、要么从 UI 拿掉** ——
  继续展示而不强制执行,是在对用户撒谎。这个二选一属于产品决策,本文不替用户定;
  过渡期用 🟡 徽章如实标注是唯一诚实的处理。

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
