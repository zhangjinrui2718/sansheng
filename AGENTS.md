# AGENTS.md — Sansheng 项目工作规范

> 本文件是每个 DSH 会话**自动注入**的工作规范 —— 读它的人会照着做。所以这里的每一条事实都必须能用一个命令验出来;不确定的宁可不写。
> 描述的是 2026-10-04 清场之后的系统。旧系统(`src/server/**`)已于批次 15 整体删除,ARCHITECTURE.md 与 PLAN.md 随后一并删除:**本文没写的旧名字一律当作不存在**,不要从历史文档里往回找。

## 项目速览

- **Sansheng(三生)** = 单用户本机常驻 Node 服务:Pi SDK 驱动**四个角色的 agent 组织**,SQLite 持久化,HTTP + WS + 托管前端。
- **组织架构是一等数据**:`agents` / `projects` / `project_assignments` 在库里,**角色属性在代码里**(`ROLE_SPECS`)。制品是工件(`artifacts` 表),不是聊天记录。
- 默认 `127.0.0.1:2719`;数据目录默认 `~/.sansheng/`,可用 `--data` 或 `SANSHENG_DATA` 覆盖。
- **「此刻」的读面只有一处**:`GET /api/projects/:id/live`(`ProjectLiveView`)—— 成员页的
  「正在做什么」与工件页产出图的「在跑」标记共用它。三个来源刻意分开:宿主内存的忙闩
  (`hub.runningTurns()`,重启即清零)/ 库里的工作项与 `collectTodos` 的待办 / 落库痕迹。
  `runtime: "unavailable"` 是**读不到**,不是「空闲」—— 前端不许把它渲染成后者。
  工件页的产出图靠 `ArtifactView.workId`(migration 014 的产出边)把工件挂回环节。
- **导航现在只有 7 个 tab**:对话 / 项目 / 工作项 / 待办 / 成员 / 记忆 / 设置。两次合并:
  **「工件」并入「工作项」**(`web/src/routes/Works.tsx`,2026-10-06)与
  **「Harness」并入「成员」**(`web/src/components/members/RoleHarness.tsx`,同日)。
  **工作项页的信息顺序 = 依赖关系图 → 推进图 → 选中的环节**(前者**不折叠**,用户点名的顺序);
  推进图是时间轴泳道(`web/src/lib/timeline.ts`,纯函数:x = 时间,一条工作项一道、一种工件
  kind 一道;点绿色条 ⇒ 下面显示那条工作项挂着的工件),依赖图是分层 DAG
  (`web/src/lib/workGraph.ts`)。**成员页一个成员一块面板**(按角色页签切换):面板里有
  「正在做什么」(`GET /api/projects/:id/live`)与他产出的工件;面板**之下另起一张独立的
  「角色 harness」卡片**(`Section` + 常显的状态摘要行 + 默认折叠的配置)—— 提示词单元的
  编辑 / 恢复出厂 / 备份数都在那里,写面四条规矩与后端一致。**未来角色 harness 的配置就放这张卡**。
- **平台记录的落点 = 项目页两段,按主体分家**(`web/src/routes/ProjectDetail.tsx`)。
  **「组织推进」**= 停止推进,带**派生状态**(已接回 / 会被接回 / 在等你 / 不会自愈 / 已收口 /
  读不到 ⇒ 判据在 `web/src/lib/orgState.ts`,事实来自 `GET /live` 与 `GET /messages`);
  **「合规记录」**= 不派生状态 —— 那一个回合确实没留工作记录,平台也不替模型补,
  **任何「已解决」都是编造现场**,它只能说「记录 · 不需要你动作」+ 计数。
  `session_messages` 里 `kind='system'` 的行**只有两个生产者**,都在
  `src/platform/host/serve.ts`:`announceDrain`(停止推进,项目级)与
  `reportUnannouncedTurn`(合规告警,回合级),都落项目的**内部会话**,`agent_id` 为 NULL;
  分类只认**正文首行前缀**(`web/src/lib/platformNotices.ts`)。
  **对话页一个字都不留**(既不是气泡,也不再是一条「系统带」):`partitionTurns` 把它们摘成
  `notices` 计数,屏幕上只剩 `channelNoteText` 那一行「另有 N 条平台通知 —— 到「项目」页
  「组织运行态」查看」。别再把它渲染回对话页(**别再引回 `data-channel="system"`**),
  也别把「读不到」渲染成「空闲」。
- **依赖图的边方向 = 先后**(前置 → 本条;**子项 → 父项**,容器由子项推动)。这个方向是
  判据的一部分:同一对节点上两类边**方向一致**时不是环(真机那份数据就是这样),方向相反
  才是环(`mutualPairs` 会点名是哪两条边)。写反会让「交付」跑到最左、并且把一个不存在的
  环报出来(`web/src/lib/workGraph.ts` 的 `collectEdges`)。
- 基线:**1579 passed / 77 test files** · 两条 typecheck 0 error · `check:design` E1–E14 全绿。
- **角色中文名只有一处**:`src/platform/runtime/org.ts` 的 `ORG`(播种 + `RoleHarnessView.displayName`
  共用);前端兜底表 `web/src/lib/vocab.ts` 的 `ROLE_LABEL` 必须逐项相同,由
  `tests/web/role-names.test.ts` 跨边界对照。**不许在某个页面里再写一张名字表**
  (曾经 harness 页写 `Worker(执行者)`、成员页写 `工程师`、前端兜底写 `执行者`)。
- 日志只走 stdout:`~/.sansheng/logs/sansheng.log` 恒为 0 字节,别去 tail 它。

## 源码地图(`find src -name '*.ts' | wc -l` = 56)

```
src/cli/                 CLI 入口(index.ts + paths.ts)
src/platform/cli/        smoke / run 两个子命令的实现
src/platform/host/       常驻宿主:serve / scheduler / reset
src/platform/transport/  传输:http(API)/ hub(WS 广播)/ views
src/platform/runtime/    boot session turn execution assembly promptAssembly pendingWork
                         projectContext dispatcher org sdkAdapter
src/platform/tools/      工具层:9 个文件、34 个平台工具定义 + registry.ts 的 dispatch()
src/platform/harness/    授权:capability(能力↔工具表)/ authorize(三道门)/ toolSet(L2 集合文件读盘)/ write(提示词写盘)
src/platform/identity/   角色:role.ts 的 ROLE_SPECS
src/platform/storage/    db.ts + repo/ 下 10 个仓储
src/platform/infra/      keyring / settings / settingsApply / providers / migrations
src/platform/memory/     MemoryPort 端口 + sqlite 实现
src/platform/client/     ClientChannel 端口
shared/types/            跨端协议类型(platform.ts / settings.ts)
```

工具表合计 **41 个工具 = 34 平台 + 7 SDK 内置**,能力 **33** 条 —— 这四个数字由 `check:design` 每次核对。

> **不要按「单向分层」的假设推理依赖方向。** 实测 `identity ↔ harness` 之间有**值级 import 环**(`src/platform/identity/role.ts` 从 `src/platform/harness/capability.ts` 取能力表,`src/platform/harness/authorize.ts` 从 `src/platform/identity/role.ts` 取 `ROLE_SPECS`),`transport` 也会向上引 `host`。这是现状,不代表可以随手加新的反向依赖。

## 改什么之前先读哪份文档

| 要改的东西 | 先读 |
|---|---|
| 结构、能力模型、授权、存储、运行时拓扑 | `docs/DESIGN-PLATFORM.md` |
| 四个角色的职责 / ceiling / 出厂集合 / 提示词单元 | `docs/DESIGN-AGENTS.md` |
| 会话在哪建、平台工具怎么变成 SDK 的 customTools | `docs/ADR-001-harness-wiring.md` |
| 当前进度与批次 | `HANDOFF.md` |

`docs/AGENT-AUDIT-2026-10-03.md` 是逐角色职能核查报告(旧结构,但角色职责部分仍有效)。

> 三份设计文档**有已知的与代码不符处**(例如 §8.1 的表名仍写成 `fragments`/`user_profile`)。**以代码为准,文档是意图**;改到相关结构时顺手把不符处改掉 —— 批次 19 顺手修掉了 §7.1 的 `RoleSpec` 形状(它写了一个代码里不存在的 `factorySet` 字段)与 §7.4 的闭合注册表名(`PROMPT_UNIT_IDS` / `TOOL_ROLES` → 实际的 `promptUnitIds()` / `PROJECT_ROLES`)。

## 四个角色

`PROJECT_ROLES` = `business_manager` / `project_manager` / `worker` / `quality_reviewer`。

- **只有 business_manager 是甲方接口**(`clientFacing: true`)。这是「甲方只与业务经理交互」的机器表达,是**代码内常量** —— 不入库,所以不存在被数据篡改的路径。
- 完整规格在 `src/platform/identity/role.ts` 的 `ROLE_SPECS`:`ceiling`(架构上界)/ `writeKinds` / `promptUnits` / `boundaryDeny`(**仅供 UI 展示,不参与授权判定**)。
- 出厂工具集**不另存名单**,由 `ceiling` 推导(`factoryToolset`)。增删角色 = 改联合 + `ROLE_SPECS`,一次显式代码评审。

## 核心机制:三道门,只减不增

工具 = **能力 × 作用域**。判定分两个阶段,因为输入不同:

- **求解期** `solveToolset(agent, project, userToolSet?)`:ceiling 门 + scope 门 → 有效工具面。越权项落到 `blockedByCeiling` / `blockedByScope`,**必须对用户可见**(fail-closed + 可见性)。
- **调用期** `authorizeCall(...)`:`kind`(写哪种记录)与 `target`(问谁)都是**调用参数**,求解期根本不知道 —— 把它们塞进求解期会得到一个「假装校验过了」的假门。

> **粒度是工具级,不是能力级。** `blackboard.read` 展开成 `board_list` + `board_read`;按能力授权会让「只想看列表」连带拿到「按 id 读任意工件正文」。

真正拦住一次非法调用的还有 `src/platform/tools/registry.ts` 的 `dispatch()`:工具存在吗 → 角色的 ceiling 给过吗(**再判一次**,因为会话可能是旧配置下建的)→ 调用期门 → 执行。

> **L2 集合文件现在真的有读者了(批次 19 接线)。** `bootPlatform` 把 `toolSetFor` 交给 `RuntimeDeps`,读盘在 `src/platform/harness/toolSet.ts`:`<dataDir>/harness/tools/{role}.json` 的 `allow` 在上界内**收窄**工具面,`deny` 优先。它**突破不了** `ROLE_SPECS` 的 `ceiling` —— 要放开上界仍然只能改代码。
>
> 坏文件**不会**被当成空 allowlist(那等于悄悄收回全部权限),而是退化成出厂行为(按 ceiling 全集)+ 在 `GET /api/harness` 与启动日志里如实报出。可见性的落点:`RoleHarnessView.toolSet`(`state` / `removedByToolSet` / `problem`)。

## 排空器:谁被唤醒(批次 21 重构,取代批次 20 的有状态级联)

**四个角色此前只有两个驱动者**:`host/serve.ts` 跑业务经理(用户消息触发)、`cli/run.ts` 跑 worker(手工 CLI)。`project_manager` 与 `quality_reviewer` **从来没有被叫醒过** —— 立项之后 `projects=1, works=0`,组织不动。

批次 20 用一个**有状态级联**补上了这件事(真机跑通),代价是六个补丁 —— 根因只有一个:把「刚才发生了什么」放在了内存里。批次 21 改成**无状态排空器**:

```
判定   collectTodos(db, projectId, now) → 可执行的待办清单    ← 唯一一处「下一步该谁跑」,纯查询
排空   drainProject(deps)             → 查到就跑到没有为止(硬上界 maxRounds)
触发   ① 事件 nudge(状态迁移后)  ② fixed-delay 定时器(默认 10s,兜底)
       两者都**不携带任何状态**,只说「现在去查一下」
```

**最关键的一条:事件只是 nudge,判定永远重新查库。** 不许有任何「刚才发生了什么」的内存传递 —— 那正是六个补丁的来源。

| 角色 | 待办判据 | 判据从哪来 |
|---|---|---|
| `business_manager` | 有人问它 / **有下游结果还没向甲方交代**(**且过了合并窗口**:攒够 N 条或最老的一条等到 T;失败与高危阻塞**绕过**窗口) / **甲方答复到了还没处置**(`resume_client`) / **有已验收交付物还没交付**(`handover`) / **这个项目没有一件没做完的事了**(`close_project`) | 库里的 `open` ask + **`dispatch_events`(outbox)里未消费的行** + `client_questions.consumed_at` + `project_sessions.deliverable_artifact_id` + `projects.status` |
| `project_manager` | 有人问它 / 有变更待评 / **项目零工作项** / **有工作项被派给了非 worker** / **有工作项停在 `failed`** → 重新划范围(`recover_failed_work`) | `pendingWork.ts` + `works` + `works.status='failed'` |
| `worker` | **分派给它、前置已满足、还没终态**的工作项 | `pendingWork.ts` 的 `myOpenWorks` |
| `quality_reviewer` | 有人问它 / 有变更待评 / **有做完但没审的产出** | `works.status='done' AND review_state='pending'` |

> ✅ **「等待审查」现在是库里的真状态**(`works.review_state = none | pending | done`,migration 013)。迁入 `done` → `pending`,质检回合**成功结束后**由平台置 `done`;维护点是 `works.status` 的唯一写口 `repo/works.ts` 的 `updateWorkStatus`。所以质检的待办就是**一条查询**,重启后补跑。批次 20 那句「不要把它写成一条 SQL 查询」随这次重构作废 —— 当时它是对的(语义为假),现在是假的(状态真的存在了)。

**触发/边界**:① 可能改变流水线状态的工具调用成功后敲门铃(清单在 `runtime/dispatcher.ts` 的 `NUDGE_CAPABILITIES`,挂在 `tools/registry.ts` 的 `dispatch()` 这个唯一漏斗上);② `host/serve.ts` 的 fixed-delay 定时器(默认 10s,`--dispatch-interval` 可配)兜底;③ **接待会话里那次立项不 nudge** —— 用户刚被切进新项目,还没看过目标就自动开工等于在他确认之前花他的 token。

**一定会停三层**:硬上界 `maxRounds`(默认 8,`--max-cascade-rounds` 可配)+ **尝试预算** `dispatch_attempts`(按 `(项目, todo_key)` 记账,默认 3 次;目标行动了就清零)+ **墙钟上界** `wallClockTimeoutMs`(默认 10 分钟,`--turn-wall-clock-ms` 可配)。到界 / 预算用尽**不静默**:广播 `cascade_stopped` + 落一条 `system` 会话消息(预算用尽只在**第一次**用尽时播报,否则每 10 秒一条也是静默)。

> ⚠️ **`maxRounds` 数的是「派发次数」,不是「跑了几个 agent 回合」**(2026-10-05 真机钉住)。
> 拒绝执行(`runWorkItem` 的 `checkRunnable` 判这条工作项不该跑)与建会话失败都算一次
> 派发,却**没有叫醒任何 agent** —— 真机那条告警写着「8 个 agent 回合」,而 8 次派发里
> 只有 **2 个真回合**(其余 6 次 33 ms 内返回,四个角色的 SDK 会话里连一条 prompt 记录
> 都没有)。所以 `DrainResult` 同时给 `rounds`(派发)与 `turns`(真跑起来),两者都进
> 告警文案与 `cascade_stopped` 载荷;空转的那几次逐条进告警(谁 / 哪条待办 / 为什么没跑
> 起来,`formatIdleTrail`,超 6 条折成一行计数)。**改文案时别再把 `rounds` 写成「回合」。**

> 前两层管「**还要不要叫醒**」,第三层管「**已经叫醒的那一个回合还能跑多久**」—— 一个回合卡在某个工具上时前两层都拦不住(它占着项目 busy 闩,而账本记的是次数不是时长;真机现场是一个 worker 回合跑了 16 分钟还在 `curl` 文档)。到点由平台 `AgentSession.abort()` **真的打断**,然后**按超时处置**:还没终态就记 `failed`(经唯一写口写出 `work_failed` 事件 → 业务经理的汇报待办),它自己已终态 / 已 blocked 就不覆盖。**为什么是 `failed` 而不是留在 `in_progress`**:留着 = 静默死(不在任何 outbox 事件里、会被反复叫醒直到预算用尽、然后永久停在原地),而每次叫醒再买一个完整的墙钟上界。**Wave 1 只做完了判定与打断,运行期吃不到它**(宿主没把 `ServeOptions.turnWallClockMs` 接出去,于是「我调了上界」与「它根本没生效」在真机上长得一样);Wave 2 把那条线接上了,而且**两条路都要接**(`runAgentTurn` 聊天那条 + `runWorkInSession` 执行那条 —— 只接前者等于没接)。

**合并唤醒:少打扰甲方的第二刀(判定侧的时机收窄)**。写入侧只对「根工作项终态 / 里程碑 / `work_failed` / high|critical 阻塞」写 outbox —— **但真机复核发现它在扁平结构下是空转的**:用户自己的库**当时**是 `9 work → 9 root → 0 中间`(⚠️ **2026-10-05 复核三次,形状每次都不同,所以别把它当常量**:`9 root` → `1 根 + 4 子` → **同一晚 W3-③ 实测是 `0 work / 0 项目 / 0 工件`**(该库被清过)。判据永远是那两条 `SELECT COUNT(*) …`,**结论不变**:按「是根」判会让扁平库里的每条真活失去执行者),而**运行期任务提示词里明写着要建树**(`runtime/dispatcher.ts:517-518` 的 `decompose_project` 正文:
「多件产出同属**一个交付物**时,用 `parentWorkId` 把它们挂到一条根工作项下面」),
真机库却仍是 `9 work → 9 root → 0 中间` ⇒ **不是「没人告诉它」,而是「告诉了没做到」**(§9.4 已按此更正归因)。于是每条工作项终态都是「根终态」,全部照写。

> ⚠️ **这条归因错过一次,教训值得留**:它最初写的是「`grep -rn parentWorkId harness/` 是空的,
> 没有任何地方告诉项目经理要建树」—— 那个 grep **作用域漏了运行期任务提示词**,而后者正是本文件
> 自己认定为最强的那条通道(user message,recency 比 system prompt 强)。
> **「grep 不到」不等于「不存在」;先问「还有哪条通道我没想到」。**
> 而且这个错**改变了该修什么**:「没人告诉」→ 再加一句提示词;「告诉了没做到」→ **合规校验/机制**。

所以 `collectTodos` 生成 `report_downstream` 时再加两个条件之一:**攒够 N 条**(`--report-batch-size`,默认 **3**)或**最老的那条等了 T**(`--report-max-delay-ms`,默认 **5 分钟**,它是延迟上界)。⚠️ `work_failed` 与 severity ≥ high 的 `blocker_opened` **绕过窗口立刻叫醒**(它们影响时间表,甲方要能据此重新决策)。判定侧收窄的是**时机**,不是**资格** —— 它不按 kind / 位置丢掉任何一行;而「没到阈值的行根本没被消费 ⇒ `consumed_at` 不因合并而撒谎」这条推理写在 `runtime/dispatcher.ts` 与设计 1 §9.4。

> 预算**不是**判据,是**限流**,而且与批次 20 的 `stallStore` 有两处本质区别:它在库里(重启后还算数);它**不需要状态指纹**(没有「指纹漏一类状态 → 把真实进展读成无进展 → 掐死整条链」这条失败路径,真机踩过)。宿主**不持有任何跨排空状态** —— `CascadeState` / `stallStore` / `projectSignature` / 「最后一格预算给汇报」全部已删除。

> ⚠️ **「有声明没读者」的东西要定期复核 —— 但复核的判据是「真机库里的形状」,不是「grep 有没有」。** 合并唤醒这一刀的**起因**正是复核发现的:`repo/works.ts` 写入侧有一套完整的「按工作分解树判可打扰」逻辑,而真机库 `parent_work_id IS NOT NULL` 的行数是 **0**。
>
> 判据:`SELECT COUNT(*) FROM works WHERE parent_work_id IS NOT NULL`。**不是** `grep -rn parentWorkId harness/` —— 那个 grep 当时漏了运行期任务提示词,让我把归因搞错了(见上)。

> 会话池的键是 `(上下文, agent)` 而不是上下文 —— 一个项目里四个角色各要一条自己的会话(工具面不同)。原先 BM 独占,键是 `string | null`。

### 对话是一等实体(2026-10-06,migration 024)

**用户原话**：「一个对话只能对应一个项目吗…… 我们需要支撑多对话对应一个项目的某个版本」

⚠️ **存储层早就支持多会话** —— `project_sessions` 上只有一条唯一索引,而它只约束接待会话。真正把模型钉死在 1:1 的是**上面四层**,024 只换了它们:

| 层 | 之前 | 现在 |
|---|---|---|
| WS `send` | 只带 `projectId`,前端**无法指定**发到哪条 | 带 `sessionId`(**可省** = 主对话) |
| 会话池键 | `(项目, 角色)` ⇒ 两条线共用一个 SDK 会话 | `(项目, **会话**, 角色)` |
| WS 事件 | 不带会话维 | 七条消息类事件**必填** `sessionId` |
| 前端 | 单指针,没有列表 | `SessionPicker` 页签 + 「另开一条」 |

**两条纪律**:
- **事件上的 `sessionId` 必填,`send` 上的可省** —— 事件漏传是「模型在 A 线说的话显示在 B 线面板」(**看不出来**);`send` 漏传是「落到主对话」(**看得见**)。
- **排空器触发的回合一律落主对话** —— 待办是**项目级**的,不属于任何一条甲方开的线。

⚠️ **一场交付 = 一条独立对话线**(`kind='thread'` + 名字取交付物标题)。真机上那个跑完的项目底下有 **8 条**会话(7 场交付 + 1 条内部)—— 全叫「主对话」时页签上是 8 个一样的标签。**存量行不重写 title**,读面用 `deliverable_artifact_id → 工件标题` 兜底(改存量 title 等于「为了好看去改事实」)。

## 收口之后还能说话(2026-10-06)

⚠️ **`serve.ts` 里那条 `code: "project_closed"` 硬拒已删**。它让项目收口之后甲方**连一句都发不出去**,项目成了只读墓碑 —— 而交付物全在库里,「这个项目到底做成了什么」恰恰是验收时要问的第一句。

现在分两层(`harness/authorize.ts` 的 `DIALOGUE_SURVIVES_CLOSURE`):

| 收口后 | 能力 |
|---|---|
| ✅ 仍然可用 | `project.read` / `project.open`(开下一个版本)/ `project.close` / `client.*` / `memory.*` |
| ❌ 被挡 | `project.update` 与 `work.*` / `collab.*` / `blackboard.*` / `change.*` / `blocker.*` |

**豁免的是「说话」,不是「改」。** 另:接待会话的 `renderProjectContext(null)` 从**空串**改成**列清单** + 新增 `project_list` 工具 —— 业务经理此前**没有任何一条路**能知道库里有哪些项目(`project_read` 要一个已知的 projectId,而那个 id 从哪来?)。

### 第 14 条规则 `recover_failed_work`(2026-10-06 真机停摆补)

真机现场(项目「美股自动化交易平台方案设计·单报告合并版」):一条 worker 工作项单回合读进
**109,231 token** 后撞上墙钟上界(10 分钟)被 `abort()` 打断,记成 `failed`。
`work_failed` outbox 被消费了(业务经理确实被叫醒、去向甲方交代)——**然后再没有任何人
被叫醒**。直接跑 `collectTodos`:`runnable: 0, exhausted: 0`。

⚠️ **`exhausted` 也是 0**:不是「试够了所以放弃」,是**没有任何一条规则提到 `failed`**
(`blocked` 有 `resolve_blocked_work`,`failed` 一条都没有)。而「零待办」与「组织已经把活
干完了」在日志里长得**一模一样**。

**为什么叫 PM 而不是让 worker 重跑**:`execution.ts` 的 `disposeTimeout` 注释已经写明
「一次卡到墙钟的回合,自动重跑只是把同一段卡死行为再买一遍」。真机那条正是如此:
目标太大(合并 7 份报告)⇒ 原样重跑会同样超时。**该做的是重新划范围**。

> ⚠️ **迁移表加了一条边**:`failed: ["in_progress", "cancelled"]`。
> 写完任务正文后查证发现**它让 PM 做的第一件事平台会直接拒** —— `failed` 原来只有
> `in_progress` 一个出边。而只留复活那条边会形成一个真实的坑:PM 拆完、活干完了,
> **旧的 `failed` 出不来** ⇒ 它永远停在那儿 ⇒ 规则一直叫到预算用尽,
> **而 PM 做完了正事却收不了尾**。
> 这与 `cancelled: []` 不冲突:后者说的是「`cancelled` 自己没有出边」(真终态、
> 不可复活),这里是「**可以走进来**」。判据不是「终态不许出去」,是
> 「**终态不许被复活**」。

真机复跑已验证:PM 22:58 把失败那条**退役成 `cancelled`**、按报告章节**拆成 4 条**
新工作项,worker 随即开跑第一条。

### 第 13 条规则 `close_finished_project`(2026-10-06 真机终局补)

真机现场(项目「美股自动化交易平台方案设计」跑完之后):11 条工作全 `done` +
全 `review_state='done'`、6 条 `review_verdict` 全 `pass`、outbox 空、
`openWorks/pendingQuestions/openBlockers/runningTurns` 全 0 —— **而 `projects.status`
永远是 `active`**。`project_close` 工具一直有生产调用方(`tools/project.ts`)却
**零自动触发**:11 条规则里没有一条管收口,`NUDGE_CAPABILITIES` 里也没有
`project.close`。**「代码里写了逻辑」不等于「它有读者」**(7-E 的复发)。

判据是**八件事同时不成立**(`runtime/dispatcher.ts` 的 `close_finished_project`):
非终态工作项 0 · 待审产出 0 · 未消费 outbox 0 · 等甲方的提问 0 · 未处置的答复 0 ·
未解决阻塞 0 · **已验收交付物 ≥ 1**(否则「工作项全 done 而甲方手上什么都没有」
不算完成) · 且**全部已交付**。全部只读结构化的列。

> ⚠️ **判据成立时不自动关闭,而是叫醒 `business_manager` 去判断** —— 收口不可逆
> (`closeProject` 对终态项目直接抛错、项目内能力随即失效),而「收不收口」是业务判断,
> 不是一行 `status` 能推出来的结论(§2.11.3)。终止判据 = `projects.status` 变终态
> ⇒ 落在一列上,重启后自动补跑、且**不会把已关闭的项目重新叫活**。
> 业务经理提示词(`business_manager.core.md`「最后一步」那一节)配套讲清
> **最终交付物是什么** —— 真机上「11 条全 done 而甲方要的那一份并不存在」过一次。


## 数据与存储

- 迁移在 `migrations/`:**007–010 建平台表**,**011 把旧系统的 7 张表 DROP**(`blackboards` / `conversations` / `messages` / `fragments` / `user_profile` / `agent_states` / `fragments_vec`),**012 接待会话**(重建 `project_sessions` 放宽 `project_id` 可空,已登记进 `INTENTIONAL_REBUILDS`),**013 排空器状态**(`works.review_state` + `dispatch_events` + `dispatch_attempts`,纯加法),**014 产出边**(`artifacts.work_id` + 一条部分索引,纯加法),**015 放宽 `dispatch_events.kind`**(加 `work_cancelled`;闭集**只能靠重建表**放宽,已登记进 `INTENTIONAL_REBUILDS`),**016 交付物 kind**(重建 `artifacts`),**017 交付会话**(`project_sessions.deliverable_artifact_id` + `channel`,纯加法),**018 `turn_usage` 表**(纯加法),**019 会话消息的封套**(`session_messages.origin_source` + `trigger_kind`,纯加法;两列各有自己的 CHECK),**020 `client_questions` 台账**,**021 `review_verdicts`**,**022 `session_messages.todo_kind`**(纯加法、**不建 CHECK** —— 取值域随 `TODO_KINDS` 变,闭集在读写两侧的 TS 里),**023 项目版本链**(`projects.version` + `parent_project_id`,`ON DELETE SET NULL`),**024 对话一等实体**(`project_sessions.kind` + `title`;`kind` **有** CHECK —— 两值闭集,与 022 相反),**025 交付物类型**(`artifacts.deliverable_type` + 一条部分索引,纯加法)。
- ⚠️ **`artifacts.work_id` 一条边承载两个语义**(「产出」∪「关于」,migration 014):worker 写 `evidence` 是产出,质检把 `review_finding` 挂到**被审的那条**上是「关于」。取「这条工作项交付了什么」必须自己区分(`runtime/execution.ts` 用 `work_id` + 作者 + `kind ∉ ABOUT_ONLY_ARTIFACT_KINDS` 三条判据);**不要删那些边** —— 它是 `review_finding` 唯一能表达「审的是哪一条」的地方。
- `artifacts` 直接挂项目 —— **没有 blackboard 容器层**。记忆在 `memory_fragments` / `memory_profile`,不是 `fragments`:`fragments` 是旧名字,001 已占用。
- 平台表**不得复用旧表名**:`CREATE TABLE IF NOT EXISTS` 撞名时静默无操作,新表根本建不出来(见下 §三类静默失败)。加表前先 `ls migrations/` 查名。
- 外键一律指向 `agent_id`,不存 `role` 字符串 —— 角色属性只有一处真相。
- 存储形态可替换:上层只依赖 `src/platform/memory/port.ts` 的 `MemoryPort`;甲方通道同理走 `src/platform/client/port.ts` 的 `ClientChannel`。

### 交付物**类型**(2026-10-07,migration 025)

用户原话:「定义一下交付物都有哪些类型,先实现一个最简单的,html 的报告(技术方案、架构图、
汇报材料等等,但凡是只有信息交付的,都可以用 html 产出),同时预留其他类型的交付物,比如说
git 仓库以及 git 仓库上的一些提交」。

**闭集 `DeliverableType` = `["html_report"]`**,在 `src/platform/storage/repo/artifacts.ts`
(与 `ARTIFACT_STATUSES` / `ARTIFACT_LINK_RELS` 同一个位置);契约侧同名联合在
`shared/types/platform.ts`。`board_write` 加了 `deliverableType` 参数。

⚠️ **三条纪律,三个不同的方向**:

- **`git_repo` 与仓库上的提交刻意不在闭集里。** 预留靠的是**结构**:`artifacts.deliverable_type`
  是一列(`kind='deliverable'` 的 1:N 属性),类型专属坐标落 `metadata_json`,按类型分派读法。
  加一种类型是**纯加法**:闭集 + 025 的 CHECK + `validateDeliverableBody` 加一条分支,
  **不改表、不改迁移、不动 `integrate` / `handover` 两条规则**(它们按 `kind` 查)。
  7-E 的病是「代码里声明了一个平台造不出来的东西」—— 提前把 `git_repo` 写进闭集,模型就会
  照着这个声明去 `board_write(deliverableType="git_repo")`。**闭集里每个值都必须有真的写入口。**
  `tests/platform/deliverable-types.test.ts` 有一条**故意现在就该红**的负样本盯着这件事。
- **`kind='deliverable'` 必须给类型,非交付物不许给类型。** 缺了就拒收并回灌闭集;
  多给了也拒收 —— 静默丢掉参数 = 替模型把它没做的事抹平了(7-D)。
- **交付物上的 `deliverable_type IS NULL` 是合法状态**(真机 23 条,全是 016 之后的 markdown)。
  读面**必须先看 `kind` 再看类型**(`web/src/lib/deliverable.ts` 的 `bodyMode`,有单测):
  把那 23 条当 `html_report` 渲染 = 23 片空白,而空白看起来像「平台坏了」。
  新写入被强制带类型,所以 NULL 只会减少;**不许为了「整齐」去改写历史行**。

**渲染面 = `<iframe sandbox="" srcDoc>`**(`web/src/components/deliverable/HtmlReport.tsx`),
不是 `dangerouslySetInnerHTML`:内容是模型写的 HTML,而模型会照抄它读过的东西(worker 抓来的
网页片段),「自己人写的」不能当安全依据。空值 sandbox = 脚本/表单/`allow-same-origin` 全关 +
不透明来源 ⇒ **结构性保证,不是过滤器**(与 `lib/markdown.ts` 选 micromark 而非 marked 同源)。
**「新窗口打开」是下载 `.html`,不是 `window.open`** —— blob URL 继承本应用来源。
写入层因此**拒绝**带 `<script>`/`<iframe>`/`<object>`/`<embed>` 的正文(≤512 KiB),
好让模型当场拿到可执行的处置,而不是甲方收到一页空白。

## 提示词(harness)

- 单元内容在 `harness/system_prompts/`,**12 个唯一单元**;构建时由 `scripts/copy-harness.mjs` 拷进 `dist/harness/`(出厂副本)。
- 运行时从**数据目录**读:`<dataDir>/harness/system_prompts/{unitId}.md`(`src/platform/runtime/promptAssembly.ts`)。
- 角色→单元的声明在 `ROLE_SPECS[].promptUnits`:4 个角色共 **15 处声明**、12 个唯一单元。跨角色共享的只有两个 —— `collaboration.ask`(3 个角色)与 `collaboration.convene`(2 个角色)。
- 系统提示 = 机械生成的角色简报(从 `ROLE_SPECS` 转写)+ 盘上真正装载到的单元。**盘上没有的单元如实报为 missing,不静默吞掉。**
- **工具集合文件**在 `<dataDir>/harness/tools/{role}.json`(L2;文件名必须正好是角色名,写错了不会被读取,成员页该角色的 harness 面板会把落空的文件名列出来)。读取 = `src/platform/harness/toolSet.ts`,对用户可见 = `GET /api/harness` 每个角色的 `toolSet`。**不提供写面** —— 直接编辑文件即可,改完不用重启(每个新会话现读一次)。

> ⚠️ **两个方向都不会自动同步(2026-10-05 实测,第二个方向此前没记)。**
>
> - **新数据目录**:用 `--data <临时目录>` 首跑时,`platform smoke` 会打印「声明了但盘上没有」,模型只拿到角色简报。要用新目录就先把出厂单元放进 `<dataDir>/harness/system_prompts/`。
> - **已存在的数据目录:改了仓库提示词、不做一次 reset,运行期一个字节都收不到** —— boot 既不播撒也不覆盖。实测 `~/.sansheng/` 有 4 个单元停在 W2 之前(`business_manager.core.md` 只有 39 行,出厂 215 行)—— **「仓库里写了」≠「模型收到了」**(7-B 的同款复发,只是这次断在部署那一步)。
>
> 写回走 `src/platform/harness/write.ts` 的写面(前端入口在成员页每个成员面板里的
  「角色 harness」折叠块,`RoleHarnessSection`;保存成功后它会通知页面把
  `useHarnessRoles({ revision })` 推一格 —— 否则页签角标会拿着旧数继续显示「N 处需要注意」):`POST /api/harness/units/:unitId/reset` → `resetPromptUnit`(校验 id → **备份** → 原子写 → 回读),备份落在 `<dataDir>/harness/backups/prompts/*.bak`。全量写回一次:`npx tsx .probe/w3-reset-prompts.mts <dataDir>`。
>
> ⚠️ **reset 之后要重启进程才对已存在的会话生效** —— 系统提示在**建会话那一刻**读盘一次,而会话池(`(上下文, agent)`)在进程活着时一直复用。实测:同一个进程里 reset 后再触发,系统提示仍是 **5722 字符**;重启后同一次触发是 **14340 字符**。上面「工具集合文件改完不用重启」同样只对**新会话**成立。

## CLI 与真机验证

CLI 只有 4 个命令(`--help` 自己看);**无参数 = 起平台服务**:

```
platform smoke      真 provider 建真会话,校验「声明 vs SDK 实际激活」,并列出缺失的提示词单元
platform-run        真跑一个工作项(**写真实数据目录**)
platform-serve      常驻宿主:HTTP + WS + 托管前端 + 排空定时器(默认 127.0.0.1:2719)
help
```

真机入口:`node dist/src/cli/index.js platform-serve --data <临时目录> --port <端口>`(provider 配置需把 `~/.sansheng/` 里的 settings 与 keyring 拷进临时目录),然后 `curl /api/health` 应返回 `{"ok":true,...}`。

> `package.json` 的三个入口(批次 19 修好,之前三个都指向不存在的文件/未知命令):`dev` = `dev:server`(`tsx watch src/cli/index.ts platform-serve`)+ `dev:web`(vite 5173);`start` = `node dist/src/cli/index.js platform-serve`。vite 的 `/api` 与 `/ws` 代理目标是 **2719**(`vite.config.ts` —— 曾错写成旧端口 2718)。

## 验证链(改完必须全过)

```
npx tsc -p tsconfig.server.json --noEmit
npx tsc -p tsconfig.web.json --noEmit
npm test                  # 1579 passed / 77 files
npm run build
npm run check:design      # 设计一致性 E1–E14
```

`check:design`(`docs/check-design-consistency.mjs`)校验两份设计文档之间的引用闭合:能力↔工具展开表、能力↔角色矩阵、writeKinds 合法性、文档声称的计数、跨文档 §引用。**改 `ROLE_SPECS`、`CAPABILITY_TOOLS` 或设计文档后它最可能红。**

## 编码纪律

- `grep -rn 'as any' src/ web/src/` 必须为 **0**。
- `as never` 目前有 **4 处**(3 个文件):`src/platform/infra/providers.ts` 那处是文档化的 generics collapse 例外;`src/platform/transport/http.ts` 与 `src/platform/transport/hub.ts` 里的是把**未校验的字符串硬塞进联合类型** —— 新增前先想清楚,别照抄。
- 需要类型收窄时写 module-level type guard,不要用断言糊过去。
- **不要改 `tsconfig.server.json` / `tsconfig.web.json` 的 `rootDir` / `include`** —— 会破坏 `dist/src/cli` 的 bin 路径。所有 dist 路径都含 `src/`(如 `dist/src/cli/index.js`)。
- server 侧**禁 value import** `@shared/*`(`import { X } from "@shared/..."` 会把 shared 拉进运行时依赖图);**type-only import 允许且推荐**。
- 引用 API 字段 / 函数签名前先 grep 源码或读类型定义,**不凭记忆**。

## 工作方式

### 决策自主

- **可逆、有依据的决策:直接做完再汇报,不要把选项抛回用户。**
- 准备抛 A/B/C 之前先跑 jev 闸门:`~/.dsh/skills/jev/scripts/jev.sh decide --state "<5 段写满>" --choice "..."`。`PROCEED` 就自己干,`ASK_USER` 才问。
- 只有四类才问用户:**不可逆操作、审美/主观偏好、只有用户知道的信息、高风险(资金/个人/团队)**。

### 委派

- 大的、bounded 的编码任务派 subagent;文档更新、小 refactor、验证类工作主会话直接做(委派 overhead 不值)。
- 委派 prompt 必须 **self-contained**:坐标(HEAD/基线)+ 做/不做清单 + 验证步骤 + 报告要求。
- **显式禁止 subagent 再派 sub-worker**(父等子 → idle watchdog 双杀的已知死亡模式)。
- 大任务要求第一件事 commit `wip:` 检查点;进程被杀 ≠ 任务失败,以 git 状态为准。
- 后台任务派出后不要 sleep 轮询,等完成通知,期间做其他独立工作。

### Git

- **push-first**:commit 后尽快推,不攒批。
- **git 是唯一进度真相**:DSH 的 `[running]` 不代表在干活 —— subagent 首轮 LLM 永不返回、状态永久 running、磁盘零落盘的情况已发生过三次。以 `git log` / `git status` / 落盘文件为准,不以进程或工具自述为准。

## 仍然成立的教训(与具体代码无关)

1. **改提示词前先确认它真的到达模型**(7-B:提示词「落地了但没人读」)。现在由 `src/platform/runtime/promptAssembly.ts` 装载 + `platform smoke` 的缺失单元告警承载 —— 但注意上面的新数据目录警告。
2. **「升级集合」与「解除架构约束」是两件事**(7-E 裁决):集合文件永远突破不了 ceiling。判定落在 `src/platform/harness/authorize.ts`,读盘落在 `harness/toolSet.ts`,接线落在 `runtime/boot.ts` 的 `toolSetFor`。
   **「代码里写了逻辑」不等于「它有读者」** —— 这套判定曾经完整、正确、**零生产调用方**,于是盘上那份 JSON 改了没有任何效果,而界面上只显示 ceiling,看不出来(批次 19 修掉)。
3. **`thinking` 与 `text` 必须是两条流**(7-I):判据写错会让内部推理被当成正式回复展示给用户。现在 `src/platform/runtime/turn.ts` 显式分开,事件类型见 `shared/types/platform.ts`。
4. **新写任何失败分支前先问:事后能不能从产物里看出当时发生了什么?**(7-N)。见不到的现场等于没有现场。
5. **失败必须留现场,且不要惩罚「不携带错误信息的偏差」**(7-D/7-M:模型只是把信封摆错了外层,拿「解析不出来」惩罚它等于因为没贴邮票就烧信)。

## 三类静默失败(真事故,永久警惕)

1. **`CREATE TABLE IF NOT EXISTS` 撞名时静默无操作** —— 新表根本不会建出来,报错落在下游(批次 5 真实事故:表没建成,错误报在索引上)。**加表前先查名。**
2. **shell `&&` 短路、`python str.replace` 不匹配都会静默不执行**,而你打印的成功信息会是假的。**追加 / 替换类操作必须逐项验证结果,不能靠退出码或自述。**(已复现:`"hello".replace("不存在的目标", "X")` 原样返回、脚本退出 0、一个字节都没改。)
3. **检查 / 脚本本身也会静默出错 —— 一个坏掉的检查不等于「检查失败」,它可能返回一个看起来正常的错误答案。**
   本项目的实例(2026-10-04 死文件检测,同一轮里错了两次):
   - **工具/模式选错**:用交替模式去判「有没有引用」,模式在该 grep 构建上不报错、也不匹配 → 静默 0 命中 → 报出「80 个文件全都无引用」。**那个结论是假的,而它长得像一次成功的检查。**
     ⚠️ 这条与机器有关:本机 `grep (BSD grep, GNU compatible) 2.6.0-FreeBSD` 实测**支持** `\|` 交替 —— 所以「换个环境跑同一条命令」也不能作为自检。
   - **模式写错**:第二次换了模式,依然返回自信的 0 命中(已复现:对已知含 `ROLE_SPECS` 的文件,把模式写成 `ROLE_SPECSX` 就得到 0,且没有任何错误)。
   - **静默不改**:`python str.replace` 找不到目标串时不报错、不写改动 → 你以为改了,文件其实没变。

   **做法:每个诊断先拿一个已知答案的样本自检 —— 一个必须命中的正样本 + 一个必须不命中的负样本。两个都对上,才用它去看别的。**
   判据不是「跑完了没报错」,是「它对已知样本给出了正确答案」。

## 明确不存在的东西(别再找)

- **路径**:`src/server/`(批次 19 已连空目录壳一起删掉)、`src/shared/jsonRepair.ts`、`shared/prompts/`(4 个 md / 536 行)、`scripts/diagnose.mjs` 与 `npm run diagnose`(批次 19 删)、`tests/agents|cli|server|shared|storage|tools/`、根目录的 ARCHITECTURE.md 与 PLAN.md(都已删除)。
- **角色**:communicator / planner / executor / critic / harness_manager / memory / reflection。
- **机制**:`ROLE_CEILING` / `FACTORY_SETS` / `LEGACY_TOOL_SETS` / `enabledTools` / `MessageBus` / `BlackboardScope` / `orchestrator` / `kernel` / `completeSimple` / `toolLoop` / `PI_OFFLINE` / `blackboards` 表 / `fragments_vec`。
- 这些名字在 `src/` 里**只剩注释里的历史说明**,没有任何活代码。看到它们说明你在读注释,不是接口。

## 历史文档(读之前先知道它描述的是什么)

- `README.md` 已于批次 19 **改写为现行系统**的说明(四个角色 / 2719 / `platform-serve` / 验证链)。它不再是历史文档。
- `docs/TROUBLESHOOTING.md` 已于批次 19 改成一份**「已失效」说明**:原文描述旧系统(读 `blackboards` / `conversations`,那两张表已被 `011_drop_legacy.sql` DROP),配套的 `scripts/diagnose.mjs` 与 `npm run diagnose` 已删除。**不要照着它排查**,它现在只做两件事:标出失效原因、把仍然成立的教训指回本文。原文逐字在 git 历史里:`git show e3d2812:docs/TROUBLESHOOTING.md`。
- `docs/PRODUCT-DESIGN-2026-10-02.md`、`docs/CODE-REVIEW-2026-10-01.md`、`docs/AGENT-AUDIT-2026-10-03.md`、`docs/SECURITY-NOTES.md`、`MIGRATION-HANDOFF.md` 是**带日期的历史记录**(描述当时发生了什么):里面的路径、测试名、表名多已不存在。当历史读,**不要当操作手册**;也不要改它们 —— 改了是篡改。
- `MIGRATION-HANDOFF.md` 是 pi → DSH 的迁移记录;`docs/pi-memory/` 是旧记忆全量归档。
