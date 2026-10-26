# AGENTS.md — Sansheng 项目工作规范

> 本文件是每个 DSH 会话**自动注入**的工作规范 —— 读它的人会照着做。所以这里的每一条事实都必须能用一个命令验出来;不确定的宁可不写。
> 描述的是 2026-10-04 清场之后的系统。旧系统(`src/server/**`)已于批次 15 整体删除,ARCHITECTURE.md 与 PLAN.md 随后一并删除:**本文没写的旧名字一律当作不存在**,不要从历史文档里往回找。

## 项目速览

- **Sansheng(三生)** = 单用户本机常驻 Node 服务:Pi SDK 驱动**五个角色的 agent 组织**,SQLite 持久化,HTTP + WS + 托管前端。
  **2026-10-08**:执行角色按**产出形态**一分为二 —— 原来的 `worker` 改名 `research_worker`
  **研究员**(交信息:文档 / 伪代码 / 架构图 / 汇报材料),新增 `coding_worker`
  **工程师**(交能跑的东西:可独立部署到 Docker 的**代码服务**)。
  ⚠️ **运行期的中文名以 `ORG` 为准 = 业务经理 / 项目经理 / 研究员 / 工程师 / 质检**;
  设计文档(`docs/DESIGN-AGENTS.md` 等)里那两个角色写作「研究工 / 编码工」——
  那是**文档对角色轴的称呼**,不是任何界面或提示词里的字。两处都是同一对角色。
- **组织架构是一等数据**:`agents` / `projects` / `project_assignments` 在库里,**角色属性在代码里**(`ROLE_SPECS`)。制品是工件(`artifacts` 表),不是聊天记录。
- 默认 `127.0.0.1:2718`;数据目录默认 `~/.sansheng/`,可用 `--data` 或 `SANSHENG_DATA` 覆盖。
- **「此刻」的读面只有一处**:`GET /api/projects/:id/live`(`ProjectLiveView`)—— 成员页的
  「正在做什么」与工件页产出图的「在跑」标记共用它。三个来源刻意分开:宿主内存的忙闩
  (`hub.runningTurns()`,重启即清零)/ 库里的工作项与 `collectTodos` 的待办 / 落库痕迹。
  `runtime: "unavailable"` 是**读不到**,不是「空闲」—— 前端不许把它渲染成后者。
  工件页的产出图靠 `ArtifactView.workId`(migration 014 的产出边)把工件挂回环节。
- **导航现在只有 6 个 tab**:对话 / 项目 / 工作项 / 成员 / 记忆 / 设置
  (判据是 `web/src/components/shell/TopBar.tsx` 的 `TABS`)。三次收编:
  **「工件」并入「工作项」**(`web/src/routes/Works.tsx`,2026-10-06)与
  **「Harness」并入「成员」**(`web/src/components/members/RoleHarness.tsx`,同日)。
  **「待办」页签也已删除**(2026-10-06):它是**唯一需要甲方动手**的数据,而甲方 90% 的时间在
  「对话」页 —— 现在长在对话页右下角(`web/src/components/client/ClientQuestionDock.tsx`)。
  **对话页右栏现在是三块**(2026-10-12,用户裁决把「待你验收」从项目页搬过来):
  `web/src/components/shell/ChatRightRail.tsx` = 「本项目」(`AgentPanel`)+
  「待你验收」(`AcceptanceDock`)+ 「待答」(`ClientQuestionDock`)。
  ⚠️ **三块共用**同一个 `useProjectDetail` 实例(hook 落在 `ChatRightRail` 里)——
  各自拉一份会让同一份数据一处写「加载中」、另一处写「没有」(回归
  `tests/web/acceptance-dock.test.ts` 钉住「四个文件里 `useProjectDetail(` 只出现一次」)。
  **「记忆」页三段是两套东西**:用户画像 / 记忆碎片(关于**用户**,模型写、会淡忘)+
  **知识语料**(关于**项目 / 组织**,平台索引、agent 只读 —— 见下「知识语料」一节)。
  **工作项页的信息顺序 = 依赖关系图 → 推进图 → 选中的环节**(前者**不折叠**,用户点名的顺序);
  推进图是时间轴泳道(`web/src/lib/timeline.ts`,纯函数:x = 时间,一条工作项一道、一种工件
  kind 一道;点绿色条 ⇒ 下面显示那条工作项挂着的工件),依赖图是分层 DAG
  (`web/src/lib/workGraph.ts`)。**成员页一个成员一块面板**(按角色页签切换):面板里有
  「正在做什么」(`GET /api/projects/:id/live`)、**「他说了什么」**(对话全文,进行中 +
  已完成;`GET /api/projects/:id/agents/:agentId/conversations`,见下专节)与他产出的工件;
  面板**之下另起一张独立的
  「角色 harness」卡片**(`Section` + 常显的状态摘要行 + 默认折叠的配置)—— 提示词单元的
  编辑 / 恢复出厂 / 备份数都在那里,写面四条规矩与后端一致。**未来角色 harness 的配置就放这张卡**。
- **平台记录的落点 = 项目页两段,按主体分家**(`web/src/routes/ProjectDetail.tsx`)。
  **「组织推进」**= 停止推进,带**派生状态**(已接回 / 会被接回 / 在等你 / 不会自愈 / 已收口 /
  读不到 ⇒ 判据在 `web/src/lib/orgState.ts`,事实来自 `GET /live` 与 `GET /messages`);
  **「合规记录」**= 不派生状态 —— 那一个回合确实没留工作记录,平台也不替模型补,
  **任何「已解决」都是编造现场**,它只能说「记录 · 不需要你动作」+ 计数。
  `session_messages` 里 `kind='system'` 的行**有四个生产者**,都在
  `src/platform/host/serve.ts`:`announceDrain`(停止推进,项目级)、
  `reportUnannouncedTurn`(合规告警,回合级)、
  `reportWorkspaceProblem`(**工作区告警**,项目级;首行前缀 `⚠️ 工作区`,
  只在「提交失败 / 有文件没进版本库」时发声,**同一条只播一次** —— 每回合重来一次
  会把「组织运行态」淹掉)与
  `announceProviderFailover`(**provider 降级**,项目级;首行前缀 `⚠️ 供应商`,
  2026-10-22 加 —— 见下面「provider 故障」一节),都落项目的**内部会话**,`agent_id` 为 NULL;
  分类只认**正文首行前缀**(`web/src/lib/platformNotices.ts`)。
  **对话页一个字都不留**(既不是气泡,也不再是一条「系统带」):`partitionTurns` 把它们摘成
  `notices` 计数,屏幕上只剩 `channelNoteText` 那一行「另有 N 条平台通知 —— 到「项目」页
  「组织运行态」查看」。别再把它渲染回对话页(**别再引回 `data-channel="system"`**),
  也别把「读不到」渲染成「空闲」。
- **依赖图的边方向 = 先后**(前置 → 本条;**子项 → 父项**,容器由子项推动)。这个方向是
  判据的一部分:同一对节点上两类边**方向一致**时不是环(真机那份数据就是这样),方向相反
  才是环(`mutualPairs` 会点名是哪两条边)。写反会让「交付」跑到最左、并且把一个不存在的
  环报出来(`web/src/lib/workGraph.ts` 的 `collectEdges`)。
- 基线:**2269 passed / 117 test files** · 两条 typecheck 0 error · `check:design` E1–E14 全绿(5 角色)。
- **角色中文名只有一处**:`src/platform/runtime/org.ts` 的 `ORG`(播种 / `roleDisplayName()` /
  `RoleHarnessView.displayName` / **系统提示里的「# 你的角色:X」**全走它);
  前端兜底表 `web/src/lib/vocab.ts` 的 `ROLE_LABEL` 必须逐项相同,由
  `tests/web/role-names.test.ts` 跨边界对照。**不许在任何地方再写一张名字表**
  —— 这条被违反过**三次**:harness 页写 `Worker(执行者)`、成员页写 `工程师`、
  前端兜底写 `执行者`;2026-10-08 又发现 `runtime/promptAssembly.ts` 里还藏着一张
  `ROLE_NAME`(把 `quality_reviewer` 写成**「质检审查员」**,而 `ORG` 是「质检」)
  ⇒ **已删,改成调 `roleDisplayName()`**。
  ⚠️ **那条哨兵当时是假通过**:断言写的是 `expect(brief).toContain(\`# 你的角色:${roleDisplayName(role)}\`)`,
  而 `"质检审查员"` **包含** `"质检"` —— 现在改成**逐字相等**(`toBe`),并带变异自检
  (把旧写法喂回去,它当场变红)。这是本项目第 3 类静默失败(坏掉的检查返回了看起来正常的答案)的一次复发。
- 日志只走 stdout:`~/.sansheng/logs/sansheng.log` 恒为 0 字节,别去 tail 它。

## 源码地图(`find src -name '*.ts' | wc -l` = 83)

```
src/cli/                 CLI 入口(index.ts + paths.ts)
src/platform/cli/        smoke / run 两个子命令的实现
src/platform/host/       常驻宿主:serve / scheduler / reset
src/platform/transport/  传输:http(API)/ hub(WS 广播)/ views
src/platform/runtime/    boot session turn execution assembly promptAssembly pendingWork
                         projectContext dispatcher org sdkAdapter rework
                         (rework.ts = 「退回给谁」的判据,质检返工与甲方拒收共用)
src/platform/tools/      工具层:14 个文件、41 个平台工具定义 + registry.ts 的 dispatch()
src/platform/mcp/        MCP:server 目录 / secret 存储 / 角色授权 / 求解 / pi 配置转换(见下「MCP」一节)
src/platform/codeservice/ 代码服务:port.ts(端口)+ git.ts(真实现,盘上核对仓库)
src/platform/harness/    授权:capability(能力↔工具表)/ authorize(三道门)/ toolSet(L2 集合文件读盘)/ write(提示词写盘)
src/platform/identity/   角色:role.ts 的 ROLE_SPECS
src/platform/storage/    db.ts + repo/ 下 15 个仓储(含 knowledge.ts / deliveryVerdicts.ts)
src/platform/infra/      keyring / settings / settingsApply / providers / migrations
src/platform/memory/     MemoryPort 端口 + sqlite 实现(**关于用户**,会淡忘)
src/platform/knowledge/  知识语料:切块 / 索引器 / 现读(**关于项目**,只读;见下)
src/platform/workspace/  工作区:root(项目根)/ git(提交·读·show)/ scan(目录观测面)/ port
src/platform/client/     ClientChannel 端口
shared/types/            跨端协议类型(platform.ts / settings.ts)
```

工具表合计 **48 个工具 = 41 平台 + 7 SDK 内置**,能力 **37** 条 —— 这几个数字由 `check:design`
(能力/工具)与 `tests/platform/client.test.ts` 的哨兵(已实现工具数)每次核对。

> **不要按「单向分层」的假设推理依赖方向。** 实测 `identity ↔ harness` 之间有**值级 import 环**(`src/platform/identity/role.ts` 从 `src/platform/harness/capability.ts` 取能力表,`src/platform/harness/authorize.ts` 从 `src/platform/identity/role.ts` 取 `ROLE_SPECS`),`transport` 也会向上引 `host`。这是现状,不代表可以随手加新的反向依赖。

## 改什么之前先读哪份文档

| 要改的东西 | 先读 |
|---|---|
| 结构、能力模型、授权、存储、运行时拓扑 | `docs/DESIGN-PLATFORM.md` |
| 五个角色的职责 / ceiling / 出厂集合 / 提示词单元 | `docs/DESIGN-AGENTS.md` |
| 会话在哪建、平台工具怎么变成 SDK 的 customTools | `docs/ADR-001-harness-wiring.md` |
| 当前进度与批次 | `HANDOFF.md` |

`docs/AGENT-AUDIT-2026-10-03.md` 是逐角色职能核查报告(旧结构,但角色职责部分仍有效)。

> 三份设计文档**有已知的与代码不符处**(例如 §8.1 的表名仍写成 `fragments`/`user_profile`)。**以代码为准,文档是意图**;改到相关结构时顺手把不符处改掉 —— 批次 19 顺手修掉了 §7.1 的 `RoleSpec` 形状(它写了一个代码里不存在的 `factorySet` 字段)与 §7.4 的闭合注册表名(`PROMPT_UNIT_IDS` / `TOOL_ROLES` → 实际的 `promptUnitIds()` / `PROJECT_ROLES`)。

## 五个角色

`PROJECT_ROLES` = `business_manager` / `project_manager` / `research_worker` / `coding_worker` / `quality_reviewer`。

- **只有 business_manager 是甲方接口**(`clientFacing: true`)。这是「甲方只与业务经理交互」的机器表达,是**代码内常量** —— 不入库,所以不存在被数据篡改的路径。
- 完整规格在 `src/platform/identity/role.ts` 的 `ROLE_SPECS`:`ceiling`(架构上界)/ `writeKinds` / `promptUnits` / `boundaryDeny`(**仅供 UI 展示,不参与授权判定**)。
- 出厂工具集**不另存名单**,由 `ceiling` 推导(`factoryToolset`)。增删角色 = 改联合 + `ROLE_SPECS`,一次显式代码评审。

### 两个执行角色(2026-10-08 拆分)

| 角色 | 交什么 | 交付物类型 | ceiling 的差别 |
|---|---|---|---|
| `research_worker` 研究员 | **信息**:技术方案 / 架构图 / 伪代码 / 调研结论 / 汇报材料 | `html_report` | 有 `code.read` + `code.exec`,**没有 `code.write`** |
| `coding_worker` 工程师 | **能跑的东西**:可独立部署到 Docker 的**代码服务**(git 仓库) | `code_service` | 三个都有(唯一差别就是 `code.write`) |

> ⚠️ **界面 / 提示词里的名字是「研究员 / 工程师」**(`ORG` 是唯一来源,见上)。
> 设计文档里写「研究工 / 编码工」—— 同一个角色轴的另一种读法,**不要**拿它去改代码里的名字。

> ⚠️ **`worker` 这个字符串在活代码与库里都不再存在**(026 把存量行改成 `research_worker`)。
> 唯一的痕迹是**历史迁移** `migrations/007_platform_core.sql` 的 CHECK(它给全新库建表,
> 026 紧接着重建掉)与几个 `tests/web/*` 夹具 —— 那些是历史,不是活代码。
> **判断「谁能执行工作项」只有一处判据**:`identity/role.ts` 的 `EXECUTOR_ROLES` + `isExecutorRole()`。
> 消费者**七个文件**(实测 `grep -rln 'isExecutorRole\|EXECUTOR_ROLES' src/`):
> `identity/role.ts`(定义)、`harness/authorize.ts`、`runtime/execution.ts` 的 `checkRunnable`、
> `runtime/pendingWork.ts` 的 `canExecuteWork`、`runtime/dispatcher.ts` 的
> `execute_assigned_work` / `fix_stranded_assignment`、`runtime/org.ts`、`tools/project.ts`。
> 七处必须用同一个答案 —— **别再写死一个角色名**:
> 硬编码 `role === "worker"` 在角色集变化时不会报错,只会让新角色**静默不工作**
> (「编码工怎么派都派不出去」)。
>
> ⚠️ **`deliverable` 这个 kind 从 2026-10-08 起三个角色都持有**(pm + 两个执行角色)。
> 理由:一份报告是研究工写出来的,一个代码服务是编码工做出来的 —— 执行者自己就是产出它的人。
> 质检仍然只能写 `review_finding`。

### 新增角色之后必须做的一件事:把组织补进**已存在的项目**

`ensureOrg` 管「组织里有哪几个人」,`ensureProjectOrg` 管「谁在哪个项目里」——**两张表**。
后者此前只在**立项那一刻**跑,于是新增一个角色对存量项目是**结构性不发生**的:
`cw` 建得出来,但不是任何已存在项目的成员 ⇒ `buildToolContext` 回 `agent_not_assigned`
⇒ 会话建不出来 ⇒ **它永远不会被派活**,而成员页只显示「这个项目里有谁」(少的那个只是不出现)。
⇒ `host/serve.ts` 启动时调 `syncOrgForExistingProjects(db, now())`。

⚠️ **它只补「一行都没有」的人,不复活被移出的成员** —— 否则「用户把某人移出项目」
这个动作会在下次启动时被静静撤销。回归:`tests/platform/org-sync.test.ts`(两个方向都有判据)。

⚠️ **`ensureOrg` 现在也校准 `display_name`**:`ORG` 是中文名的唯一来源,而库里那一行
此前只写一次、永不跟改 —— 026 把 `wk` 改成研究工之后,库里的名字还停在「工程师」,
与 `ORG` / 前端兜底表**当场漂开而没有任何检查会红**。

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
| `business_manager` | 有人问它 / **有下游结果还没向甲方交代**(**且过了合并窗口**:攒够 N 条或最老的一条等到 T;失败与高危阻塞**绕过**窗口) / **甲方答复到了还没处置**(`resume_client`) / **有定稿交付物还没交付**(`handover`) / **这个项目没有一件没做完的事了,且甲方全部验收过**(`close_project`,029) | 库里的 `open` ask + **`dispatch_events`(outbox)里未消费的行** + `client_questions.consumed_at` + `project_sessions.deliverable_artifact_id` + **`delivery_verdicts`(甲方裁决)** + `projects.status` |
| `project_manager` | 有人问它 / 有变更待评 / **项目零工作项** / **有工作项被派给了非执行角色** / **有工作项停在 `failed`** → 重新划范围(`recover_failed_work`) | `pendingWork.ts` + `works` + `works.status='failed'` |
| `research_worker` / `coding_worker` | **分派给它、前置已满足、还没终态**的工作项 | `pendingWork.ts` 的 `myOpenWorks` |
| **产出的作者**(执行角色或 PM) | **质检判了不通过**(`rework`)/ **甲方拒收了一份交付物**(`rework_rejected`,029)—— 目的地都是**产出的作者**,没有作者退 PM,第 3 轮起换人 | `review_verdicts` / `delivery_verdicts` |
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

**合并唤醒:少打扰甲方的第二刀(判定侧的时机收窄)**。写入侧只对「根工作项终态 / 里程碑 / `work_failed` / high|critical 阻塞」写 outbox —— **但真机复核发现它在扁平结构下是空转的**:用户自己的库**当时**是 `9 work → 9 root → 0 中间`(⚠️ **2026-10-05 复核三次,形状每次都不同,所以别把它当常量**:`9 root` → `1 根 + 4 子` → **同一晚 W3-③ 实测是 `0 work / 0 项目 / 0 工件`**(该库被清过)。判据永远是那两条 `SELECT COUNT(*) …`,**结论不变**:按「是根」判会让扁平库里的每条真活失去执行者),而**运行期任务提示词里明写着要建树**(`runtime/dispatcher.ts` 的 `decompose_project` 正文(`renderTask` 那一支,2026-10-08 实测在 `dispatcher.ts:2266`):
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

> 会话池的键是 `(项目, 会话, agent)`(`hub.ts` 的 `pooledKey`)—— 一个项目里五个角色各要一条自己的会话(工具面不同),而 024 之后同一个项目里还可以有多条对话线。原先 BM 独占,键是 `string | null`;哪条是主对话由 `project_sessions.kind` 认(`ensureMainSession`)。

### 「甲方问了但没得到答复」与「重启后模型失忆」(2026-10-07 真机事故)

真机现场(接待会话 `s_muxgek4p7ipeqcol`):甲方 09:53 问「docker 里量化系统怎么配
dev/prod + CI/CD」,09:54 业务经理只回了一句「我先看下你之前留下的偏好」,
**然后就没有然后了**;09:57 甲方问「然后呢」,业务经理回了一份「三个项目都已 done,挑一个」
的菜单 —— **从头到尾一次都没回应那个 CI/CD 问题**。两个独立缺陷叠在一起:

| | 缺陷 | 判据落点 |
|---|---|---|
| ① | **回合想完、工具调完,却没有正文** —— `stopReason` 正常是 `stop`,不抛错、不超时、不是中断,而 `text` 还有那 22 字开场白。平台侧**所有判据都通过**,于是没有任何东西会响 | `TurnResult.unanswered`(`runtime/turn.ts`) + `serve.ts` 广播 `unanswered_turn` |
| ② | **服务重启后模型失忆** —— SDK 会话纯内存,`~/.sansheng/agent/sessions/*.jsonl` 落盘了但**从不读回**;而对话页读的是库 ⇒ **屏幕上看不出断裂,只有模型知道**。真机:`ps` 显示服务 09:56:56 起的,而甲方第一条消息是 09:53:37 —— **第一回合跑在旧进程里** | `renderConversationHistory`(`runtime/turn.ts`),由 `getOrCreateSession` 的 `fresh` 决定要不要重放 |

> ⚠️ **①的判据是两条,不是一条。** 真机那次**有**正文(那 22 字开场白),所以「text 为空」
> 抓不到它。真正缺的判据是「**最后一次工具结果之后没有正文**」(`textSinceLastTool`)——
> 开场白在工具之前,不能算答复。**只用 `text === ""` 会漏掉真机这一形态。**
>
> ⚠️ **①的作用域只有 `trigger.kind === "user"`。** 排空器叫醒的回合**以工具收尾是正常的**
> (那是活干完了),在那里报「没下文」是把常态说成故障 —— **报多了就没人看了**。
> 超时 / 打断的回合**一律不报**:那两条路各有自己的现场与告警,再叠一句等于把一个已知
> 状态说成另一个。
>
> ⚠️ **不替模型补话。** 这里只报事实并让甲方重发,平台**不生成任何占位正文** ——
> 编一句「我还需要一些信息」是把一次失败说成一次澄清(7-D)。
>
> ⚠️ **②只重放一次**(`fresh === true` 时)。会话还活着时历史本来就在 SDK 那一侧,再塞一遍
> 就是让模型把同一段对话读两遍;`userMessageId` 还要**排除本回合甲方这一句**
> (`handleUserMessage` 是先落库、后跑回合)。只重放 `user`/`assistant` —— `system` 是平台
> 内部通知,摆给模型只会凭空多出平台自说自话的内容。
>
> ⚠️ **②为什么不走 SDK 的 `SessionManager.open`**:SDK 会话文件按时间戳命名,平台从来没记过
> 「哪个 `project_sessions.id` 对应哪个文件」,对上也对不上;**库才是这个平台自己的真相**
> (迁移表、接待会话的 `DELETE`、立项时消息迁移都在改它)。
>
> 回归:`tests/platform/unanswered-turn.test.ts`(16 条,含**负样本**——不误伤正常回合与
> 超时回合;以及**自检**——正负样本验证重放判据本身没坏)。

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
  ⚠️ **「主对话」= `kind='main'` 那条**(`ensureMainSession`):按 `kind` 认,不按 `channel`、
  更不按「谁最新」—— 2026-10-07「已交付却业务经理不给甲方回复」就是这里漂了。

⚠️ **一场交付 = 一条独立对话线**(`kind='thread'` + 名字取交付物标题)。真机上那个跑完的项目底下有 **8 条**会话(7 场交付 + 1 条内部)—— 全叫「主对话」时页签上是 8 个一样的标签。**存量行不重写 title**,读面用 `deliverable_artifact_id → 工件标题` 兜底(改存量 title 等于「为了好看去改事实」)。
⚠️ **交付线是「交付物的容器」,不是业务经理说话的地方**(2026-10-07):平台回合、播报、
未指定线的甲方消息都落主对话,否则第一条交付线一开出来甲方那条对话就再没人说话。

## 收口之后还能说话(2026-10-06)

⚠️ **`serve.ts` 里那条 `code: "project_closed"` 硬拒已删**。它让项目收口之后甲方**连一句都发不出去**,项目成了只读墓碑 —— 而交付物全在库里,「这个项目到底做成了什么」恰恰是验收时要问的第一句。

现在分两层,而**两层判的是不同的东西**(这里曾经把机制归属写混过,以代码为准):

| 层 | 判据 | 管什么 |
|---|---|---|
| `harness/authorize.ts` 的 `PROJECT_SCOPED_PREFIXES` | 能力 id 的**前缀在不在这个集合里** | 收口之后**还能不能调它** |
| `harness/authorize.ts` 的 `DIALOGUE_SURVIVES_CLOSURE` | **只有三项**:`project.read` / `project.open` / `project.close` | 上面那条的一处显式例外(「说话」类) |

| 收口后 | 能力 |
|---|---|
| ✅ 仍然可用 | `project.read` / `project.open`(开下一个版本)/ `project.close`;以及**前缀不在 `PROJECT_SCOPED_PREFIXES` 里**的那些 —— `client.*` / `memory.*` / `knowledge.read`(它们从来就没被收口挡过,不是靠 `DIALOGUE_SURVIVES_CLOSURE` 豁免的) |
| ❌ 被挡 | `project.update` 与 `work.*` / `collab.*` / `blackboard.*` / `change.*` / `blocker.*`(前缀在 `PROJECT_SCOPED_PREFIXES` 里,且不在上面那三项例外中) |

**豁免的是「说话」,不是「改」。** ⚠️ 另有一处**新的** `code: "project_closed"`
(`transport/http.ts` 的验收端点,029):它挡的是**给已收口项目补验收** ——
与那条被删掉的硬拒不是一回事(那条挡的是甲方说话,这条挡的是给一个已经生效的
不可逆结论补签)。 另:接待会话的 `renderProjectContext(null)` 从**空串**改成**列清单** + 新增 `project_list` 工具 —— 业务经理此前**没有任何一条路**能知道库里有哪些项目(`project_read` 要一个已知的 projectId,而那个 id 从哪来?)。

### 质检返工 + 两条兜底(2026-10-07)

> ⚠️ **下文按 `RULES` 的 `id` 说话,不按「第 N 条」** —— 序数会随增删漂
> (2026-10-08 加了 `rework_rejected_delivery` 之后,原来的「第 13/14/15 条」
> 全部平移了一格,而**没有任何检查会红**)。当前 `RULES` 与 `TODO_KINDS` 都是 **18** 条。

真机驱动:根工作项被质检**连续三轮 fail**,而 `turn_usage` 显示**三次审查之间一个执行回合都
没有** —— 两个缺陷叠加:`fail` 对**容器**是空操作(判 fail 走 `updateWorkStatus(in_progress)`,
而 `myOpenWorks` 排除容器 ⇒ 没人接手;工具当时对模型说的「原执行者会再跑一轮」是**假的**),
而每轮开头的 `closeIntegratedContainers` 又把它 8–16 秒内写回 `done` ⇒ 再审同一份没变的东西。
**修法不是「再退回一次」,而是让质检结论这条工件继续流转**(用户裁决:不搞「退回」概念)。
随后用户又提出兜底:「项目没有交付,且一段时间没有任何角色在干活,就去问问 PM 进度」——
**方向采纳、判据换掉**:不用「安静了多久」(墙钟启发式;批次 20 的 `stallStore` 正因此被删),
改用库里不需要猜的记录。

| 规则 | 判据(全是结构化列) | 叫醒谁 |
|---|---|---|
| `rework_failed_review` | 最近一次结论是 `fail` 且那之后这条工作项**自己**没有新产出 | **产出的作者**;没有自己的产出 ⇒ PM;第 3 轮起换人 |
| `escalate_abandoned_todo` | 账本 `notified_at` 非空(= 平台**真的停在那里**并播报过)且被放弃的待办**本来不归 PM** | PM —— **换手**,不是「再叫一次」 |
| `review_undelivered_project` | 项目 `active` + 工作项**全终结** + **零定稿交付物** + 真的安静(无待审 / 无 outbox / 无阻塞 / 无可整合的根) | 业务经理 |

⚠️ 后两条补的是**真空**:账本到顶在规则表里零读者(只有一条一次性 `system` 通知);而
「全终结 + 0 交付物」时收口要「定稿交付物 ≥ 1」、交付要「有定稿交付物」⇒ 两条都不成立。
⚠️ 兜底的命门是**乱响**:「安静」必须逐条排除「其实还有人在动」。完整叙事(两个缺陷的现场、
五处配套收窄、`superseded` 的边界、以及「为什么判据不能用墙钟」)在
`docs/DESIGN-PLATFORM.md` 的「质检返工与兜底」一节;**回归**:`tests/platform/rework.test.ts` ·
`tests/platform/stalled-project.test.ts`(17 条,四个变异自检)。⚠️ `rework_failed_review` 能走到真机,是因为
旧夹具是 `parentWorkId: null` 的「整合」—— **一个没有子项的「整合」**。

### 规则 `recover_failed_work`(2026-10-06 真机停摆补)

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

### 规则 `close_finished_project`(2026-10-06 真机终局补)

真机现场(项目「美股自动化交易平台方案设计」跑完之后):11 条工作全 `done` +
全 `review_state='done'`、6 条 `review_verdict` 全 `pass`、outbox 空、
`openWorks/pendingQuestions/openBlockers/runningTurns` 全 0 —— **而 `projects.status`
永远是 `active`**。`project_close` 工具一直有生产调用方(`tools/project.ts`)却
**零自动触发**:11 条规则里没有一条管收口,`NUDGE_CAPABILITIES` 里也没有
`project.close`。**「代码里写了逻辑」不等于「它有读者」**(7-E 的复发)。

判据是**八件事同时不成立**(`runtime/dispatcher.ts` 的 `close_finished_project`):
非终态工作项 0 · 待审产出 0 · 未消费 outbox 0 · 等甲方的提问 0 · 未处置的答复 0 ·
未解决阻塞 0 · **定稿交付物 ≥ 1**(否则「工作项全 done 而甲方手上什么都没有」
不算完成) · 且**全部已交付**。全部只读结构化的列。

> ⚠️ **2026-10-08(029)又加了三条**:`acceptancePending` 非空(已交付、甲方还没表态)
> 或 `rejectedDeliveries` 非空(甲方拒收、还没重交)⇒ 也不叫收口。所以判据现在是 **11 条**。
> 那三条读的是 `delivery_verdicts` —— 与「定稿」是**两件事**(见下「甲方验收」一节):
> 在此之前收口门读的是**作者自己写的** `accepted`,等于读申请人的自我声明。

> ⚠️ **判据成立时不自动关闭,而是叫醒 `business_manager` 去判断** —— 收口不可逆
> (`closeProject` 对终态项目直接抛错、项目内能力随即失效),而「收不收口」是业务判断,
> 不是一行 `status` 能推出来的结论(§2.11.3)。终止判据 = `projects.status` 变终态
> ⇒ 落在一列上,重启后自动补跑、且**不会把已关闭的项目重新叫活**。
> 业务经理提示词(`business_manager.core.md`「最后一步」那一节)配套讲清
> **最终交付物是什么** —— 真机上「11 条全 done 而甲方要的那一份并不存在」过一次。


## provider 故障:看得见 + 自动降级(2026-10-22 · 批次 30)

> **用户原话**:「sansheng 有时候会遇到断网、token 限流的问题,导致正在干活的角色失败」。

### 之前:三层都不管 provider,故障是**静默的**

| 层 | 之前是什么 |
|---|---|
| 重试 | **在 pi SDK 内部**(`dist/core/agent-session.js` 的 `_prepareRetry()`),判据是**错误文本正则**(`isRetryableAssistantError`),默认 `maxRetries=3, baseDelayMs=2000`(退避 2s/4s/8s),配置在 `<dataDir>/agent/settings.json` 的 `retry` 段(三生从不写它)⇒ **同一家重试,不换家**;错误文案不匹配正则时**直接失败不重试** |
| 平台 | **零** provider 故障处理。`src/platform/` 全仓无 retry / failover |
| 故障落地 | pi 把 429/网络错变成一条 `stopReason:"error"` 的 assistant 消息(**不抛异常**),`session.prompt()` 正常 resolve;而 `runtime/turn.ts` 的 `message_end` 分支**只读 `role/usage/model`**(`usageSnapshotOf`)⇒ **错误原文既不进日志、不进库、不上屏**。工作项因此永远停在 `in_progress` 装忙;聊天回合则被报成 `unanswered_turn`(「这一回合没有给出任何答复」)—— **把限流说成了「模型没说话」** |

⇒ 「代码里写了逻辑 ≠ 它有读者」的又一次:**故障是静默的**,而排空器的尝试预算(3 次)会在 45 秒内烧光,三次全打在同一个限流窗口里。

### 现在:三件事

**① 看得见 —— 分类器 `runtime/providerFailure.ts`**

`classifyProviderFailure(message)` ⇒ `{kind, retryable, message, status?, errorType?}`,`kind ∈ rate_limit | quota | auth | network | server | unknown`。

⚠️ **顺序是判据的一部分**:`quota` / `auth` 必须**先于** `rate_limit` 判 —— 否则 `429 insufficient_quota` 会被判成「可重试的限流」,于是平台去换一家 provider(而额度是账户级的,换家没用)。`quota` / `auth` 的 `retryable` 是 **false**。

⚠️ **原文是 JSON 信封,必须先剥**(`unwrapEnvelope`):真机原文 =
`{"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"}}`
—— 剥开后:**内层 message 的语义说了算**,内层 `type` 另存为 `errorType`(它可能与语义不一致 —— 只是线索,不是判据)。
⚠️ **剥信封不能把外层状态码丢掉**:网关的形状是 `{"type":"error","code":429,"error":{…}}` —— 外层 429 是**网关限流**,内层是服务端措辞;丢掉外层 ⇒ 内层没有状态码 ⇒ 退化成 `unknown`(不可重试)⇒ **不会降级** ⇒ 一次本可以换家的限流把活儿直接判死。⇒ `unwrapEnvelope` 现在返回 `outerStatus`,`status = parseStatus(lower) ?? outerStatus`。
⚠️ **`code` 是字符串时不是状态码**(OpenAI 的 `code: "insufficient_quota"` 是错误**类型**)⇒ 只认数字型的 4xx/5xx。

⚠️ **中文限额词必须进词表**:`用量上限` / `已达上限` / `积分不足` / `购买积分` —— 真机那条 429 里**一个英文额度词都没有**,只按英文词表判就会漏。

> 💡 **这条分类器的第一个真机样本,就是本批次自己的 worker 被打死的那一条**(2026-10-22):它烧掉 1.16M input / 223K output token 后撞上这条 429,`exit 0` 但只交出 1 个文件。⇒ **「provider 故障」不是假想需求 —— 它是在写这个机制的过程中当场发生的。**

`turn.ts` 的 `TurnResult` 加了两个**可选**字段 `providerError?` / `providerRetries?`;错误在 `message_end` 分支接住(⚠️ 只认 `message_end` —— 那是「事件时刻即终值」的那一条),并**不再判 `unanswered`**(同一个故障报两次 = 报多了就没人看了)。`providerRetries` 数的是 pi SDK 自己的 `auto_retry_start` 事件 —— 那一层重试原先**完全不可见**(界面上那句话会让人以为是「一次就挂」)。

**② 降级 —— 平台级换 provider**

`settings.providers[]` 本来就支持多 provider(`infra/settings.ts` 的 `ProviderConfig` / `activeProvider()`),但 `runtime/boot.ts` 只取 `activeProviderId` 那一个 ⇒ 限流时不会切。降级链是**平台级**的,不是 per-session:

- 候选 = `failoverCandidatesOf(providers, currentId, failedProviderIds)`(**纯函数**,`host/serve.ts`):除当前外的 provider,只留 `apiKey !== ""`、**有 env 凭据通道**(`providerEnvKey` 有映射)、`resolveModel()` 非 null 的,**轮转**(避免每次都打同一家);
  ⚠️ **「有 env 凭据通道」这一条是复核补上的**:三生的凭据**只**经 env 通道进 SDK(`syncActiveProviderApiKeyEnv`),`agentDir/auth.json` 三生从不写 ⇒ 没有 env 映射的 provider(`amazon-bedrock` / `azure` / `github-copilot` / `huggingface` / `openai-codex` / `typesafe`)切过去**必然也拿不到 key**(它只有 `log.warn`,不报错)⇒ 那次降级是白降,而且这一家被记进 `failedProviderIds` ⇒ **后面再也不会选它** ⇒ 一台本来能用的 provider 被一次无谓的降级废掉了;
- ⚠️ **忙闩检查**:`hub.runningTurns()` 里还有别的回合 ⇒ **不降级**。理由:`syncActiveProviderApiKeyEnv` 改的是**进程级 env**,在别的回合正跑时改会把它们打到 ⇒ **宁可这次失败,不要误伤别的回合**;
- 降级后 `disposeAllSessions()` —— 旧会话绑的是旧模型,继续用会把请求发到已经限流的那家;
- 降级**只发生在本回合没干过活时**(`turn.toolCalls.length === 0`):有工具调用就可能已有副作用(写文件、发消息、提交),**重跑不安全**;
- `quota` / `auth` / 回合超时 / 回合被中断 ⇒ **一律不降级**(超时那条纪律:「自动重跑只是把同一段卡死行为再买一遍」);
- 降级成功 ⇒ 工作项**不**记 `failed`,由排空器下一轮重新派发(工作项仍 `in_progress` ⇒ 仍在 `board.runnable` 里);
- 降级成功那一轮**不算失败**(`DrainTurnReport.failoverApplied` —— ⚠️ **别叫它 `providerFailed`**:那个名字挨着 `failed:false` 读起来像「provider 失败了」,而事实是「provider 故障了、但**有人接手了**」),且**重置这条待办的尝试预算**(`repo/dispatch.ts` 的 `resetAttempt`)—— provider 故障**不该烧掉**「叫醒 3 次」那个**给人用**的限流预算。
  ⚠️ `resetAttempt` 必须把 `notified_at` **一起清空**:灯亮着 = 这条待办已被判定为「叫不醒」(`escalate_abandoned_todo` 会据此把活儿换手给 PM)⇒ provider 故障降级成功之后那条活**仍然该由执行者接着干**。

**③ 有终态 —— 不再装忙**

不能降级时(没有备用 provider / 有副作用 / 鉴权或额度问题)⇒ 工作项经 `updateWorkStatus`(唯一写口)记 **`failed`**,自动写出 `work_failed` outbox 事件 ⇒ 业务经理向甲方交代,与墙钟超时那条路同一条纪律。
⚠️ **`updateWorkStatus` 的返回值不许丢**:它有三种「没成」(`ok:false` / `changed:false` / `deferred` 非空 = 事件 kind 没在 schema 里开)⇒ 日志断言「并写了一条 work_failed 事件」只在真的写了时才成立,否则那是一条**自信的假话**。

### 测试判据:变异自检要**真的**改坏一遍

分类器与接线测试(`tests/platform/provider-failure-classify.test.ts` 20 条 + `tests/platform/provider-failure.test.ts` 32 条)写完后**当场做了真变异**并实测变红:① `quota` 改成可重试 ⇒ 红;② 额度词排到状态码之后 ⇒ 红;③ 不剥 JSON 信封 ⇒ `errorType` 红;④ 剥信封丢掉外层状态码 ⇒ 红;⑤ `decideFailover` 三条纪律各去掉一条 ⇒ 红;⑥ 忙闩自我排除两个方向 ⇒ 红;⑦ 降级后不 `disposeAllSessions` ⇒ 红;⑧ 不记失败过的那家 ⇒ 红;⑨ 不过滤无凭据通道的 provider ⇒ 红;⑩ 不计 SDK 重试次数 ⇒ 红。

⚠️ **两次栽在同一件事上**(2026-10-22 复核):
- **「在语句前面加个注释」不是变异** —— `/*MUT*/ disposeAllSessions(...)` 里的注释**不会让语句失效**,调用照常发生 ⇒ 「改坏了却全绿」是假的,其实是「**根本没改坏**」。⇒ 变异必须**真的移除/改写**语句。
- **「assert 一下变异点找得到」不是可选的** —— `python str.replace` 不匹配时**静默不执行**、退出码 0、一个字节都没改(AGENTS.md 第 2 类静默失败)。⇒ 每次变异都要断言「改后那一行确实变了」。
⇒ 「测试是绿的」这句话在**变异实测过**之前不算数(第 3 类静默失败:一个坏掉的检查返回一个看起来正常的答案)。

⚠️ **夹具也会让断言失效**:夹具原来挑的备用 provider 是 `amazon-bedrock`(**无 env 映射**)⇒ 它被凭据通道判据排除 ⇒ 「切不回去」那条行为**根本不可能发生** ⇒ 断言它等于什么都没断言。⇒ 夹具挑 provider 时必须挑**真实可用**的那些。

### 前端零改动(两个「已有读者」的坐标)

- `error` 事件:`web/src/stores/chat.ts` 的 `case "error"` ⇒ `MessageList.tsx` 渲染 `error.code` / `error.message` ⇒ 新错误码 `provider_error` 自动上屏;
- 平台通知:`web/src/lib/platformNotices.ts` 的 `classifyPlatformNotice` 对不认识的前缀归 `other` 档、**正文原样渲染** ⇒ 新前缀 `⚠️ 供应商` 自动进项目页「组织运行态」。

⇒ **不许在前端加常量**(那会多一个没有读者的声明)。

### 还没做的(如实记)

- **限流全局刹车**:连续 429 时暂停排空器(而不是烧预算)—— 下一批的第一件事;
- **per-session provider**:降级是平台级的,一个项目里的所有会话一起换;
- **降级的 env 竞态**:忙闩检查覆盖了「别的回合在跑」这个窗口;`syncActiveProviderApiKeyEnv` 改的是进程级 env,理论上还有一个「回合刚开始、还没进 `runningTurns`」的窗口;
- **额度/鉴权不降级**:这是刻意的(额度是账户级的),但如果用户配了**另一个账户**的 provider,这条就不对了 —— 判据现在只看错误分类,不看 provider 归属;
- **降级落库可观测**:降级事实目前只落在 `session_messages`(一条 `⚠️ 供应商` 通知),**没有**结构化表 ⇒ 「这一周降级了几次、切了几家」无从统计(要读面就得 migration);
- **自动切回原 provider**:不做(要么靠健康探测、要么靠墙钟启发式,本项目两条都拒绝);
- **运行期证据**:`auto_retry_start` 只证到**源码级**(`agent-session.d.ts` 的事件定义 + `agent-session.js` 的发射点),**没做过一次真机 429**。

## 页面注解:出处进词汇表,不进悬停(2026-10-26)

用户要求「去除页面上面过多的注释」。处置与判据:

- **`hintTitle=` 这个 prop 已从 `web/src/components/ui/primitives.tsx` 删掉**
  (`Section` / `PageHeader` 现在收 `helpId?: GlossaryId`)。写 `hintTitle=` 会 typecheck 失败
  —— 判据是类型,不是约定。实施前实测 27 处,全部渲染成 `title=` 悬停(触屏不触发、不可复制),
  其中 13 条是「数据来源:GET …」= **出处**。
- **出处 / 判据只有一处**:`web/src/lib/glossary.ts`(18 条:`line` ≤ 24 字 + `basis` 判据落点
  + `source` 端点/表),由 `components/ui/Help.tsx` 的 `?` 呈现(button + 受控浮层)。
- ⚠️ **`?` 用 `button`,不许改用 `<details>`**:这套代码里 `<details>` 的约定含义是
  「可折叠的**内容**」,`tests/web/harness-by-role.test.ts` 用「第一个 `<details>` 之前」切
  卡片头、`artifact-timeline.test.ts` 用「这块里有没有 `<details>`」判「画布有没有默认收起」。
  第一版用 `<details>` 当场弄红 7 条已有判据 —— **该改的是实现,不是仪器**。
- ⚠️ **`hint` 的长短不是判据**。`hint="…GET /api…"` 这种「出处冒充一行话」才是错的;
  `CodeService.tsx` 里 30–74 字的技术事实必须留着。
- 哨兵:`tests/web/annotation-budget.test.ts`(11 条:悬停 0 处 · 出处不进 `hint` ·
  同一句话不许抄两遍 · glossary 每条都有读者),3 条变异实测变红。
- **四态只有一处写法:`web/src/components/ui/DataState.tsx`**(2026-10-26,Wave 0b)。
  `RemoteState<T>` 是 `loading | error | unavailable | ready` 四处联合,配两个构造器
  `remoteOf` / `remoteListOf`;**没拿到数据就拿不到 `children` 的参数**,所以「顺手渲染成空」
  在类型上写不出来。⚠️ **`unavailable` 不许并进 `ready`(会变成「没有」)也不许并进
  `loading`(会永远转圈)** —— 与 `ProjectLiveView.runtime = "unavailable"` 同一条纪律。
  已接:`AgentPanel`(详情)/ `AcceptanceDock`(待验收)/ `ClientQuestionDock`(待答)/
  `Members`(成员);回归 `tests/web/data-state.test.ts`(14 条)。
- **「关于」页 = 说明书的唯一落点**(2026-10-26):`web/src/routes/About.tsx`,三段
  (四态含义 / `GLOSSARY` 全表 / **已知不实之处**)。
  ⚠️ **它不是第七个页签** —— 导航恒 6 项,入口是顶栏末尾那个 `?`(`TopBar` 的 `NavTab label="?"`)。
  「已知不实之处」的数据在 `lib/glossary.ts` 的 `KNOWN_GAPS`(**每条必须带 `where` 落点**),
  现在 7 条(语料跨项目全局可读 · 成本无上界 · 进行中依赖 WS · 降级是平台级 · 降级无结构化记录 ·
  MCP 无界面且连接状态读不到 · 已收口项目的提问不再排队)。回归 `tests/web/about-page.test.ts`(12 条)。
- 变异自检脚本:`.probe/mutation-wave0b.py`(6 条,全部实测变红)。
  ⚠️ **它不用 `git checkout --` 复原** —— 新增文件还没入库时会报 `pathspec … did not match`,
  于是**变异留在盘上**、脚本自己崩。改成按内存里的原文写回 + 断言「复原后与原文逐字相同」。
  设计全文与剩余波次:`docs/DESIGN-FRONTEND-IA.md`。

## 实体脊:一份判据 + 一圈邻居(2026-10-26 · 前端 IA 重构 Wave 1)

**症状**:同一个工件在五个地方被说到,而改版前那五处**各写一遍**「类型 / 状态 / 作者 / 时间」
⇒ 同一个工件有五种说法,读者没法把两处的话对上。

**两份新文件,职责严格分开**(混在一起就会退化成「第二个事实来源」):

| 文件 | 职责 | 不许长成什么 |
|---|---|---|
| `web/src/lib/entityMeta.ts` | **判据**:一份输入 ⇒ 一组事实(`MetaItem` = 标签 / 值 / 邻居地址) | 一个 React 组件(它**不 import React**,纯数据 ⇒ 测试可直接断言) |
| `web/src/components/ui/MetadataStrip.tsx` | **排版**:把事实渲染成一条带子 | 第二个事实来源(它不许自己决定「作者是谁」) |

构造器:`artifactMeta(a, opts?)` · `workMeta(w)` · `blockerMeta(b, titles?)`;
地址构造器:`memberLocation` / `workLocation` / `artifactLocation`(页面**不许手拼**地址)。

**四条判据**

1. **标签是契约** —— 同一类实体在任何地方用**同一个词**(「作者」不写成「产出者」)。
   `tests/web/entity-meta.test.ts` 把三个标签数组**逐字快照**下来。
2. **邻居必须有地址** —— 「作者」「产出于」「父项」「卡住」指向**真的地址**。
   ⚠️ **地址由 `lib/route.ts` 的 `toHash` 序列化,断言的是 href 逐字相等** ——
   拼错了会指向别的东西,而**拼错与拼对在屏幕上长得一样**。
3. **拿不到就明说,不留空** —— 标题读不到退成 `id`;不由任何环节产出 ⇒「不由工作项产出」;
   顶层环节 ⇒「顶层环节」;阻塞没登记卡住谁 ⇒「没有登记卡住的工作项」(**不是 "0"**)。
4. **链接是真 `<a href>`** —— 用 `onClick` 改 hash 的话,「右键复制地址 / 中键开新标签 /
   浏览器后退」三件全消失,**而页面看起来一模一样**(M6 变红)。

**防腐坏的哨兵**(`tests/web/entity-spine-wiring.test.ts`,源码级):
① `authorName ||` / `assigneeName ||` / `raisedByName` **只允许出现在 `lib/entityMeta.ts`**
—— ⚠️ 挑「带兜底的写法」而不是字段名本身:字段名在**原始字段区块**与 SVG `title=` 提示里
**本来就该出现**,那两处是「原始坐标」不是「身份的说法」;禁掉它们会逼着人把原始字段藏起来,那比重复更糟;
② 三个页面(`Works` / `ProjectDetail` / `Members`)都用了 `<MetadataStrip`;
③ **每一处 `<MetadataStrip items={…}` 都必须来自 `entityMeta` 的构造器**(不许手写 `items`);
④ 页面里不许出现 `"#/members?member="` / `"#/works?work="` 这种手拼地址。

⚠️ **`Works` 的图节点悬浮提示也改用同一份格式化**(`authorLabelOf()`)——
一处 tooltip 自己写 `authorName || authorAgentId` 就是**多了一个事实来源**。

回归:`tests/web/entity-meta.test.ts`(14)· `tests/web/metadata-strip.test.ts`(6)·
`tests/web/entity-spine-wiring.test.ts`(5)· 变异 `.probe/mutation-entity-spine.py`(8 条,全部实测变红)。
**基线 2311 passed / 121 files**。设计全文:`docs/DESIGN-FRONTEND-IA.md` §3.3 / §8.7。

## 「一圈邻居」:关系也收成一份判据(2026-10-26 · Wave 1 第三步)

**症状**:「**它连着什么**」这件事**三处各写各的,而且没有一处能点** ——
工件卡片印 `关联 parent→art_x`(原始 id + 英文关系词)、工件详情一节「关联(N)」
(标题能读懂但**不是链接**)、工作项面板的「前置」是**纯文本**、成员面板**根本没有这一面**。

**两份新文件,职责与实体脊严格同构**:`web/src/lib/relations.ts`(判据,纯数据不 import React)·
`web/src/components/relations/RelationsRail.tsx`(排版)。

| | 身份条(`lib/entityMeta.ts`) | 关系栏(`lib/relations.ts`) |
|---|---|---|
| 答 | 这是什么 | 它连着什么 |
| 拥有 | 作者 / 产出于 / 负责人 / 父项 | 相关工件 / 子项 / 前置 / 阻塞 / 负责的环节 |

⚠️ **两者的关系类互斥** —— 同一个事实两处说 = 读者没法把两处的话对上。

**四条判据**

1. **组有三态**:`ready`(算出来了,**可能 0 条** = 「没有」这个事实)· `loading`(还在拉)·
   `unavailable`(拉失败 / **没接这份数据**)。⚠️ **后两者都不是「没有」** ——
   与 `DataState` 四态、`ProjectLiveView.runtime = "unavailable"` 同一条纪律。
   ⇒ 上下文里**没接**的那份数据(这一页没取阻塞列表)⇒ `unavailable`,不是「空」。
2. **地址是地址本身** —— 真 `<a href>`;**阻塞的地址必须带项目 id**
   (`blockerLocation(b.id, projectId)`)—— 阻塞只存在于**某一个**项目里,
   而「当前项目」是**全局选择** ⇒ 不带项目 id 的地址是**半个地址**
   (只在「你正好在看那个项目」时成立,而链接的用处恰恰是从别处跳过来)。
3. **拿不到就退成 id,不留空**;**不适用的组整组不出现**(那是事实,不是故障)。
4. **接线必须有哨兵** —— 判据写得再好看,页面上没有 `<RelationsRail` 就是**零读者**
   (M11 / M12 两条变异把两页的关系栏删掉 ⇒ 变红)。

### 顺带修掉的两个真 bug + 一个「两个真相」

| | 原来 | 现在 |
|---|---|---|
| `?blocker=` / `?project=` | **没人读** ⇒ 「指向空气的地址」:点得动、跳得过去、落点没有那条东西 | `ProjectDetail.tsx` 真的认(定位 + 高亮 + 深链接切项目) |
| 深链接 | `WorksPage` 挂载时 `setPicked(undefined)` ⇒ **`#/works?work=w_1` 一打开就被抹掉** | 判据在 `lib/route.ts` 的 `shouldClearSelection`:**首帧不清**、项目没变也不清 |
| 「当前项目」 | 工作项页有一个**页面私有**的 `scope` ⇒ 同一应用里**两个**当前项目 | 只有 store 那一个 ⇒ **从这里发出的链接不会落在别的项目里** |

⚠️ **「没人读的参数」是「指向空气的地址」** —— 症状是「点得动、跳得过去、就是找不到」,
而链接本身**看起来完全正常**。⇒ **凡是产出地址参数的地方,都要有一处真的读它**(哨兵钉住)。

**回归**:`tests/web/relations.test.ts`(23)· `tests/web/relations-wiring.test.ts`(12)·
变异 `.probe/mutation-relations.py`(**12 条全部实测变红**)。**基线 2346 passed / 123 files**。

## 项目页降级为「仪表盘」(2026-10-26 · §3.4)

**症状**:项目页**重复列**了工作项、提问、变更、阻塞 —— 与工作项页、成员页是**三份渲染、三份加载态、三份空态措辞**。
更要命的是「**最要紧的那件事**」这件事**没人判** —— 四段清单平铺,读者要自己比。
而平台手里明明有全部结构化事实(哪些阻塞是高危的、哪些问题在等甲方、哪些交付物还没验收)。

**两份新文件**:`web/src/lib/dashboard.ts`(判据,纯数据)· `web/src/components/dashboard/DashboardCards.tsx`(排版)。

**五条判据**

1. **「最要紧」是排序,不是评价** —— 档位顺序**写死一处**(`PRIORITY`):
   `next_unreadable` → `next_high_blocker` → `next_waiting_client` → `next_waiting_acceptance`
   → `next_stalled_work` → `next_running` → `next_none`。
   判据**全部来自库里读到的状态**,一条也不来自模型。
2. **读不到 ≠ 没事** —— 运行态读不到时第一档是 `next_unreadable`,**不是** `next_none`。
   症状最轻的写法是「此刻没有待办」—— 那是一句**自信的假话**
   (与 `ProjectLiveView.runtime = "unavailable"`、`DataState` 四态同源)。
3. **计数不许自己数** —— 数字读服务端算好的 `detail.counts`。
   自己数一遍会与左栏的徽标**漂开**,而「两个地方显示不同的数字」是最难查的一类病。
4. **一个实体只渲染一处** —— 项目页**删掉「工作项」那一段**;工作项**只住在工作项页**
   (那边有图、有依赖、有推进图)。⇒ 项目页在删掉清单之后**唯一**的「活儿」视图是
   **阻塞卡里的关系栏**(`subject={{ kind: "blocker", blocker: b }}` ⇒ 「它卡住的环节」)。
5. **每一张卡都是地址** —— 真 `<a href>`(右键复制 / 中键 / 后退三件全靠它);
   阻塞那张卡**必须带项目 id**(`projectLocation`),否则那是**半个地址**。

⚠️ **档位名带 `next_` 前缀是有意的** —— `web/src/lib/orgState.ts` 的派生状态里
**已经有** `waiting_client` / `unreadable` 两个同名键(那是「组织运行态」那一套)。
两套**不同的**状态机用同一批词 ⇒ grep 一次出来两个意思 ⇒ 前缀把它们隔开。

⚠️ **搬走一整段会有两个副作用**(两处都改了判据,不是仪器):
① `acceptance-dock.test.ts` 的「待验收计数留着」原来 grep `detail.counts.pendingAcceptance`,
   落点搬进仪表盘后写法变成 `detail?.counts.…`(因为 `useMemo` 跑在空值守卫**之前**)
   ⇒ 判据改成正则认两种写法,并在测试里写明**为什么改**;
② `annotation-budget.test.ts` 的 `work.status` 词汇条**没人读了**(7-E 的复发:搬走一整段 ⇒ 读者也走了)
   ⇒ 读者**搬到工作项页**(工作项现在只住在那儿),而不是删条目。

**回归**:`tests/web/project-dashboard.test.ts`(20 条)· 变异 `.probe/mutation-dashboard.py`
(**10 条全部实测变红**:M1 读不到当没事 · M2 严重度判据去掉 · M3 已解决也算未解决 ·
M4 地址丢项目 id · M5 档位顺序换 · M6 「没有」编一件充数 · M7 计数自己数 ·
M8 工作项列表复活 · M9 页面自己判档位 · M10 卡片不是链接)。
**基线 2366 passed / 124 files**。

## 数据与存储

- 迁移在 `migrations/`:**007–010 建平台表**,**011 把旧系统的 7 张表 DROP**(`blackboards` / `conversations` / `messages` / `fragments` / `user_profile` / `agent_states` / `fragments_vec`),**012 接待会话**(重建 `project_sessions` 放宽 `project_id` 可空,已登记进 `INTENTIONAL_REBUILDS`),**013 排空器状态**(`works.review_state` + `dispatch_events` + `dispatch_attempts`,纯加法),**014 产出边**(`artifacts.work_id` + 一条部分索引,纯加法),**015 放宽 `dispatch_events.kind`**(加 `work_cancelled`;闭集**只能靠重建表**放宽,已登记进 `INTENTIONAL_REBUILDS`),**016 交付物 kind**(重建 `artifacts`),**017 交付会话**(`project_sessions.deliverable_artifact_id` + `channel`,纯加法),**018 `turn_usage` 表**(纯加法),**019 会话消息的封套**(`session_messages.origin_source` + `trigger_kind`,纯加法;两列各有自己的 CHECK),**020 `client_questions` 台账**,**021 `review_verdicts`**,**022 `session_messages.todo_kind`**(纯加法、**不建 CHECK** —— 取值域随 `TODO_KINDS` 变,闭集在读写两侧的 TS 里),**023 项目版本链**(`projects.version` + `parent_project_id`,`ON DELETE SET NULL`),**024 对话一等实体**(`project_sessions.kind` + `title`;`kind` **有** CHECK —— 两值闭集,与 022 相反),**025 交付物类型**(`artifacts.deliverable_type` + 一条部分索引,纯加法),**026 执行角色一分为二 + 交付物类型加 `code_service`**(⚠️ **重建两张表**:`agents` 的 role 闭集 4→5 值并改名 + `artifacts` 的 `deliverable_type` 闭集 1→2 值;两张都登记进 `INTENTIONAL_REBUILDS`),**027 工件正文落文件**(⚠️ **重建 `artifacts`**:`body TEXT` → `body_path` / `body_sha256` / `body_bytes` 三列 NOT NULL + `commit_sha` 可空;登记进 `INTENTIONAL_REBUILDS`。**它故意不走「建 _new → 拷 → 改名」**:没有数据要拷(用户明确「老数据全不要」),而改名法会让「`artifacts` 被多个迁移创建」这条登记**当场过期**;数据安全改由一条会响的前置检查承担 —— `CHECK (n = 0)`,非空库上**响亮失败并整体回滚**,而不是静默清空)。
**028 知识语料**(`knowledge_chunks` + FTS5 `knowledge_fts` + 三个同步触发器,
纯加法;设计 `docs/DESIGN-KNOWLEDGE.md` —— **只读检索语料,不是记忆**,见下),
**029 甲方的验收裁决**(`delivery_verdicts`:append-only,`verdict CHECK IN ('accept','reject')`
+ `note` + 两条索引;**纯加法、不重建任何表** —— 见下「甲方验收」一节),
**030 语料分级**(`knowledge_chunks.tier`;**纯加法、可空、不建 CHECK**,与 022 同一条先例
—— 取值域在读写两侧的 TS 里;`PRAGMA table_info` 实测列已加)。
- ⚠️ **`artifacts.work_id` 一条边承载两个语义**(「产出」∪「关于」,migration 014):执行角色写 `evidence` 是产出,质检把 `review_finding` 挂到**被审的那条**上是「关于」。取「这条工作项交付了什么」必须自己区分(`runtime/execution.ts` 用 `work_id` + 作者 + `kind ∉ ABOUT_ONLY_ARTIFACT_KINDS` 三条判据);**不要删那些边** —— 它是 `review_finding` 唯一能表达「审的是哪一条」的地方。
- `artifacts` 直接挂项目 —— **没有 blackboard 容器层**。记忆在 `memory_fragments` / `memory_profile`,不是 `fragments`:`fragments` 是旧名字,001 已占用。
- 平台表**不得复用旧表名**:`CREATE TABLE IF NOT EXISTS` 撞名时静默无操作,新表根本建不出来(见下 §三类静默失败)。加表前先 `ls migrations/` 查名。
- 外键一律指向 `agent_id`,不存 `role` 字符串 —— 角色属性只有一处真相。
- 存储形态可替换:上层只依赖 `src/platform/memory/port.ts` 的 `MemoryPort`;甲方通道同理走 `src/platform/client/port.ts` 的 `ClientChannel`。

### 工作区:每项目一个仓,库里只存索引(2026-10-08 大批次)

**用户五条裁决**:① 按**项目**分文件系统(不按角色);② **不做归档动作**,用 git 管这个目录;
③ **数据库不存真实内容,只存索引**;④ `code_service` 直接**复用项目仓**(不再有独立仓库);
⑤ 交付口径 = 交付物是 `services/<name>/` 这个**构建上下文**,整仓对甲方可见(**透明交付**)。
配套约束:老数据一条不要 ⇒ **没有迁移、没有回填、一步到位**。

```
<workRoot>/projects/<projectId>/     ← 一个项目 = 一个 git 仓库
├── .gitignore / README.md           ← 平台在 project_open 时写并首次提交
├── artifacts/<id>-<slug>.<ext>      ← 工件正文(索引 body_path 指向这里,平台写)
├── work/<workId>/                   ← 派发工作项时建;绝对路径写进任务提示词
└── services/<name>/                 ← 代码服务(Dockerfile 在这里)= code_service 交付物
```

- **`sessionCwd(projectId)` 无条件**返回项目根;`isolateProjectCwd` 参数**已整个删掉**
  (接待会话 `projectId === null` 仍留工作根、不建仓)。全仓 grep 该名字只剩注释。
- **归属由 git 承载**:平台在**回合边界**做 housekeeping 提交(成功/失败/超时/被中断**四条路都做**),
  author = 角色中文名(`ORG`);次序 = 索引向盘收敛(重算 sha/bytes)→ 提交 → 按「HEAD 里有这条
  路径且哈希一致」回填 `commit_sha`。agent 自己提交代码(编码工要先提交服务目录,
  否则 `code_service` 的第 ⑦ 条会拒 —— 见上)。
- **提交失败 / 有文件没进版本库 ⇒ 可见**(`reportWorkspaceProblem` → 一条 `system` 平台通知,
  首行前缀 `⚠️ 工作区`,**同一条只播一次**)。闸门挡下的东西**不许静默**:秘密
  (`.env` / `*.key` / `*.pem` / `secrets/`)与超大文件(> 10 MB)**不提交**并逐条报出 ——
  交付口径是整仓可见,所以「没进去的」与「进去了的」必须长得不一样。
- **读面 `GET /api/projects/:id/workspace`**(`WorkspaceView`)= 盘上有什么 + 索引引用了什么 +
  两边对不对得上。**`runtime: "unavailable"` 是读不到根目录,不是空目录**;
  `missing`(**库里有、盘上无**)必须**逐条 `statSync`** 算出来 —— **不许**拿「本次遍历有没有列到它」
  当判据:遍历有深度 3 层 / 500 条上限,到界时一个真实存在的文件会被报成 missing,
  那是一句**自信的假话**(`tests/platform/workspace-scan.test.ts` 有两条负样本 + 变异自检钉住它)。
- **工件正文不再随列表返回**:列表给 `bodyPath` / `bodyBytes` / `commitSha`,
  正文走 `GET /api/artifacts/:id/content?at=<sha>` 现读。三态 **不是 ok 就都不是空正文**:
  `unavailable`(文件不在 HEAD / `at` 不可达)、`drifted`(盘上这份与索引记的不是同一份 ——
  人工改过,下一次提交重建索引收回一致)、提交不可达(`RepoCommitsView.runtime === "unreachable"`,
  与 `unavailable` **处置相反**:前者是「提交被 `reset --hard` 抹掉」,后者是「读不到盘」)。
  ⚠️ **回滚只许 `revert`,不许 `reset --hard`** —— 后者会让 `deliverableCommit` 变成不可达对象。
- **渲染面不变**:`HtmlReport` 仍走 `<iframe sandbox="" srcDoc>`,正文**先 fetch 成文本**再喂进去。
  ⚠️ **不许**改成 `<iframe src="/api/artifacts/:id/content">` —— 那让模型写的 HTML 与应用**同源**,
  `sandbox=""` 是结构性保证、不是过滤器。判据在 `tests/web/deliverable-render.test.ts`
  (**剥注释后**扫全 `web/src`,带正负样本与对真源码的内存变异自检)。
  ⚠️ 用裸 `grep '<iframe[^>]*src='` 复核会得到**假阳性**(它命中注释里的反面教材)——
  本文自己就踩过一次:原始 grep 报 3 处,剥掉注释后是 **0**。**错的是仪器,不是代码。**

### 知识语料:一份**只读**的检索语料,不是记忆(2026-10-08)

**用户裁决**:把「所有角色的对话 / 项目 / 工件 / 中间产出」做成一个**当 RAG 用**的只读语料,
**记忆保持老模式不变**。设计:`docs/DESIGN-KNOWLEDGE.md`。

判据与 `010_memory.sql` 开头那句同源(**会不会淡忘**):

| | memory(不变) | knowledge(新) |
|---|---|---|
| 关于谁 | **用户**(偏好 / 事实) | **项目 / 组织**(对话正文 / 工件正文 / 中间产出) |
| 谁写 | 模型(`memory_remember`,仅业务经理) | **平台**(确定性索引,**零模型调用**)—— 没有写侧能力 |
| 存储 | 库内 TEXT(`memory_fragments`) | **只有索引**:来源坐标 + 偏移 + `sha256` + bigram 列;正文留在原处 |
| 读口 | `memory_search` | `knowledge.read` → `knowledge_search`(目录级)+ `knowledge_read`(正文级) |

- **不复制正文**:工件正文在项目仓、消息在 `session_messages`,块表只存坐标 ——
  与「库只存索引」那条裁决同向,也避免第二份真相漂掉。
- **检索**:`seg` 列存 bigram(`src/shared/text.ts` 的 `indexTerms`,与记忆的 `tokenize` 同一套切法)+
  FTS5 外部内容表。⚠️ **中文直接上 FTS5 是假命中 0**(unicode61 把整段 CJK 当一个 token;
  trigram 对 1–2 字查询也是 0)—— 实测正负样本在设计 §4,回归在 `tests/platform/knowledge.test.ts`。
- **触发全是平台侧的**:回合边界 `housekeepingCommit` 重扫本项目 + 宿主启动 `reindexAllKnowledge`。
  **幂等**(`(source_kind, source_id, seq)` + `sha256`);**读不到不许删已有块**(读故障 ≠ 语料丢失),
  工件数撞 500 单次上限时**跳过按来源对账并如实报出**。
- **分级(tier,030)**:每条块带 `primary`(定稿类工件 / 甲方原话)或 `material`
  (`evidence` / `hypothesis` / `note` / `review_finding` / assistant 叙述 / **未知 kind**);
  检索**排序**改成「tier 优先,同 tier 内保持 bm25 顺序」—— **降权不是过滤**,
  `material` 仍然检索得到。幂等判据从「只有 `sha256`」改成「`sha256` **和** `tier`」,
  否则正文没变的存量行**永远**停在 `NULL`(重扫补上,块 id 不变)。
  ⚠️ **平台判定的是「定稿 vs 原始材料」,不是「内容从哪来」** —— 语料只收工件正文与
  `user`/`assistant` 消息(工具结果根本不进语料),「worker 把抓来的网页粘进产出」在库里
  与「它自己写的段落」长得一样。**任何声称「已识别外部内容」的字段都是假话。**
- **可见性缺口如实记**:P1 是**跨项目全局可读**,没有 `tainted` / scope 列(闭集里每个值都要有真写入口)
  —— 那是 P2 第一件事(设计 §7/§8)。**tier 是排序权重,不是可见性边界**:
  跨项目全局可读这件事一个字没变。收口之后 `knowledge.read` **仍然可用**(与 `memory.*` 同理)。
- **读面(2026-10-08 补)**:记忆页第三段「知识语料」= `GET /api/knowledge`(量级 / 时效 /
  机制状态)+ `GET /api/knowledge/chunks?q=&projectId=&limit=`(`q` 有值=检索、没值=按时间浏览)。
  状态判据在 `web/src/lib/knowledgeState.ts` 的 `corpusStatus`(纯函数 + 单测):
  **读不到 > 索引与行不一致 > 空 > 落后 > 正常**;`runtime: "unavailable"` **不是**「0 条语料」。
  同目录的 `.probe/knowledge-peek.mts` 是不开服务时的 CLI 查看器(会写库,先拷数据目录)。

### 「待答」队列:**收口项目的提问不是待答**(2026-10-07 真机事故 · 显示口径 2026-10-12 改)

用户报的现象是「待答没有区分项目,A 项目的待答在 B 项目的对话里也看得见」。查下来
**当时的跨项目显示是有意的**(`ClientQuestionDock` 给别的项目那条带一行暗色项目名),
**但那 3 条之所以能常驻,是因为它们兑现不了** —— 这是缺陷。
⚠️ **前半句已于 2026-10-12 被用户推翻**(见下),推的是**显示口径**,不是收口那三条的处置。

真机现场:项目「美股自动化交易平台方案设计·单报告合并版」**00:27 收口**(`done`),
业务经理在**收口之后 8.5 小时**(09:03 / 09:13)又提了 3 个问题。三件事凑成一个
**兑现不了的承诺**:

| | 事实 | 位置 |
|---|---|---|
| ① 提得到 | `PROJECT_SCOPED_PREFIXES` **不含 `client.`** ⇒ 收口后 `ask_client` 仍可用 | `harness/authorize.ts:129`(**有意**:「豁免的是说话,不是改」) |
| ② 没人处理 | 排空器排的是 `listProjects(db,"active")` ⇒ **终态项目永远不进排空器** | `host/serve.ts:1969`(`drainAll`) |
| ③ ⇒ | 用户点「回答」只会多落一条 `decision`,**没有任何人会被叫醒**,而这一条仍然挂着 | `POST /api/client-questions/:id/answer` |

⇒ 「待答」承诺的是「你答了会有人处理」。**兑现不了的队列不是队列,是看起来很正常的噪音** ——
它与「有人欠你三个回答」在屏幕上长得一模一样。

**处置**(`listAllClientQuestions`,2026-10-07):收口项目(`done`/`abandoned`)的提问**不进队列**,
但**条数必须说出来**(`fromClosedProjects` 与 2026-10-12 补的 `closedProjectQuestions`
**同源**,见上面那段)——「另有 N 件来自已收口,不再等回复」。
⚠️ **事实一条都不删**:工件与 `client_questions` 行原样在库里,**项目页那个读面照常显示**
(真机复核:全局队列 `0 条 / fromClosedProjects 3`,项目页 `pendingQuestions 3`)。
`paused` **不算**收口 —— 排空器还会叫它。

> ⚠️ **「别改回只显示当前项目」这条已被用户推翻**(2026-10-12,原话:「在显示层面也
> 区分一下项目吧,就像是待你验收一样,只有切换到这个项目下才能看到」)。当年那条理由
> (「别处的提问重新变成没人知道」)本身没错,但它是**默认口径**的代价,而用户要的不是
> 默认口径。
>
> **现在的形状:接口仍然全局,筛选在显示层。**
>
> - `GET /api/client-questions` **仍然一次给齐所有项目** —— 筛选是**显示口径**,
>   不是数据面的隐藏;别处要用、要审计的都还拿得到。⚠️ **别把它顺手挪到后端**
>   —— 那会让「本项目有几件待答」这种问题**无接口可问**。
> - 显示层那道筛是纯函数 `web/src/lib/questionScope.ts` 的 `scopeClientQuestions()`
>   → 切到哪个项目才显示哪个项目的;`projectId === null`(接待会话)**返回空**
>   而不是「全部」—— 悄悄退化成全局面板 = 上面「本项目一切正常」下面挂着别的项目的提问,
>   而且是**默默地**回来的。
> - **不藏的补偿是左栏**:`HistoryRail` 的项目节点带 `counts.pendingQuestions`
>   (`HistoryRail.tsx:125`),「待你回答 N 个问题」标在**项目名下** ⇒ 别的项目有 N 件,
>   仍然看得见、也知道去哪儿点。
> - ⚠️ **随之多出来的那个真问题**:收口那批原来报的是**全局**计数,按项目显示之后
>   它会把别的项目的条数报在当前项目名下。后端因此补了 `closedProjectQuestions`
>   (带项目坐标的同一批,**只数不渲染** —— 渲染了就是给一排点了也没人处理的按钮),
>   显示层从那一份里数出**本项目**的条数。
> - 回归:`tests/web/question-scope.test.ts`(12 条,含三处判据自检)+
>   `tests/platform/client-question-closed-project.test.ts`(12 条,含「排空器只跑 active」
>   那条源码 grep,带正负样本自检)。

### 成员页「他说了什么」:按 agent 看**对话全文**(2026-10-26)

**用户原话**:「我想看看每一个agent 进行中、已完成的具体的对话内容,只读就好了,
在成员的这个页面中新增这项功能」。

改之前,成员面板里那块叫「他产生了什么对话」,接的是
`GET /api/projects/:id/member-conversations` 的一组**摘要**:每条**截到 90 字**、
**新的在前**、默认折叠。那是**清单**(谁说过几条),不是**内容**。

现在那一块叫「他说了什么」,长在成员面板的第③块
(`web/src/components/members/AgentConversations.tsx`)。

| 两个读面 | 谁用 | 答什么问题 |
|---|---|---|
| `GET /api/projects/:id/member-conversations` | 只剩页面底部「不在成员表里的发言」(`strangers`)+ 页签角标 | **谁**说过话、各说了几条 |
| `GET /api/projects/:id/agents/:agentId/conversations?sessionId=&limit=` | 成员面板 | **这个人具体说了什么**(逐条对话线 + 选中那条线的**全文**) |

⚠️ **`MemberPane` 的 `conversation` / `conversationError` 两个 prop 已删** ——
读者(那块摘要列表)不在了;留着就是死参数。`ConversationCard` 与
`useMemberConversations` **保留**:`strangers` 那一段还在用它们。

**后端两条判据**(都在 `src/platform/transport/http.ts` 的 `agentConversations`):

- **`messages` 只有两类**:① 他自己的发言;② **甲方在同一线上的话**。
  别的角色的话不在(那在它们自己的面板里),**平台通知(`kind='system'`)也不在**
  (那在项目页「组织运行态」)。⚠️ 甲方的话与平台通知在库里都是 `agent_id IS NULL`
  ⇒ **必须靠 `kind` 分开**;只按 `agent_id` 过滤会把平台通知端上来。
- **条数是 SQL `GROUP BY` 的真值**(`countAgentSessionLines`),`messages` 是一**页**
  (默认 200 / 上限 500)。两者混在一起的那一版会在消息一多时**静默少数** ——
  而少数的那一版和正确的那一版在屏幕上长得一模一样(与 `memberConversations` 同一纪律)。
  截断标志用 **`limit + 1` 多取一条**判:`rows.length === limit` 会把「**恰好** limit 条」
  误报成被截断,而「这一页里还含甲方的话」也会让它与线头的 `messageCount` 对不上。

⚠️ **窗口取的是最近 N 条,交回去必须倒回正序**(旧 → 新)。切尾巴要从**末尾**切
(`slice(len - limit)`):仓储层交回来的已经是正序,`slice(0, limit)` 会把窗口变成
「最早 N 条」—— 这条是本次实现的第一个 bug,回归钉住了它(正负样本各一)。

**「进行中」的数据源 = 前端 WS 的**在飞轮**(
`web/src/stores/chat.ts` 的 `inFlight`,按 `projectId + agentId` 过滤)。
**没有**用忙闩(`hub.runningTurns()`):它答的是「**有没有回合在跑**」,不带
`sessionId` 也不带内容 —— 用它只能显示一个「在跑」的灯,给不了「他在说什么」。
⇒ **代价要说清**:WS 断流时那一块会空,界面如实写「进行中的内容只在它正在跑的时候
看得见」,而**已完成的那部分照常显示**(它来自库,与 WS 无关)。

⚠️ **「读不到」与「还没查过」都不许长成「共 0 条」** —— 三态在界面上必须不同:
`读不到` / `正在读取…` / `共 N 条`。这三支由 `AgentConversationBody` 的 `known`
判据承担,**同一个不变式在两处被断言**:行为副作用在
`tests/web/members-conversations.test.ts`,源码级接线在
`tests/web/c10-dead-code.test.ts`(那条「错误要传下去」的断言 2026-10-26 换了落点,
判据一个字没改)。

⚠️ **落库的只有回合的最终正文**:工具调用与思考**不进 `session_messages`**
(库里只有 `user` / `assistant` / `system` 三种 kind)。所以「已完成」看到的是
**那个回合说了什么**,不是全过程流水;「进行中」才看得到思考块与工具名。
界面上这两件事分开显示(`liveTurnParts`),与 7-I「`thinking` 与 `text` 是两条流」同源。

回归:`tests/platform/agent-conversations.test.ts`(12 条)·
`tests/web/members-conversations.test.ts`(14 条)·
`tests/web/members-activity.test.ts`(适配新 prop,40 条) ·
变异自检 10 条全部实测变红(`.probe/mutation-agent-conversations.py`,每条都断言
「改后那一行确实变了」)。

### 交付物**类型**(2026-10-07 / 2026-10-08,migration 025 / 026)

用户原话(2026-10-07):「定义一下交付物都有哪些类型,先实现一个最简单的,html 的报告(技术方案、
架构图、汇报材料等等,但凡是只有信息交付的,都可以用 html 产出),同时预留其他类型的交付物,
比如说 git 仓库以及 git 仓库上的一些提交」。

用户原话(2026-10-08):「加一个新的交付物类型,叫做**代码服务**,这个是一个 git 仓库,然后这个
仓库可以**独立部署到 docker 上面**」。

**闭集 `DeliverableType` = `["html_report", "code_service"]`**,在
`src/platform/storage/repo/artifacts.ts`(与 `ARTIFACT_STATUSES` / `ARTIFACT_LINK_RELS`
同一个位置);契约侧同名联合在 `shared/types/platform.ts`。`board_write` 的
`deliverableType` 参数不变。

⚠️ **四条纪律,四个不同的方向**:

- **加一种类型的判据是「有没有真的写入口」,不是「该不该有名字」。** `git_repo`、仓库上的
  某几个提交、镜像、部署实例**都还不在闭集里**;`code_service` 在,因为它的写入口**带现场核对**
  (见下)。7-E 的病是「代码里声明了一个平台造不出来的东西」—— 提前写进闭集,模型就会照着
  这个声明去 `board_write`,然后拿到一条「还没实现」的错误。**闭集里每个值都必须有真的写入口。**
  预留靠的是**结构**:`artifacts.deliverable_type` 是一列(`kind='deliverable'` 的 1:N 属性),
  类型专属坐标落 `metadata_json`,按类型分派读法。
- **`kind='deliverable'` 必须给类型,非交付物不许给类型。** 缺了就拒收并回灌闭集;
  多给了也拒收 —— 静默丢掉参数 = 替模型把它没做的事抹平了(7-D)。
- **交付物上的 `deliverable_type IS NULL` 是合法状态**(真机 23 条,全是 016 之后的 markdown)。
  读面**必须先看 `kind` 再看类型**(`web/src/lib/deliverable.ts` 的 `bodyMode`,有单测):
  把那 23 条当 `html_report` 渲染 = 23 片空白,而空白看起来像「平台坏了」。
  新写入被强制带类型,所以 NULL 只会减少;**不许为了「整齐」去改写历史行**。
- **两个类型的正文语义不同**:`html_report` 的正文**就是交付物**(一份 HTML 文档),
  `code_service` 的正文只是一份 markdown 说明,**主体是 `metadata_json` 里的仓库坐标**。
- ⚠️ **`artifacts.status='accepted'` 读作「定稿」,不读作「甲方验收了」**(2026-10-08,029)。
  它由**作者**写(`board_write` 的 `status`)= 「我整合完了、可以交出去了」;
  甲方收不收是**另一张表**(`delivery_verdicts`,只有 HTTP 面能写)。见下「甲方验收」一节。

#### `code_service` 的写入口 = 平台**当场去盘上核对**

⚠️ **2026-10-08 起代码服务复用项目仓**(不再有独立仓库),交付物的**边界**因此改由
`servicePath`(仓内相对路径,如 `services/billing-api`,Dockerfile 在它里面)表达。
`metadata` 必带**六项**:`repoPath`(**= 项目根**)/ `servicePath` / `branch` /
`headCommit` / `service` / `port`。
写入那一刻 `tools/blackboard.ts` 的 `verifyCodeService` 调 `codeservice` 端口
(`src/platform/codeservice/git.ts`)去读一遍,**七件事一件不过就拒收**(每条拒绝都带可执行的处置):

① 路径存在且**在工作根之内**(realpath 之后比,符号链接也拦得住);② 它**就是仓库根**
(`git rev-parse --show-toplevel` 必须等于它,不是子目录);③ 真的是 git 工作区;
④ 有提交(HEAD 解析得出来);⑤ `headCommit` 与真实 HEAD 一致、`branch` 的顶端就是它;
⑥ **`servicePath` 在仓库内、存在、是目录,且里面有 `Dockerfile`**;
⑦ **服务目录里至少有一条被提交的文件** —— 否则 `git log -1 -- <servicePath>` 给不出 sha,
而**回退到 HEAD 就是把「交付物根本没进版本库」说成「这版就是 HEAD」**(自信的假话)。
⇒ 编码工提示词因此把顺序写死:**先 `git add services/<名> && git commit`,再 `board_write`**。

核对通过之后,写进库的坐标是**平台读到的值**,并**原样回灌给模型**:
`headCommit`/`headSubject`(交付那一刻的仓库现场)、
**`deliverableCommit`/`deliverableSubject`**(= `git log -1 -- <servicePath>`,
**这个交付物的版本**)、`commitCount`/`files`(**按 `servicePath` 算**)、
`ignoredFiles`(被 `.gitignore` 吃掉、**甲方 clone 不到**的那些)。
⚠️ **`deliverableCommit` 与 `headCommit` 不是一回事**:平台每回合都写工件并提交,
HEAD 一直在动,而交付物可能根本没变 —— 读面说「这版交付物是什么」必须用前者。

⚠️ **没接上核对面时拒绝,不放行** —— 缺省放行等于「在这台机器上写一条假交付物是合法的」。
⚠️ `GIT_DIR` 这类环境变量必须 **`delete` 而不是设成 `""`**:空串会被 git 当成一个路径
(`fatal: not a git repository: ''`),于是每次核对都失败,而错误读起来像「这不是 git 仓库」。

**读面两条边**(`ArtifactView.codeService` 由服务端 `views.ts` 从 `metadata_json` 解析;
`GET /api/artifacts/:id/commits` 是**现读**的最近提交):
⚠️ 交付时记的 HEAD 是**那一刻**的事实,而「这个仓库后来改了什么」只能现在读 ——
存进库就会过期,而过期的快照看起来与新鲜的一模一样。
`runtime: "unavailable"` 是**读不到**,不是「没有提交」(同 `ProjectLiveView` 那条纪律)。

**渲染面 = `<iframe sandbox="" srcDoc>`**(`web/src/components/deliverable/HtmlReport.tsx`),
不是 `dangerouslySetInnerHTML`:内容是模型写的 HTML,而模型会照抄它读过的东西(worker 抓来的
网页片段),「自己人写的」不能当安全依据。空值 sandbox = 脚本/表单/`allow-same-origin` 全关 +
不透明来源 ⇒ **结构性保证,不是过滤器**(与 `lib/markdown.ts` 选 micromark 而非 marked 同源)。
**「新窗口打开」是下载 `.html`,不是 `window.open`** —— blob URL 继承本应用来源。
写入层因此**拒绝**带 `<script>`/`<iframe>`/`<object>`/`<embed>` 的正文(≤512 KiB),
好让模型当场拿到可执行的处置,而不是甲方收到一页空白。

**第二种类型 `code_service` 的渲染面完全不同**(`web/src/components/deliverable/CodeService.tsx`):
它的**主体是仓库坐标**(在 `metadata_json` 里),正文只是一份 markdown 说明。
所以 `bodyMode` 有三个分支,把它当 `html_report` 渲染 = 一片空白、当 `text` 渲染 = 坐标根本看不到。

## 甲方验收与「待收货」(2026-10-08 · migration 029)

> **用户裁决(原话)**:
> 「把甲方从『只读观察者』变成闭环里的一等主体:交付 → 甲方验收 → 收口 / 返工 / 下一版」
> 「**只有甲方认可了之后,项目才算是结项**,业务经理把交付物给到甲方之后,项目进入『待收货』状态」

### 它修的是一道**假门**

在此之前,交付与收口两道门的资格判据都是「存在 `status='accepted'` 的 `deliverable`」——
而那个 `accepted` 是**申请人自己写的**:PM 提示词逐字教它「`status` 用 `accepted`,
因为交付那一环的资格判据是『已验收的交付物』」;真机库 7 份交付物**全部** `accepted`,
作者是 `wk` / `pm` 自己 ⇒ **门的判据 = 申请人的自我声明**,而收口**不可逆**。
(对照 `code_service` 的写入口 —— 平台**当场去盘上核对七件事**,那才是真门。)

### 两个词,两件事(这条分不清就会再造一次假门)

| 词 | 谁写 | 意思 |
|---|---|---|
| `artifacts.status='accepted'` | **作者**(`board_write`) | **定稿**:我整合完了,可以交出去了 |
| `delivery_verdicts.verdict` | **只有甲方** | **收不收**:`accept` / `reject` |

- **`delivery_verdicts`**(029)**纯加法、不重建任何表**:`seq` 自增主键 + `project_id`
  (CASCADE)+ `artifact_id`(**NO ACTION**:删交付物不抹掉「甲方判过它」这件事)+
  `verdict CHECK IN ('accept','reject')` + `note` + 两条索引。**append-only**:
  改判(拒收 → 返工 → 再交付 → 接受)是新写一行,读面取 `(created_at, seq)` 最新那条
  —— 与 021 的 `review_verdicts` 同一条理由。
- **唯一写入口是 HTTP**:`POST /api/artifacts/:id/verdict`。它**不是工具、不在任何角色的
  ceiling 里** —— 做成工具就意味着某个模型能替甲方拍板。四条拒收都带可执行的处置:
  不是交付物 400 / 项目已收口 409 / **还没交付给你** 409 / 理由 >2000 字 400。

### 「待收货」是**派生状态**,不是 `projects.status` 的新取值

加一个取值要**重建 `projects`**,而它实测有 **14 张 `ON DELETE CASCADE` 子表**
(`PRAGMA foreign_key_list` 逐表查出来的:project_assignments / works / blockers /
change_requests / asks / meetings / project_sessions / dispatch_attempts / dispatch_events /
turn_usage / client_questions / review_verdicts / artifacts / knowledge_chunks)——
026 的探针已经证明过「数据少的时候那种重建**不报错而静默清空子表**」。
为一个完全可以从别的表算出来的状态去动 14 张表的级联,是**把一个查询换成一次数据风险**。

⇒ 判据只有一条,落在 `delivery_verdicts` 上:

```
待收货 ⟺ 存在「已交付(project_sessions.deliverable_artifact_id 非空)且没有裁决」的交付物
```

**三个消费者读同一个函数** `deliveryAcceptance()`(`repo/deliveryVerdicts.ts`):

- 读面 `transport/views.ts` 的 `lifecycleOf` ⇒ `ProjectSummary.status` 显示 `awaiting_acceptance`
  (契约里的 `ProjectLifecycleStatus`,**只精化 `active`**;`paused`/`done`/`abandoned` 不显示);
- 规则 `collectRuleFacts` 的 `acceptancePending`(收口门的一格);
- 工具门 `tools/project.ts` 的 `project_close`(模型直接调也绕不过去)。

⚠️ **收口门因此从 8 条变 11 条**:`acceptancePending` 非空(甲方没表态)或
`rejectedDeliveries` 非空(甲方要改)⇒ 都不叫收口。`abandoned` **不受挡**
(放弃不需要甲方先验收)。

### 拒收之后有人接手:`rework_rejected_delivery`

与 `rework_failed_review` **同构**(一行结构化结论 → 下一步),**共用** `reworkOwner`
(「有作者就给作者,没有退 PM,第 3 轮换人」):

| | 质检返工 | 甲方拒收 |
|---|---|---|
| 结论 | `review_verdicts.verdict='fail'` | `delivery_verdicts.verdict='reject'` |
| 目的地 | 产出的作者 ⇒ PM 兜底 ⇒ 第 3 轮换人 | **同一个判据** |
| 终止 | 那条工作项上出现了比结论更新的产出 | **那之后又交了一份定稿**(`deliverable` + `accepted`) |

⚠️ 终止判据**比质检那条更窄,而且这是回归里现出来的**:作者写一条 `note`(「我明天改」)
就把它算成返工完成的话,待办消失、被拒那版还在、收口门不成立、**没有任何人再被叫醒**
—— 静默停的同款。写一份 `open` 草稿同样不算(交付要的是定稿),那种死尾由
`review_undelivered_project` 兜底。

⚠️ **甲方那句话(`note`)照原样进任务正文** —— 与 `rework` 的「正文一个字都不搬」相反:
那边是几千字审查意见(复述白占 context),这边通常一句话,而且它是**唯一的现场**
(裁决不是工件,模型 `board_read` 读不到)。没写理由时**不替他编**,如实说「他没写」,
并指出唯一能问的人(业务经理)。

⚠️ **被拒的那一版必须退休**:`board_write` 交新定稿时把被拒的那一版标 `superseded`
(与质检返工同一处逻辑)。少了它,收口门会读到一个**永远消不掉的拒收** ⇒ 项目永远收不了口。

⚠️ **收口项目上不给按钮**:`ArtifactAcceptanceView.projectClosed` —— 后端一律 409
(收口不可逆),所以读面说「已交付 · 未被验收(项目已收口)」而**不是**给一排兑现不了的按钮;
`counts.pendingAcceptance` 与**对话页右栏那张「待你验收」面板**(`AcceptanceDock.tsx`)**同口径**(终态项目恒 0,
免得出现「徽标 7、清单空」)。**事实一条不删**:那份交付物的卡片照旧如实说它没被验收过
—— 真机那个项目 2026-10-07 就 `done` 了,而验收是 10-08 才有的,那 7 份交付物全是这个形状。

**回归**:`tests/platform/delivery-acceptance.test.ts`(33 条)· `tests/web/delivery-verdict.test.ts`
(14 条)· `project-close-rule` 的逐格拆解里加了「已交付但甲方没验收」「甲方拒收」两格 ·
`dispatcher-c3` 的期望值改判(交付之后**不再**立刻 `close_project`,并补了「甲方接受之后
那条待办真的会来」的正向续演)。

## MCP:定义归人,授权可 agent(2026-10-16 · Wave 1)

**两个动作被刻意分成两层**,合成一层就出事:

| 层 | 动作 | 谁有权 | 落点 |
|---|---|---|---|
| **定义** | 新增一个 server(command / url / env) | **只有人** | `POST /api/mcp/servers` |
| **授权** | 把**已存在**的 server 开给某角色 | **人 + agent 都能** | `PUT /api/mcp/roles/:role` 或 `mcp_grant` |
| **运行时** | 建会话时冻结一份快照 | 平台 | `RuntimeDeps.mcpFor` |

⚠️ **没有任何一个工具能新增 server 定义**。理由与 029 同源:`POST /api/artifacts/:id/verdict`
「不是工具、不在任何角色的 ceiling 里 —— 做成工具就意味着某个模型能替甲方拍板」。
MCP server 定义 = 在这台机器上执行任意命令 / 向任意地址出网,同款处置。
工具只有三个:`mcp_list`(读)/ `mcp_grant` / `mcp_revoke`。

### 落点是文件,不是表

```
<dataDir>/harness/mcp/servers.json      ← 目录(HTTP 写)
<dataDir>/harness/mcp/secrets.json      ← secret(Keyring 加密,0600)
<dataDir>/harness/mcp/{role}.json       ← 该角色授权,形状同 ToolSetFile:{allow,deny}
```

**不建数据库表**。模块 = `src/platform/mcp/{config,secrets,grants,solve,piConfig}.ts`。
HTTP 面:`GET|POST /api/mcp/servers` · `PUT /api/mcp/servers/:name/secrets` ·
`DELETE /api/mcp/servers/:name`(仍被授权 ⇒ **409 并列出那些角色**,不静默级联)·
`GET|PUT /api/mcp/roles/:role` · `GET /api/mcp/roles/:role/backups` ·
`GET /api/mcp/dir`(配置目录 + `strayFiles` 落在空处的意图)。

- **secret 明文不进 DB、不进任何 API 响应、不进日志、不回写文件**;解不开的只报**键名**。
- `env`/`headers` 里**硬拒 `!` 开头的值**(pi 的 `!command` 是任意命令执行后门),只允许 `${VAR}`。
- **角色分配**:`mcp.read` 给 business_manager 与 project_manager;`mcp.grant` **只给 project_manager**;
  两个执行角色与质检**零 MCP**(他们已有 `code.exec`,再叠外部工具是纯扩权)。
- **收口项目停用 MCP**:`authorize.ts` 的 `PROJECT_SCOPED_PREFIXES` 加了 `"mcp."`,
  且**没有**加进 `DIALOGUE_SURVIVES_CLOSURE`(豁免的是「说话」,不是「用外部工具」)。
- ⚠️ **授权只影响新建的会话** —— 会话池键是 `(项目, 会话, agent)`。改完授权要对已存在的会话
  重建才生效。`mcp.grant` 因此**不在** `NUDGE_CAPABILITIES` 里(叫醒 agent 对旧会话无效,只是噪音)。

### 坏授权文件的退路方向与 L2 集合文件**相反**(故意的)

`harness/toolSet.ts` 的坏文件退化成「ceiling 全集」= **放宽**;而 MCP 授权文件是**增量机制**,
坏文件必须退化成 **零授权**。授权文件的坏掉若按「全放行」处置,一次笔误就是一次**静默提权**。
两个文件头的注释都写了这条,`tests/platform/mcp-grants.test.ts` 钉住对照。

### ⚠️ pi 1.2.0 的四个坑(每一处都有断言钉住,`tests/platform/mcp-wiring.test.ts`)

1. **SDK 会话不加载内置扩展** —— `session.ts:249` 自己传
   `extensionFactories: [createToolSearchExtension(), createMcpExtension({...})]`。
2. **`bindExtensions` 不会被 `createAgentSession` 自动调用**(`dist/core/agent-session.js:2630`
   有该方法,`dist/core/sdk.js` **零调用**)⇒ 不显式 `await` 它,server 永不连接且**表面零报错**。
   建出来的 session 没有该方法 / 绑定失败,都写进 `wiring.mcpBindError`,**不静默**。
3. **fail-open** —— `agent-session.js:193-197` 的 `_allowlistFiltersMcp` 只在「allowlist 空」
   或「有条目以 `mcp__` 开头」时为 true,`:1123 _isAllowedTool` 在 false 时**保留全部 MCP 工具注册**。
   ⇒ 有授权时 `mcp__<server>__*` **必须**进 `unifiedAllowlist`(`sdkAdapter.ts:228`),
   而它不在闭合 `ToolName` 集里 ⇒ `classifyToolset` 单独给了 `mcpPatterns` 这个桶,
   既不进 `TOOL_INDEX` 查找、也不算 `unplaceable`。
4. **资源工具越界** —— `list_mcp_resources` 等到达「每个 enabled 非 hidden 的 server」。
   ⇒ 未授权的 server 必须**显式** `{enabled:false, exposure:"hidden"}`,**不能只是不列**。

另两条:`autoEnableCodemode: false` 写死(codemode 的调用**不经过** active tool set,
allowlist 拦不住它);**刻意不给 `projectConfig`**(pi 默认还会读 `<cwd>/.pi/mcp.json`,
而 cwd = 项目仓根 ⇒ 会进 git、对甲方可见)。

### Wave 1 的缺口(如实记,别当已接线)

- **没有 WebUI** —— 配置走 HTTP 接口或 agent 工具;UI 是它未来的一个消费者。
- **不支持 OAuth 登录** —— `openUrl` 只 `log.warn` 记下 URL(三生没有 TUI,跑不了浏览器回调)。
- **连接状态读不到** —— pi 把它写进 `<agentDir>/mcp.log`,平台读不着。
  `PiConfigResult.connectionState` 的类型是**字面量 `"unavailable"`**:宁可没有这个字段,
  也不伪造一个「已连接」(与 `ProjectLiveView.runtime = "unavailable"` 同一条纪律)。
- **MCP 调用暂不接进 `turn_usage` 成本观测**。

## 成本:只做观测,不设上界(2026-10-08)

> **用户裁决**:「针对『成本没有上界』现在这个阶段可以放松一点,**先只做 observation**」。

所以**没有加任何闸门**(不拦、不警告、不自动停)。做的是把观测面补完:

- **`byWork`**:按**工作项**分桶(此前只有 `byAgent` / `byDay`)。`byAgent` 回答「谁在花钱」,
  `byWork` 回答「**哪件活在花钱**」—— 后者才是能做决定的那一问。真机事故(2026-10-06)
  是一条工作项**单回合读进 109,231 token** 撞墙钟被 `abort()`;
  在只有 `byAgent` 的读面上,它和别的活长得一模一样。
  `work_id IS NULL` 那一桶是**平台回合**(播报 / 答复处置 / 收口判断):真实花费,
  **既不许并进某条工作项(假归属),也不许丢**(丢了之后分项和与合计对不上)。
  **不截断**(工作项是十位数量级,截一条就可能截掉最贵的那条)。
- **前端第一次有读者**:`useProjectUsage` 此前**一个渲染点都没有**(hook 与端点都在,
  没有任何页面用它 —— 「代码里写了逻辑」≠「它有读者」的第 N 次复发)。项目页新增「成本」段:
  全历史 / 窗口 / 今日 + 谁花的 + **花在哪件活上**;窗口与「最近一笔」都写在明面上
  (一个没有窗口的合计数字看起来永远是对的)。
- 反造假:`usage === null` 且未查完 ⇒ 「加载中」(不是 0);读失败 ⇒ 印 error;
  窗口内没有账 ⇒ 「一笔都没有」(不拿「现在」冒充)。

**真机第一次读出来的事实**:平台回合 **20 个回合吃掉 1,026,083 token**,
而每条研究工作项 3–7 万 —— **81% 的钱花在播报 / 交付 / 收口判断 / 答复处置上**,
不是花在写方案上。这正是「先做 observation」的价值:**不知道钱花在哪,设上界只能靠猜。**

**仍然没有的**(如实):预算闸门、按工作项的 token 上界、超支告警。

## 提示词(harness)

- 单元内容在 `harness/system_prompts/`,**14 个唯一单元**;构建时由 `scripts/copy-harness.mjs` 拷进 `dist/harness/`(出厂副本)。
- 运行时从**数据目录**读:`<dataDir>/harness/system_prompts/{unitId}.md`(`src/platform/runtime/promptAssembly.ts`)。
- 角色→单元的声明在 `ROLE_SPECS[].promptUnits`:5 个角色共 **19 处声明**、14 个唯一单元。跨角色共享的有**三个** —— `collaboration.ask`(4 个角色)、`collaboration.convene`(2 个角色)、`change.propose`(2 个角色)。
- **角色中文名的第三处写法已彻底删掉**(2026-10-08):`runtime/promptAssembly.ts` 曾有一张
  `ROLE_NAME`,先写着 `Worker(执行者)`、后写着「质检审查员」(而 `ORG` 是「质检」)——
  现在**没有那张表了**,系统提示里的「# 你的角色:X」直接调 `roleDisplayName()`。
  `tests/web/role-names.test.ts` 的第三条断言同时从 `toContain` 改成**逐字相等**
  (旧写法 `"质检审查员"` **包含** `"质检"`,于是那条断言曾是**假通过**)。
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
platform-serve      常驻宿主:HTTP + WS + 托管前端 + 排空定时器(默认 127.0.0.1:2718)
help
```

真机入口:`node dist/src/cli/index.js platform-serve --data <临时目录> --port <端口>`(provider 配置需把 `~/.sansheng/` 里的 settings 与 keyring 拷进临时目录),然后 `curl /api/health` 应返回 `{"ok":true,...}`。

> `package.json` 的三个入口(批次 19 修好,之前三个都指向不存在的文件/未知命令):`dev` = `dev:server`(`tsx watch src/cli/index.ts platform-serve`)+ `dev:web`(vite 5173);`start` = `node dist/src/cli/index.js platform-serve`。vite 的 `/api` 与 `/ws` 代理目标是 **2718**(`vite.config.ts`)。⚠️ 它**必须**与 `platform-serve` 的默认端口一致 —— 写错了 proxy 就指向一个没人听的端口,而界面只会「连不上」;这两处曾经各写一个(2718 / 2719),2026-10-08 统一回 2718。

## pi 依赖:三生**不依赖**本机装没装 pi(2026-10-15 实测)

`package.json` 里 `@earendil-works/pi-coding-agent` 是**普通 npm 依赖**(2026-10-15 从 0.87.1 升到 **1.2.0**,与本机 pi CLI 对齐),装进三生自己的 `node_modules`。全部 30 个 pi 包来自公共 registry(npmmirror / npmjs),`src/` 里唯一的 `execFileSync` 调的是 `git`,**零处引用 `.pi`**。

实测:空 `HOME`(无 `.pi`)+ 临时数据目录起 `platform-serve` ⇒ `/api/health` 正常、自建 `sansheng-workspace` 与 `harness/system_prompts`、**HOME 里始终没出现 `.pi`**、启动日志零 warn。⇒ 目标机器只要 **Node ≥ 22.19**(pi 的 engines,比本仓写的 `>=22` 高)+ 能访问 registry。

### 配置从哪来 —— 三生自己的数据目录,不是 pi 的

| 配置 | 读自 |
|---|---|
| provider / modelId / baseUrl | `<dataDir>/settings.json` |
| API key | `<dataDir>/.keyring`(`boot.ts:95`;masterKey 是**明文 base64**) |
| **凭据 → pi 的通道** | **环境变量**(`syncActiveProviderApiKeyEnv()`,`boot.ts:114`,建 session 前一次)—— pi 侧从 `agentDir/auth.json` **或 env** 取 |
| model 元数据 | pi-ai **内置 catalog**(见下) |
| 提示词单元 | `<dataDir>/harness/system_prompts/{unitId}.md` |
| 工具集合(L2) | `<dataDir>/harness/tools/{role}.json` |
| agentDir | `<dataDir>/agent`(`serve.ts:1324`,可被 settings 覆盖) |

⚠️ **`<dataDir>/agent/models.json` 与 `auth.json` 三生从不写** —— 那一格是空的。

### ⚠️ 唯一的真耦合:SDK 兜底指向 `~/.pi/agent`

pi `core/sdk.js:71-75`:`agentDir` 的兜底是 `getDefaultAgentDir()` = **`~/.pi/agent`**;`authPath` / `modelsPath` **只在传了 `agentDir` 时**才指向它。三生 `serve.ts:1324` 总是传 ⇒ 隔离。但**这是「调用点自觉」撑着的,不是结构性保证**:哪条路径建会话时漏传 `agentDir`,就会**静默读到 pi 的 `models.json` 与 `auth.json`**,不报错。

### 加一个内置 catalog 里没有的 model

`resolveModel()`(`providers.ts:169`)只查 pi-ai 内置 catalog,而 `getBuiltinModel` 是**纯静态查表**(pi-ai `providers/all.js:49` `MODELS[provider]?.[modelId]`),**不读任何用户文件**。⇒ 上游没有的 model,三生既跑不起来、设置界面(`listProviders` 走同一个 `MODELS`,`providers.ts:53`)也列不出来。

**注入一处 catalog 数据 ⇒ 两个消费者同时生效**,这是选它而不改 `providers.ts` 的理由(改源码要碰两个点):

```
scripts/model-catalog-overrides.json   # 数据,形状与磁盘 catalog 逐字对应
scripts/patch-model-catalog.mjs        # 合并器(幂等)
package.json → "postinstall"           # npm install 时重放
```

⚠️ **磁盘上 model 的 key 必须带 `chat:` 前缀** —— 那是 `providers/data/*.json` 的形状,pi-ai 载入内存时会剥掉,所以运行期 `getBuiltinModel('minimax-cn','MiniMax-M3')` 查的是**裸 id**。写错前缀 = 静默不生效。覆盖语义:同名 model 覆盖内置值。

> 不用 `patch-package` 的理由:catalog 是**单行压缩 JSON**,它产出的 diff 人读不懂、review 不了。
>
> ⚠️ 正确形态仍是「让 `resolveModel` 读 `<dataDir>` 下的用户覆盖层」—— 那才是「任意用户都能加 model」的结构性功能(需开批次 + 回归测试)。当前注入法**只服务本机**,且作为 npm 包发布时会给**消费者的 `node_modules`** 也注入同一个 model。

## 更新与部署:改了 pi 依赖或 catalog 之后,**`npm run build` 不够**

```
git pull
npm install        # ← 必需:pi 包版本与 catalog patch 都落在 node_modules 里
npm run build
```

`npm run build` 只编译(`tsc` + `vite build` + `copy-harness.mjs`),**不碰 `node_modules`**。2026-10-15 起有两类改动是它覆盖不到的:pi 包版本升级、catalog 注入 —— 两者都靠 `npm install`(及其 `postinstall`)落地。

⚠️ 装了 `postinstall` 之后 **`npm install` 会改 `node_modules`**(幂等,第二次是「已一致 N」不写盘)。判有没有生效:

```
node -e "console.log(Object.keys(require('./node_modules/@earendil-works/pi-ai/dist/providers/data/minimax-cn.json')['anthropic-messages']))"
```

`npm ci` / `npm install --ignore-scripts` 会跳过 `postinstall` ⇒ 那次得手动 `node scripts/patch-model-catalog.mjs`。

## 验证链(改完必须全过)

```
npx tsc -p tsconfig.server.json --noEmit
npx tsc -p tsconfig.web.json --noEmit
npm test                  # 2269 passed / 117 files
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
   - **装饰性变异**(2026-10-22 新增,provider 故障批次复核时栽了两次):在语句**前面**加个注释(`/*MUT*/ disposeAllSessions(...)`)—— **注释不会让语句失效** ⇒ 调用照常发生 ⇒ 「改坏了却全绿」是假的,其实是「**根本没改坏**」;而且 `str.replace` 不匹配时**静默不执行** ⇒ 两者叠加 = 一条**从未生效**的变异被当成「测过了」。⇒ **变异必须真的移除/改写语句,且必须断言「改后那一行确实变了」。**

   **做法:每个诊断先拿一个已知答案的样本自检 —— 一个必须命中的正样本 + 一个必须不命中的负样本。两个都对上,才用它去看别的。**
   判据不是「跑完了没报错」,是「它对已知样本给出了正确答案」。
   ⇒ **推论:「测试是绿的」在变异实测过之前不算数。**

## 明确不存在的东西(别再找)

- **路径**:`src/server/`(批次 19 已连空目录壳一起删掉)、`src/shared/jsonRepair.ts`、`shared/prompts/`(4 个 md / 536 行)、`scripts/diagnose.mjs` 与 `npm run diagnose`(批次 19 删)、`tests/agents|cli|server|shared|storage|tools/`、根目录的 ARCHITECTURE.md 与 PLAN.md(都已删除)。
- **角色**:communicator / planner / executor / critic / harness_manager / memory / reflection;以及 **`worker`**(2026-10-08 已一分为二,见「五个角色」)。
- **机制**:`ROLE_CEILING` / `FACTORY_SETS` / `LEGACY_TOOL_SETS` / `enabledTools` / `MessageBus` / `BlackboardScope` / `orchestrator` / `kernel` / `completeSimple` / `toolLoop` / `PI_OFFLINE` / `blackboards` 表 / `fragments_vec`。
- 这些名字在 `src/` 里**只剩注释里的历史说明**,没有任何活代码。看到它们说明你在读注释,不是接口。

## 历史文档(读之前先知道它描述的是什么)

- `README.md` 已于批次 19 **改写为现行系统**的说明(角色 / 2718 / `platform-serve` / 验证链)。它不再是历史文档。
- `docs/TROUBLESHOOTING.md` 已于批次 19 改成一份**「已失效」说明**:原文描述旧系统(读 `blackboards` / `conversations`,那两张表已被 `011_drop_legacy.sql` DROP),配套的 `scripts/diagnose.mjs` 与 `npm run diagnose` 已删除。**不要照着它排查**,它现在只做两件事:标出失效原因、把仍然成立的教训指回本文。原文逐字在 git 历史里:`git show e3d2812:docs/TROUBLESHOOTING.md`。
- `docs/PRODUCT-DESIGN-2026-10-02.md`、`docs/CODE-REVIEW-2026-10-01.md`、`docs/AGENT-AUDIT-2026-10-03.md`、`docs/SECURITY-NOTES.md`、`MIGRATION-HANDOFF.md` 是**带日期的历史记录**(描述当时发生了什么):里面的路径、测试名、表名多已不存在。当历史读,**不要当操作手册**;也不要改它们 —— 改了是篡改。
- `MIGRATION-HANDOFF.md` 是 pi → DSH 的迁移记录;`docs/pi-memory/` 是旧记忆全量归档。
