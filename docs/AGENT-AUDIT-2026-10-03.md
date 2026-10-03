# Sansheng · 角色职能核查与迭代方案(2026-10-03)

> 触发:用户「对 sansheng 的工作机制还是不太满意,按每个 agent 的角色职能做 checklist 逐项检查,
> 看期望职能与代码之间是不是有 gap,最后汇总一个改进方案,做一次大的技术迭代」。
> 核查基线:HEAD `70e6c94`(批次 7-O 已 push),测试基线 713 passed / 1 skipped(82 files)。
> 证据纪律:每条「代码事实」都带 `文件:行号`,grep 零命中的直接写「零命中」——
> 零命中本身是结论(本项目历史上有三例「存了没人读」都是这么抓出来的)。

---

## 0. 一句话结论

**系统里最会说话的 agent(沟通员)工具是真的,最该动手干活的 agent(执行者)工具是假的。**
其余 gap(终态没人播报 / 计划不可见不可改 / 记忆只写不读 / 评审与反思零实现 /
成本无设防)都是「承诺在文档与提示词里,执行点不在代码里」——与 7-B 死接线、
旧 `enabledTools` 同族,但这一次落在一个**用户每次干活都会碰到**的环节上。

---

## 1. 逐角色 checklist

判定四档:**✓ 一致** / **△ 部分**(缺哪半) / **✗ 缺失** / **? 无法判定**。

### 1.1 沟通员(communicator)

| # | 期望职能(出处) | 代码事实 | 判定 | 缺口 |
|---|---|---|---|---|
| 1 | 唯一对话入口,chat 直答(promptUnits `communicator` 单元;communicator.ts:761) | kernel.prompt → Pi session 直答(agentKernel.ts:1715 落库) | ✓ | — |
| 2 | decide 四选一 chat/task/clarify/feedback(communicator.ts:777 `routeUserMessage`) | 四分支齐全,feedback → bus.toRole=memory(communicator.ts:916) | ✓ | — |
| 3 | 工具面 10 个(7-E/7-H 裁决:只读不写) | 走 Pi session `createAgentSession({ tools: allowed })`(agentKernel.ts:1071)**机制级生效** | ✓ | 与执行者相反:这里是**真**的 |
| 4 | 升级用户前先自查(7-H 提示词) | 判断轮落地:worker_askAdjudicate(communicator.ts:535)+ agentKernel 注入(agentKernel.ts:448) | ✓ | 判断质量无评估(见 §3.5) |
| 5 | **Observer:终态主动播报一句话**(communicator 单元「三重身份」第 3 条) | `startObserver/onArtifactFinalized/enableObserver` 挂在 prototype(communicator.ts:1378-1501),**全仓无调用方**;agentKernel.ts:409 构造时也没开 | **✗** | 死接线:承诺的第三重身份**从来没有启动过** |
| 6 | 计划播报/任务状态感知 | 用户实际收到的是 ws `plan_done` 卡片 + 7-I `pickDeliveries` 的 evidence 原文(deliveries.ts) | △ | 有人替它说话,但**不是它**;失败路径无总结 |

### 1.2 规划员(planner)

| # | 期望职能 | 代码事实 | 判定 | 缺口 |
|---|---|---|---|---|
| 1 | intent → todo DAG(dependsOn / parentIntent)(planner.ts) | planner.ts:368 `dropCycles` + 落库,orchestrator.ts:643 构造 | ✓ | — |
| 2 | 「先看 Blackboard 避免重复规划」(promptUnits 1.5 节,7-H) | allowed = board_list + board_read,planner.ts:190 过滤生效 | ✓ | 工具循环里真实存在(2/2) |
| 3 | 刻意不给文件读 | ceiling 就是 `["board_list","board_read"]`(tools.ts ROLE_CEILING) | ✓ | — |
| 4 | 计划要让用户看到 / 能被否决 | `todos_planned` 在 orchestrator.ts:659 发出,但 ws.ts:354 **明确列它不外发**;grep `approve_plan|plan_review|plan_confirm` **零命中** | **✗** | 计划**对用户不可见、不可干预**,直接开跑 |

### 1.3 执行者(executor)

| # | 期望职能 | 代码事实 | 判定 | 缺口 |
|---|---|---|---|---|
| 1 | 领 todo 干活,产 evidence / decision | executor.ts:499 写 evidence、:529 写 hypothesis;orchestrator 驱动 spawnExecutor | ✓ | — |
| 2 | 卡住 → hypothesis(waiting_for_decision)→ 升级 | executor.ts:529 → orchestrator.ts:528 onExecutorCallback → 7-L 判断轮 → 用户 | ✓ | — |
| 3 | 失败沿 dependsOn 级联 | orchestrator.ts:754 `cascadeFailDependents` | ✓ | — |
| 4 | **工具面 13 个 = 只读 10 + edit/write/bash**(7-H,jev A2 裁决) | **工具循环池只有 9 个**(orchestrator.ts:152 buildOrchestratorTools = toolBridge 的 6 + native 的 3),与 allowed 求交后**只有 6 个真的可用**;read/grep/find/ls/edit/write/bash **在循环里不存在** | **✗** | 见下方实证 —— 本次最严重的一条 |
| 5 | 出厂提示词如实描述能力 | promptUnits.ts:336-348 明写「你有文件工具(读 / 检索 / 列目录 / 编辑 / 写入 / 执行命令)」+「事实来自工具,没查过的不要写」 | **✗** | 提示词在教模型用**不存在的工具** → 调用失败 → 纪律压力下**编造** |
| 6 | 并行执行同层 todo | orchestrator.ts:689 `tryUnblockDependents` 依赖满足即 spawn(同层并发) | ✓ | — |

**实证(可复现)**:脚本按生产代码路径拼出工具池并与 `tools/executor.json` 求交:

```
工具循环实际可用的工具池(9): canvas_read / canvas_list / canvas_stat / canvas_write / net_fetch / net_post / board_list / board_read / memory_search

[executor] 集合文件说可用 13 个 → 循环里真的存在 6 个
   真的有: canvas_read / canvas_list / canvas_stat / board_list / board_read / memory_search
   **声称有但循环里不存在**: read / grep / find / ls / edit / write / bash
[planner] 集合文件说可用 2 个 → 循环里真的存在 2 个
[communicator] 集合文件说可用 10 个 → 循环里真的存在 6 个
   **声称有但循环里不存在**: read / grep / find / ls
```

> communicator 那 4 个是**例外而非同类 bug**:它走 Pi session,SDK 工具由 SDK 自己注册
> (`createAgentSession({ tools })` 是机制级 allowlist),所以 10/10 真实。
> planner/executor 走 `completeSimple` + 自建工具循环,SDK 工具**不在池子里**。

### 1.4 工装顾问(harness_manager)

| # | 期望职能 | 代码事实 | 判定 | 缺口 |
|---|---|---|---|---|
| 1 | 订阅 `artifact_created`,对 `kind=harness_proposal && status=open` 生成实现预览(harnessManager.ts:7-11) | 订阅在 harnessManager.ts:165;过滤条件在 :233 | ✓(代码在) | — |
| 2 | **有工件真的触发它** | 全仓唯一的 `kind: "harness_proposal"` 出现在 http.ts:280 —— 那是**查询过滤**,不是产出方 | **✗** | 结构性永不触发:manager 永远在待命,UI 的 proposals 恒为空 |
| 3 | 有自己的提示词文件 | 无 `harness_manager.md` 进版本链,用编译内置 `FALLBACK_HARNESS_PROMPT` | △ | 7-G 已记录,5c 未做 |

### 1.5 沉淀器(sedimentation)

| # | 期望职能 | 代码事实 | 判定 | 缺口 |
|---|---|---|---|---|
| 1 | 回合后异步提炼结构化记忆,不阻塞主回合 | agentKernel.ts:1745 → :1849 `triggerSedimentation` → `void sedimentTurn`(失败只 log) | ✓ | — |
| 2 | 质量闸门「宁缺毋滥」(promptUnits sedimentation 单元) | sedimentation.ts:59-67 超时 8s / 800 token / 每轮 ≤3 / 标题 ≤60 / 正文 ≤199 | ✓ | — |
| 3 | **沉淀物要被后续对话用上** | 产出 `kind=insight`(sedimentation.ts:82),全仓消费点只有 UI(Agents.tsx:186、Artifacts.tsx:169) | **✗** | 只写不读:沉淀进黑板后**不进任何 prompt** |

### 1.6 记忆系统(fragments / profile)

| # | 期望职能 | 代码事实 | 判定 | 缺口 |
|---|---|---|---|---|
| 1 | 用户说「我叫…/我喜欢…」要记下来 | extractor.ts:30-31 NAME_RE / LIKE_RE 正则命中即入库 | △ | **只有句首三种句式**;其余自述一概不记 |
| 2 | 记下来的东西要影响后续对话 | ws.ts:642-656 `contextBlock` 注入 | △ | **只发生在 `cmd.type==="send"`**(沟通员路径);planner/executor 的 completeSimple 调用拿不到记忆 |
| 3 | 检索工具 `memory_search` | nativeTools.ts:199 + executor/planner/communicator 的 allowed 都有 | ✓ | 工具在,但没有测试证明检索结果进了模型输入 |

### 1.7 Blackboard 原语

| # | 期望职能 | 代码事实 | 判定 | 缺口 |
|---|---|---|---|---|
| 1 | agent 之间靠工件互相理解 | board_list / board_read 已接进 7 个角色的集合;orchestrator 状态机完整 | ✓ | — |
| 2 | 执行者产出对兄弟可见 | executor 落 evidence,planner/executor 可 board_read | ✓ | — |
| 3 | 全局 vs 会话两级 | listArtifacts scope 分派(blackboards.ts),orchestrator 两处都扫 | ✓ | — |
| 4 | 事件总线配套 | `artifactBus.publish` **全仓只有 `artifact_created` 一个事件有发布方**(orchestrator.ts:388、harnessManager.ts:355/501);ws.ts 却转发 5 个事件类型 | △ | 事件类型定义富足、发布方只有 1 个;`harness_proposal_created` **零发布方** |

### 1.8 评审者(critic)/ 1.9 反思者(reflection)

| # | 期望职能 | 代码事实 | 判定 | 缺口 |
|---|---|---|---|---|
| 1 | 产出质量有人把关 | `grep "class Critic|new Critic|class Reflection|new Reflection" src/` **零命中** | **✗** | 只有提示词文件 + 空工具集合 + Harness 页上一行(纯占位) |
| 2 | reflection 片段进记忆 | AGENTS.md 记「用 `kind:"context"` + `[reflection]` 前缀」 | ✗ | 写入方不存在(无 reflection 执行体) |

---

## 1.10 记忆面专项(并行审计 + 主会话逐条复核)

下面五条来自并行只读审计,标 **[已复核]** 的三条由主会话亲自 grep/读代码确认,
标 [未复核] 的仅作线索,实施前需再查。

| # | 发现 | 证据 | 判定 |
|---|---|---|---|
| M1 **[已复核]** | **向量检索整条链在生产闲置**:每次写 fragment 都真发一次 `text-embedding-3-small` 请求并 upsert 进 `fragments_vec`(agentKernel.ts:1930-1940),但**唯一读向量表的 `searchFragments(` 全仓只有定义处 + 6 个测试文件命中**;生产的两条检索路径(ws.ts:646、nativeTools.ts:138)都走 LIKE | grep `searchFragments(` src/ tests/ | **✗ 白花钱**:每次「记住」付一次 embedding 费用,换回一个从不被读的结果 |
| M2 **[已复核]** | **文本检索对中文几乎无效**:`fragments.ts:186` 的 `tok.match(/[\u4e00-\u9fa5]{2,}/g)` 是**贪婪整段**,不是「按字拆」—— 注释自己写的就是错的。查询「我叫什么名字」得到一个 token,召不回 `用户名字:小明` | fragments.ts:186 + 注释与实现不符 | **✗** 「记住了」下一轮召不回,记忆对用户不可见 |
| M3 **[已复核]** | **记忆富集在 task/feedback/clarify 轮被丢弃**:ws.ts:642-656 为每条消息都算了 `contextBlock`,但 agentKernel.ts:1388-1394 对 task/feedback/clarify 提前 `return`,消费点 `session.prompt(full)`(agentKernel.ts:1416)在后面 | 同左 | **✗** 记忆只喂到 chat 直答;planner/executor 更是完全拿不到 |
| M4 [未复核] | fragments **无上限 / 无淘汰 / 无去重**(`grep -i "evict|prune|retention|MAX_FRAGMENTS|ttl" src/` 零命中;表定义无 UNIQUE(content))—— 而 artifacts 侧有完整四道闸门(sedimentation.ts:63/280/303/313) | 见左 | ✗ 两套记忆卫生水平不一致 |
| M5 [未复核] | **两套记忆彻底割裂 + 死字段**:`FragmentRef` 类型 grep 零使用、`retrieved_memories_json` 建行起恒为 `'[]'`、`decay_factor` 只写不读、`access_count` 的 `recordFragmentAccess` 生产零调用(排序因子恒为 importance) | 见左 | ✗ 与 7-E 的「假配置」同族 |

**这五条与 §1.1–1.9 的一致性检查**:G4(记忆只写不读)在专项里被拆成了 M1–M5 五个**各自独立**的断点 ——
即便 8-D 只做「把 contextBlock 也喂给 planner/executor」,只要 M2 的中文检索不修,
用户仍然看不到记忆生效。**8-D 必须至少同时包含 M2(检索可用)+ M3(注入到干活的人)。**

---

## 1.10 记忆面专项(并行审计 + 主会话逐条复核)

下面五条来自并行只读审计,标 **[已复核]** 的三条由主会话亲自 grep / 读代码确认;
标 [未复核] 的仅作线索,实施前需再查。

| # | 发现 | 证据 | 判定 |
|---|---|---|---|
| M1 **[已复核]** | **向量检索整条链在生产闲置**:每次写 fragment 都真发一次 `text-embedding-3-small` 请求并 upsert 进 `fragments_vec`(agentKernel.ts:1930-1940),但**唯一读向量表的 `searchFragments(` 全仓只有定义处 + 6 个测试文件命中**;生产的两条检索路径(ws.ts:646、nativeTools.ts:138)都走 LIKE | grep `searchFragments(` src/ tests/ | **✗ 白花钱**:每次「记住」付一次 embedding 费用,换回一个从不被读的结果 |
| M2 **[已复核]** | **文本检索对中文几乎无效**:`fragments.ts:186` 的 `tok.match(/[\u4e00-\u9fa5]{2,}/g)` 是**贪婪整段**,不是注释自称的「按字拆」。查询「我叫什么名字」只得到一个 token,召不回 `用户名字:小明` | fragments.ts:186(注释与实现不符) | **✗** 「记住了」下一轮召不回,记忆对用户不可见 |
| M3 **[已复核]** | **记忆富集在 task/feedback/clarify 轮被丢弃**:ws.ts:642-656 为每条消息都算了 `contextBlock`,但 agentKernel.ts:1388-1394 对 task/feedback/clarify 提前 `return`,唯一消费点 `session.prompt(full)`(agentKernel.ts:1416)在它后面 | 同左 | **✗** 记忆只喂到 chat 直答;planner/executor 完全拿不到 |
| M4 [未复核] | fragments **无上限 / 无淘汰 / 无去重**(`grep -i "evict\|prune\|retention\|MAX_FRAGMENTS\|ttl" src/` 零命中;表定义无 UNIQUE(content))—— 而 artifacts 侧有完整四道闸门(sedimentation.ts:63/280/303/313) | 见左 | ✗ 两套记忆卫生水平不一致 |
| M5 [未复核] | **两套记忆彻底割裂 + 死字段**:`FragmentRef` 类型 grep 零使用、`retrieved_memories_json` 建行起恒为 `'[]'`、`decay_factor` 只写不读、`recordFragmentAccess`(access_count 排序因子)生产零调用 | 见左 | ✗ 与 7-E「假配置」同族 |

**与 §1.1–1.9 的一致性**:G4(记忆只写不读)在专项里被拆成 M1–M5 五个**各自独立**的断点 ——
8-D 只做「把 contextBlock 喂给 planner/executor」是不够的:只要 M2 的中文检索不修,
用户仍然看不到记忆生效。**8-D 至少要同时包含 M2(检索可用)+ M3(注入到干活的人)。**

---

## 1.10 记忆面专项(并行审计 + 主会话逐条复核)

下面五条来自并行只读审计,标 **[已复核]** 的三条由主会话亲自 grep / 读代码确认;
标 [未复核] 的仅作线索,实施前需再查。

| # | 发现 | 证据 | 判定 |
|---|---|---|---|
| M1 **[已复核]** | **向量检索整条链在生产闲置**:每次写 fragment 都真发一次 `text-embedding-3-small` 请求并 upsert 进 `fragments_vec`(agentKernel.ts:1930-1940),但**唯一读向量表的 `searchFragments(` 全仓只有定义处 + 6 个测试文件命中**;生产的两条检索路径(ws.ts:646、nativeTools.ts:138)都走 LIKE | grep `searchFragments(` src/ tests/ | **✗ 白花钱**:每次「记住」付一次 embedding 费用,换回一个从不被读的结果 |
| M2 **[已复核]** | **文本检索对中文几乎无效**:`fragments.ts:186` 的中文正则 `{2,}` 是**贪婪整段**,不是注释自称的「按字拆」。查询「我叫什么名字」只得到一个 token,召不回 `用户名字:小明` | fragments.ts:186(注释与实现不符) | **✗** 「记住了」下一轮召不回,记忆对用户不可见 |
| M3 **[已复核]** | **记忆富集在 task/feedback/clarify 轮被丢弃**:ws.ts:642-656 为每条消息都算了 `contextBlock`,但 agentKernel.ts:1388-1394 对 task/feedback/clarify 提前 `return`,唯一消费点 `session.prompt(full)`(agentKernel.ts:1416)在它后面 | 同左 | **✗** 记忆只喂到 chat 直答;planner/executor 完全拿不到 |
| M4 [未复核] | fragments **无上限 / 无淘汰 / 无去重**(`grep -i evict/prune/retention/MAX_FRAGMENTS/ttl src/` 零命中;表定义无 UNIQUE(content))—— 而 artifacts 侧有完整四道闸门(sedimentation.ts:63/280/303/313) | 见左 | ✗ 两套记忆卫生水平不一致 |
| M5 [未复核] | **两套记忆彻底割裂 + 死字段**:`FragmentRef` 类型 grep 零使用、`retrieved_memories_json` 建行起恒为 `'[]'`、`decay_factor` 只写不读、`recordFragmentAccess`(access_count 排序因子)生产零调用 | 见左 | ✗ 与 7-E「假配置」同族 |

**与 §1.1–1.9 的一致性**:G4(记忆只写不读)在专项里被拆成 M1–M5 五个**各自独立**的断点 ——
8-D 只做「把 contextBlock 喂给 planner/executor」是不够的:只要 M2 的中文检索不修,
用户仍然看不到记忆生效。**8-D 至少要同时包含 M2(检索可用)+ M3(注入到干活的人)。**

---

## 2. 横向机制

| # | 项 | 代码事实 | 判定 |
|---|---|---|---|
| 1 | 开工前对齐一次 | makeAlignmentCheck(communicator.ts:368)+ 闸门调用(communicator.ts:838-871),失败一律放行(fail-open) | ✓ |
| 2 | 成本预算 | `costBudgetUsd` 只在 store/http 存取,**零判定**;messages 记了 costUsd 但无人比较(agentKernel.ts:1715) | ✗ |
| 3 | 资源预算 config.budget | maxIterations / perStepTimeoutMs / maxCostUsd **零消费方** | ✗ |
| 4 | 计划中止能力 | 服务端 `abort_plan` 存在(ws.ts:689),`grep abort_plan web/src` **零命中** | △ 后端有、前端无 |
| 5 | 写权限边界 | executor 的 edit/write/bash 走 SDK 工具,根是 `createAgentSession` 的 cwd(=settings.cwd),**不经 Sansheng Sandbox**;canvas_* 才受 sandbox 管 | △(与 7-H 裁决一致,但值得在 UI 上说清) |
| 6 | harness 写面覆盖 | 11 个提示词单元里 UI 只能编辑 4 个(communicator/planner/executor/harness_manager) | △ |

---

## 3. gap 汇总(按严重度 = 是否影响用户每次干活)

| 级别 | gap | 后果 | 对应批次 |
|---|---|---|---|
| **P0** | G1 执行者 13 个工具里 7 个是假的,且提示词在教它用 | 执行者不能读文件/写文件/跑命令;模型被逼编造「查过」的内容 | 8-A |
| **P0** | G2 终态没人播报(Observer 死接线) | 干完活只有一张卡片,没有「做完了,结论是…」 | 8-B |
| **P0** | G3 计划不可见、不可中止 | 用户既看不到拆解,也停不下跑飞的 plan | 8-C |
| **P1** | G4 记忆只写不读 + 不喂干活的人 | 「它记得」只在我叫/我喜欢时成立,执行者永远不知道用户偏好 | 8-D |
| **P1** | G5 质量把关与自我改进缺位(critic/reflection 零实现、manager 永不触发) | 错误产出没人拦,系统不会从失败里变好 | 8-E(后续) |
| **P2** | G6 成本无设防 | 单次跑飞可以烧掉真金白银 | 8-F(后续) |
| **P2** | G7 harness UI 只覆盖 4/11 提示词单元 | 「管理每个 agent 的 prompt」只做了一半 | 8-G |

---

## 4. 迭代方案(批次 8)

### 8-A 给执行者真实工具(P0 · jev 首推,conf 0.95)
**为什么先做它(第一性原理)**:执行者存在的意义就是动手。它现在不能动手,
后面所有「产出质量」「自我改进」都是在讨论一个没有手的 worker。

1. `src/server/harness/sdkTools.ts`(新):把 SDK 的 8 个工具
   (`createReadOnlyTools` / `createCodingTools`,cwd = `settings.cwd`)适配成 `LoopTool`
   (`{name, description, run}`);适配器复用 toolBridge 已有的「结果 → 文本」约定,
   并统一套 sandbox 允许根做二次校验(不让 SDK 工具越出 sandbox 允许根)。
2. `orchestrator.ts buildOrchestratorTools` 并入这 8 个(按角色 allowlist 过滤,已生效)。
3. **加一条不变量测试**:对每个 `enforced:true` 的角色,
   `tools/{role}.json` 的 `allowed` 必须是工具池的子集 —— 集合文件从此不能再说谎。
4. 提示词按「实际拿到的工具」措辞:8-A 落地后 §0 的表述就变成真的;若某个工具
   没进池(例如被收回),协议段(renderToolProtocol)会如实只列池里的。

### 8-B 终态播报(P0)
plan settle 之后由沟通员产出一句话总结(独立轻量 LLM 调用 + 固定降级文案),
走 bus broadcast,前端当普通 chat 消息渲染;失败/取消/超时三种终态都要有话说。
复用 7-L 的 `q-comm-*` 纪律:播报只说终态,中间态不打扰。

### 8-C 计划可见可中止(P0)
`todos_planned` 转发给前端(计划卡:标题 + 依赖 + 状态);
UI 加「中止当前 plan」(`abort_plan` 后端已就绪);可选加一个「计划确认」开关
(decide=task 后先展示计划、等用户一句「开工」)。

### 8-D 记忆闭环(P1)
planner/executor 的 `completeSimple` 也注入 `contextBlock`(复用 ws.ts:642 的检索);
沉淀产出的 `insight` 进检索源;提取从「三句正则」扩到「feedback 判定 + 沉淀」双通道。

### 8-E 质量把关与自我改进(P1,后续)
最小 critic:对 resolved evidence 做一次「结论是否有据」自检(失败不改状态,只留 note);
harness_proposal 补一个真实产出方(executor 连续失败 / 用户明确说「这个设计有问题」时)。

### 8-F 预算设防(P2)
累计 cost 超 `costBudgetUsd` → 不再启动新 todo + 向用户播报一句,而不是跑到底。

### 8-G harness UI 覆盖(P2)
提示词单元一节列全 11 个(orphan 如实标),补齐 decide/align/worker_ask/sedimentation 的编辑入口。

---

## 5. 决策记录(jev 闸门)

- **范围(7-O 后端+UI 闭环 vs 只后端 vs 只 tools)**:`jev decide` → PROCEED,pick B,
  needsUser 0.24 / conf 0.50 / margin 0.33。
- **本迭代第一个批次**:`jev decide` → PROCEED,pick **8-A**,needsUser 0.29 / conf 0.95 /
  margin 0.95 —— 闸门自评「auto-decidable」。用户已授权「拿不定主意时选能保证最基础功能的那条」,
  而 8-A 正是那条:没有真工具的执行者,其它一切都是空转。
