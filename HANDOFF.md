# Sansheng 项目交接包

**生成时间**:2026-10-03 CST · **v9.0**(平台侧全量新建:BC0–BC7 + 工具层 + 接线,9 个批次)
**上一版**:v8.0(批次 7-O harness 写面 + 8-A…8-D 角色职能核查迭代),见下。
**适用**:下一会话(主对话 / worker)开盒即读
**配套阅读**:`docs/DESIGN-PLATFORM.md`(目标架构)· `docs/DESIGN-AGENTS.md`(四个角色与 harness 配置)· `docs/ADR-001-harness-wiring.md`(接线决策与欠账)· `docs/TROUBLESHOOTING.md` · `ARCHITECTURE.md`(旧系统 12 层图,**描述的是被替换的那套**)

> **v9.0 · 平台侧全量新建(2026-10-03 晚 → 10-04,DSH 会话,9 个批次)**
>
> **用户两句话定了整件事的走向**:「我们不要小修小补了,做一个全面的项目架构升级」「完全新建没问题的」。
>
> **核心反转:组织架构从「提示词台词 + 硬编码调用链」变成一等数据。**
> 工具 = 能力 × 作用域;「甲方只与业务经理交互」由 `ROLE_SPECS.clientFacing` 机械保证,
> 不再是提示词里的自觉 —— 那是 7-B / 7-L 两次「提示词在骗人」的正面修复。
>
> **九个批次**(全部已推送,`dfc428a` → 见 git log):
> 1. `fe3dd47` BC0 RoleSpec + BC5 三重门控求解器
> 2. `f04e026` BC0+BC1 schema 与仓储(agents / projects / assignments / works / deps)
> 3. `7b3cf1d` BC3 Blackboard + BC4 ChangeControl
> 4. `7083618` 工具层与派发器(21 工具)
> 5. `5a78107` BC2 协作(7-L 升级链 + 会议 + 会话)
> 6. `7b2bb75` BC7 记忆(MemoryPort 端口 + bigram 检索)
> 7. `1ed35eb` 甲方接口(ClientChannel 端口)+ 待办注入面
> 8. `5bfe9ca` **Harness 接线**(assembly / sdkAdapter / session)
> 9. 本批:**CLI 入口**(`sansheng platform smoke`)+ 提示词装配(7-B 死接线守卫)
>
> **现状(可验证)**:`npm test` **1195 passed | 1 skipped(100 files)** · typecheck 0 · build OK ·
> `npm run check:design` E1–E13 全绿 · `grep -rn 'as any' src/` = 0。
> 平台侧 `src/platform/**` 27 文件 ~6500 行,测试 13 文件 ~5000 行。
>
> **接线在真模型下已验证**(minimax-cn/MiniMax-M3):
> ```
> $ node dist/src/cli/index.js platform smoke --role business_manager -p "..."
>   工具面 26 个 | 统一 allowlist 26 | customTools 26
>   SDK 实际激活 26 === 我们声明 26  ✓ 完全一致 —— 接线成立
>   回答:我是 Sansheng 项目的业务经理,也是项目里唯一直接对接你的角色……
> ```
>
> **这一路抓到的四个真问题**(都不是"小修小补",是设计缺陷):
> - **表名撞车**:009 用 `conversations`/`messages`,而 001 早占了这两个名字。`CREATE TABLE IF NOT EXISTS` 撞名时**静默无操作**,新表根本没建,报错落在下游索引上 —— 167 个测试一起红而错误信息与根因无关。修法是改名 + 立不变量(`tests/platform/migrations.test.ts`,已用注入撞名反向验证会红)。同理 010 的 `fragments`/`user_profile` 改名 `memory_*`。
> - **授权粒度过宽**:按能力授权会让 `allow:["board_list"]` 连带授予 `board_read`(按 id 读任意工件正文)—— 用户没要的权限。改成工具级。
> - **`tools` 是统一 allowlist**:查证 `agent-session.js:2496` 的 `isAllowedTool` 对 builtin 与 customTools **同时过滤**。首跑冒烟传 `tools:[]` 得到 **0 个激活** —— 被真机不变式当场抓住。改成「统一名单 + customTools 实现」。
> - **提示词死接线(7-B 同款复发)**:`promptUnits` 算了却从没送达模型,业务经理自称「AI 编码助手」。修法是 `composeSystemPrompt` + `DefaultResourceLoader.appendSystemPromptOverride` + **显式 `reload()`**(外部传入时 SDK 不代为 reload)。
>
> **关键设计决定**(详见两份设计文档与 ADR):
> - 角色是**全局的人**(BC0),`clientFacing` 是代码内常量 —— 结构上不存在被数据篡改的路径
> - **横向沟通自由 + 纵向 escalate 受控**(目标是平台计算,模型不能指定)
> - **求解期 / 调用期两阶段门控**:`kind` 与 `target` 是调用参数,塞进求解期会得到假门
> - 保持**工件通道**,不退回阻塞 RPC(`MessageBus` 待删)
> - agent 不再交 `{outcome}` 让框架猜,改为直接调 `board_write` —— 对 7-D/7-M/7-N「信封偏差」三连的结构性解法
> - 三条端口让外部依赖可替换:`MemoryPort` / `ClientChannel` / `createSession`(测试 seam)
>
> **欠账(如实标注,非遗漏)**:
> - **12 个提示词单元尚未写出**。角色简报是机械生成的(已生效),但 `business_manager.core` 等 12 个单元内容为空 —— 冒烟会如实打印「声明了但盘上没有」。这是**行为设计**,该由用户过目。
> - **调度器缺席**:`listOverdueAsks` / `expireAsk` 有实现无调用方。注入文本里已对 agent 明说「当前没有调度器」,链路不会静默死掉。
> - **待办注入面有了但没接进回合**:`runtime/pendingWork.ts` 是纯函数且已测,但「谁来调用它并把文本拼进 system prompt」属运行时装配,尚未接。
> - **阶段 7 / 8 未做**:BC6 执行层(`board_write` 取代 outcome 硬编码解析)、清场(DROP 旧表 + 删旧模块与其测试)。
>
> **旧系统状态**:`src/server/**` 一行未动,继续服务旧角色与旧工具名。新旧并存于同一个 SQLite(新表见 007–010)。删旧的时机是阶段 8。
>
> **跑一下看**:
> ```
> npm test                      # 1195 passed
> npm run check:design          # 设计文档一致性 E1–E13
> node dist/src/cli/index.js platform smoke   # 真模型接线验证
> ```

> **v8.0 · 批次 7-O + 8(2026-10-03 晚,DSH 会话,用户两连问)**:**第一问「在 harness 中能对每个 agent 的 prompt 和 tools 做管理」,第二问「按每个 agent 的角色职能做 checklist,查期望与代码的 gap,做一次大的技术迭代」。**
> - **7-O harness 写面**:`src/server/harness/apply.ts`(唯一写盘点:备份 → 原子写 → 回读)+ facet 的可选 `apply?`/`detail?` + `http/harnessRoutes.ts`(GET 详情 / PUT 写入 / POST reset 需 confirm)+ Harness 页编辑器。测试 `tests/server/harness-apply.test.ts` 31 个。
> - **核查报告**:`docs/AGENT-AUDIT-2026-10-03.md` —— 逐角色 checklist(9 个角色 + 横向 6 项)、可复现实证脚本、gap 汇总、批次 8 方案。**主结论:最会说话的 agent 工具是真的,最该动手干活的 agent 工具是假的。**
> - **8-A(`4f644b6`)执行者真工具**:`harness/sdkTools.ts` 把 SDK 内置 7 工具(read/grep/find/ls/edit/write/bash)包成 LoopTool 接进 `buildOrchestratorTools`。**此前集合文件说 13 个、工具循环里真的只有 6 个**,而出厂提示词正教模型用那 7 个不存在的 → 调用失败 → 纪律压力下编造。不变量测试 `tests/agents/sdk-loop-tools.test.ts`(5 个)钉死「集合文件声称的工具必须在池子里」。**边界未动**:SDK 工具根 = `settings.cwd`(默认 `~/sansheng-workspace`),不经 Sansheng Sandbox(7-H 既有裁决,本批只补「缺失」不顺带改「边界」,好让回归可归因)。
> - **8-B(`e7479c6`)终态播报**:沟通员「Observer 身份」此前是**死接线**(`startObserver` 挂在 prototype 上从无调用方)。新增 `agents/runReport.ts`(8s 超时 / 400 token,失败降级为确定性文案)+ harness 单元 `communicator.report` + `kernel.sayAsCommunicator()`(合成 turn + 落库 + 总线留痕),ws.ts 在 plan_done / plan_failed 两条终态路径上**不 await** 调用。**不复用那套 mixin**:终态在 runPlan 里是同步已知事实,订阅全局 bus 只会多一类重复播报与僵尸。
> - **8-C(`83d5e5e`)计划可见可中止**:`todos_planned` / `todo_started` / `todo_resolved` 此前被 ws.ts **显式不外发**(用户跑到结束才第一次看见结果),现新增 `plan_planned` / `plan_todo_update` 两个 ServerEvent;前端计划卡 +「中止」按钮(发既有的 `abort_plan`)由子任务落地。
> - **8-D(`fbd4d8d`)记忆闭环**:**M2** 中文分词改 bigram(旧正则贪婪整段而注释自称按字拆,「我叫什么名字」永远召不回「用户名字:小明」);**M3** 记忆块注入 planner/executor(此前 `makeLlmCall` 零记忆),抽 `agents/workerMemory.ts` 与 chat 路径共用一份实现。测试 `tests/storage/memory-recall.test.ts` 8 个。
> - **未做(审计已列,留后续)**:M1 向量检索生产零调用(每条 fragment 仍在发 embedding 却从不读)、M4 fragments 无上限/去重、M5 两套记忆割裂 + 死字段、G5 critic/reflection 零实现、harness_manager 永不触发、G6 成本无设防、G7 harness UI 只覆盖 4/12 提示词单元。
> - **验证**:typecheck 0(server+web)· `npm test` **731 passed | 1 skipped(85 files)** · build:server OK · `grep 'as any' src/` = 0 · 独立端口 boot smoke(临时 dataDir)全绿。
> - **USER-side 生效条件**:**重启 2718 server**(8-A 的 SDK 工具、8-B 的播报、8-C 的计划事件都要新进程加载)。重启后 `~/.sansheng/harness/system_prompts/communicator.report.md` 自动写出(全新单元);executor 的工具集合文件不用改(出厂 13 个现在**真的**有了)。
> - **⚠️ 需要你亲自验的(浏览器)**:计划卡与「中止」按钮、终态播报那句话在聊天流里的观感;以及执行者第一次真的 read/write/bash 之后产出质量的变化(这是本轮迭代的核心目的)。
> > **v7.2 · 批次 7-L(2026-10-03,DSH 会话,总线升级问题)**:**worker 升级的对象是沟通员,不是用户;沟通员先自己判一轮**。
> - **用户原话**(worker 在总线上升级 todo-3 时写的):「总线实际的功能是用于 agent 之间做信息交互的,意思就是沟通员和后面几个干活的 agent 做信息交互,worker 升级了问题,应该要问的是沟通员,而不是用户,如果沟通员解决不了,那么沟通员负责和我沟通,让我判断决策。另外要说的是,不要所有的问题都要我来回答,沟通员需要根据和我对齐的信息,先判断一轮。」
> - **现场事实(不是感受,是代码)**:7-L 之前 `agentKernel.handleExecutorCallback` **硬编码** `communicator.handleWorkerAsk(msg, knowIt=false, …)` —— 沟通员主提示词里那句「升级用户前先自查」写了三年,**代码里一次都没执行过**(与 7-B 死接线同款病,方向是「提示词在骗人」)。用户每一条升级都亲自接,就是这条硬编码的直接后果。
> - **三处根因一起修**(缺一个都只是换个姿势继续骗):①**判断轮落地**:`makeWorkerAskAdjudicate` + 新提示词单元 `communicator.worker_ask`(11 个单元),输入 = 执行者 hypothesis 全文 + 最近对话(已对齐信息),输出 `{"verdict":"answer"|"escalate",…}`。answer → 写 decision + `executor_resume`,**用户零打扰**;escalate → 沟通员**自己新起 `q-comm-*`** 问用户,并强制带 `lean` + `ruledOut`。②**提问 payload 带全文**:旧 payload 只有一句 `Executor needs help (judgment) for todo xxx`,判断轮连问题是什么都不知道,只能全推给用户 —— 现由 `buildWorkerQuestionPayload` 读 `getArtifact(hypothesisId)` 拼标题 + 候选方案正文。③**审计流如实两级**:`worker→comm`(执行者问沟通员)与 `comm→user`(沟通员问用户)各记各的,沿用 `q-exec-*` 会让 timeline 看起来像执行者直接找用户。
> - **失败语义刻意与 align 闸门相反**:判断轮缺席/超时/抛错/解析不出来 → **一律退回升级用户**(fail-safe)。align 是 fail-open(宁可开工别卡住用户),因为错判代价是「多问一句」;判断轮 fail-open 则可能让沟通员在没判断成的情况下**替用户拍板** —— 那是真事故。最坏情况只是回到 7-L 之前的行为,不会更差。
> - **两个连带修正**:①`handleUserAnswer` 的「写 decision + resume」抽成 `resolveWorkerQuestion`,用户回答与沟通员自答**共用同一条落库路径**(否则审计面会出现「执行者拿到一份没有 decision 工件的指令」);②`onEscalate` 里把 `pendingExecutorCallbacks` **改挂**到 `q-comm-*` 并摘掉 `q-exec-*` —— 否则用户回答完,那条已不成立的执行者问题还留在表里,一次迟到的 cancel 能把已恢复的 executor 再杀一遍。
> - **提示词与版本链**:`ROLE_PROMPTS.executor` 加「## 4. 卡住时你求助的对象是沟通员」段(自包含 / 给候选项 / 说清要什么),`ROLE_PROMPTS.communicator` 把「升级用户前先自查」从台词改成职责。**两份旧出厂默认都已追加进 `LEGACY_DEFAULTS`**(7-J 踩坑第 4 次的规矩:改出厂默认不入链 = 存量用户文件被永久判成 user_edited,新提示词永远到不了)。
> - **验证**:typecheck 0(server+web)· `npm test` **679 passed | 1 skipped(81 files)**(+22 = `tests/agents/worker-ask.test.ts` 16 + `tests/server/worker-ask.test.ts` 6)· build OK · `grep -rn "as any" src/` = 0。既有 4 个文件的 11 个断言因新增提示词单元与总线 id 语义变化而更新(单元数 10→11、`q-exec-*`→`q-comm-*`),不是回归。
> - **USER-side 生效条件**:**重启 2718 server**。`~/.sansheng/harness/system_prompts/communicator.worker_ask.md` 启动时自动写出(全新单元,无历史版本);`executor.md` / `communicator.md` 若等于上一代出厂默认会被**自动升级**,若你手改过则保留并显示 `user_edited`(需手动合并)。

> **v7.0 · 批次 7-E(2026-10-02 晚,DSH 会话)**:**harness 的 tool 部分从「装饰」变成「真配置」**。
> - **用户现场判断**「harness 层面的东西很薄弱,沟通员只有 read/grep/find/ls,能不能提前给每个 agent 打造各自的工具集合,以后 harness 的持续优化就经由升级这套集合」。查证后确认比描述更糙,三处硬事实:
>   ① `HarnessConfig.enabledTools: ["fs_read","fs_write","shell","http"]`(`loader.ts:40`)**是 M3c 死装饰** —— 四个名字在 SDK 工具闭合联合(`read|bash|powershell|edit|write|grep|find|ls`)里**根本不存在**,唯一消费点是 `http.ts` 回显给 `/api/harness`,**零执行点读取**;前端自己就写着「不假装配置在生效」(`web/src/routes/Harness.tsx` 的反造假纪律第 2 条)。② planner / executor / harness_manager / sedimentation **全走 `completeSimple` 单轮补全,零工具**。③ `AgentRunner`(`runner.ts:94`)建 Pi session 不传 `tools` → 拿 SDK 默认 `read/bash/edit/write`,是条带执行权限的死代码。产品设计 §6.1 / open question #15 原文即「enabledTools/redLines/budget 变成真配置(per-agent 化)」—— 本批只做 tools 这一项。
> - **核心设计 · ceiling / collection 两层**(本批的关键判断):工具集合若只是一张用户可写的名单,往 `communicator.json` 加一行 `"bash"` 就能推翻**批次 5b-1 P3「沟通员从机制上杜绝直接干活」**(jev A 方案 conf 1.00)。故拆成:`ROLE_CEILING`(代码内的架构上界,集合文件**突破不了**)+ `harness/tools/{role}.json`(上界内可自由增减的用户意图)。**「升级工具集合」与「解除架构约束」从此是两种动作** —— 前者改文件,后者改代码(需评审)。全部角色 v1 均为只读上界(`read/grep/find/ls`)。
> - **落地**(`src/server/harness/tools.ts` 新增 ~430 行 + `loader.ts` 接线 + `agentKernel.ts` 换掉硬编码 + `runner.ts` 接 ceiling + `/api/harness` 顶层 `toolSets` + `Harness.tsx` 数据驱动渲染):解析全程 **fail-closed** —— 损坏 JSON / 顶层非对象 / `allow` 非数组 / 未知工具名 / 字段拼错(`allowed` vs `allow`)五类坏输入全部退回或收窄,绝不产出越界的 `allowed`;越权条目逐个进 `blockedByCeiling` 并产生 warning(**提权失败必须对用户可见**)。`ensureToolSets` 沿用 prompt 侧的三分支版本链语义(缺文件→写出厂默认 / 等于出厂→幂等 / 用户手笔→**永不覆盖**)。
> - **行为零变化**:出厂 communicator 集合与 5b-1 P3 的硬编码名单逐字相同,`tests/server/communicator-readonly-tools.test.ts`(真 `createAgentSession` 端到端)2 passed —— 限权未松。
> - **诚实留空(非遗漏)**:planner / executor / harness_manager / critic / memory / reflection 的 `enforced` 仍为 **false** —— 它们没有工具循环,集合「已就位、未接线」。给它们写非空出厂名单 = 换个姿势继续撒谎。`tools.ts` 文件头留了**完整接线清单(4 步)**;接线时**必须**把旧出厂值追加进 `LEGACY_TOOL_SETS`,否则存量用户文件会被误判「用户手笔」永不升级(prompt 侧 5a/5b-1/7-B 已踩过三次)。`redLines` / `budget` 仍是硬编码字面量,属 harness 设计范围,不在本批。
> - **验证**:typecheck 0(server+web)· `npm test` **519 passed | 1 skipped(70 files)**(+16 新测试 = `tests/server/harness-tool-sets.test.ts`,守 ceiling / fail-closed / 不覆盖用户手笔)· build OK(`dist/src/server/harness/tools.js`)· `grep -rn 'as any' src/` = 0。唯一 failed 是 `tests/cli/daemon-start.test.ts > isAlive`,已用 `git stash` 在**干净 HEAD 上复现同一失败**(DSH 沙箱禁 `ps` → `readPidComm` 恒 null),与本批无关(见 `832870e` 已记录的归因)。
> - **⚠️ 批次号更正**:commit `12eaac5` 的 message 把本批写成「批次 7-C」,**与早前 7-C(clarify 对齐)撞号**;正确编号是 **7-E**(7-A/7-B/7-C/7-D 均已被占)。代码内全部 20 处已改对,历史 11 处 clarify 批次引用未动。**是否 `git commit --amend` + `push --force` 重写该 commit message 属不可逆操作,留 user 决定(未做)。**
> - **USER-side 生效条件**:重启 2718 server。启动即自动生成 `~/.sansheng/harness/tools/{7 个角色}.json`;改 `communicator.json` 的 `allow` 后,**下一次 start / resume / reset** 生效。往里写 `bash` 不会报错但也不会放行(进 `blockedByCeiling` + `log.warn` + UI 琥珀划线)。
> - **浏览器手动验证**:Harness 页新增 **③ 工具集合** 区块 —— 7 张卡(逐角色 `allowed` chip + 🟢生效中/🟡已就位未接线 徽章 + `enforceBasis` + warnings);沟通员卡应显示绿 chip `read grep find ls` + 🟢,planner/executor 应显示「无(集合 allow 为空)」+ 🟡;④ 配置 区只剩 redLines / budget 两项(enabledTools 已删)。**若看到 communicator 出现 bash/edit/write 徽章即为回归,请报回。**

> **v6.9 · 批次 6(2026-10-02 傍晚,DSH 会话,jev 闸门)**:
> - **用户报障**:「/Users/fuyao 这个默认的文件夹不对,应该给一个固定的文件目录」—— 出厂 `cwd = $HOME` 让 agent 的工作根是**整个家目录**。jev 裁决路径 = **`~/sansheng-workspace`**(conf 1.00:可见、与应用数据 `~/.sansheng` 物理分离、ASCII、避开源码仓库名 `~/projects/sansheng`)。
> - **本轮起点**:v6.8 基线 `d93f392` / 428+1(61 files);**终点 = `d93f392..HEAD` 共 3 commits(RED `7c6187c` → P1+P2 `451014d` → P3+P4)**,每 commit 立即 push。**新基线 445 passed / 1 skipped(63 files)**(+17 测试,typecheck 0,build OK,`as any` src/+web/=0)。
> - **P1 默认值固定化**(`src/server/settings/store.ts`):`const DEFAULTS` → **惰性** `defaultSettings()`,`cwd = join(os.homedir(), "sansheng-workspace")`。弃用 `process.env.HOME ?? "/root"`(env 可被 daemon/CLI 启动改写;`os.homedir()` 每次调用取当下真值,且测试可指临时 HOME)。导出 `DEFAULT_WORKSPACE_DIR_NAME` / `defaultWorkspaceDir()` / `legacyDefaultCwd()` / `isLegacyDefaultCwd()` 供测试与 kernel 复用,零处硬编码字符串。**自动创建**:load 期「生效 cwd == 出厂默认且目录不存在」→ `mkdirSync(recursive)`;失败降级 `log.warn` **不崩**;**只**为出厂默认建目录 —— 用户自定义路径绝不代建(防手滑路径被静默创建)。
> - **P2 存量迁移**(同一文件 load 期):持久化 `cwd` **严格等于**旧默认(`os.homedir()`,即历史 `process.env.HOME ?? "/root"` 的实际取值)→ 改写为新默认 + `log.info` 明示「migrated from the legacy default $HOME → …」。**相等判定,绝不做前缀/包含判定**(`$HOME/projects/x`、`$HOME-old` 是用户显式设置,不动);走既有 `save()`(批次 4b C5 原子写),**幂等** = 二次加载判据不再成立 → 不重复日志、不重复写盘(测试用 inode 不变作证)。损坏文件降级路径同样吃新默认。
> - **P3 会话级 legacy 映射**(`src/server/kernel/agentKernel.ts` 新增 `effectiveConvCwd()`):原 `conv.cwd ?? this.cwd` 两处 resume 写库点改为「空 **或** == 旧默认」→ 继承 `this.cwd`(= settings.cwd)。**不加写**:读侧映射即够,历史 $HOME 行由 resume 末尾**既有**的两条 upsert 顺带治愈(写进去的已是映射后 cwd)。**实测前提修正**:全仓唯一 `new AgentKernel` 在 `src/server/index.ts:54`,cwd 恒取 `settings.cwd` —— `conv.cwd` 从不进入 `createAgentSession`,它只是**被重复落库的记录**;修复前真实损害是 $HOME 被 resume 一轮轮写回 DB/UI,而不是把会话拽回旧根。
> - **P4 前端 + 文档**:`SettingsPanel.tsx` cwd 字段下新增一行 muted 提示(默认 `~/sansheng-workspace`、首次启动自动创建、可改任意绝对路径);`AGENTS.md` §编码纪律该行更正为新默认 + 惰性/迁移/只建默认/sandbox 无关四句要点;本 v6.9 块。
> - **主会话/worker 独立验证**:`typecheck` 0 · `npm test` **445 passed | 1 skipped(63 files)** · `build` OK · `grep -rn "as any" src/ web/src/` = 0 · smoke(临时 `HOME=/tmp/b6-home-*` + `SANSHENG_DATA=/tmp/b6-data-*` + 端口 **27197**):`/api/health` 200、`/api/settings` 的 `cwd = "/tmp/b6-home-MQFJSX/sansheng-workspace"`、`ls` 证实该目录被自动创建、WS `{type:"send"}` 回归 `offline_no_session` **恰 1**、kill 后 `lsof -iTCP:27197` 无监听 + curl connection refused。**2718 全程未碰;真实 `~/.sansheng` 零读写**(核对:测试后真实库 `messages` 无 17:48 后新增、`agent_states` 最新 17:37,均为用户 17:37-17:47 自己那次会话)。
> - **USER-side 生效条件**:**重启 2718**(批次收尾时该端口本就无监听进程,PID 32779 已不在;启动即自动建 `~/sansheng-workspace` 并把 settings.json 的 `"/Users/fuyao"` 迁成新值,启动日志有 `cwd migrated from the legacy default $HOME` 一行)。**注意:真实库里 `conversations.cwd` / `agent_states.cwd` 现存 `/Users/fuyao`**(迁移只改 settings,历史行靠 P3 读侧映射 + resume 治愈,不需要手工 SQL)。
> - **遗留**:①**sandbox 允许根未动**(本批次明确只改工作根,`tools/sandbox.ts` 仍走 `~/.sansheng/sandbox.json` policy + 默认 homedir+tmpdir 允许根 —— 「收窄写沙箱到工作根」是独立批次,未做);②`npm test` 会用真实 homedir 建出**空的** `~/sansheng-workspace`(既有测试的 SettingsStore 用真 HOME + 无 settings.json,首次 load 触发自动创建;幂等、生产启动本来也要建,故未加测试专用开关,如需彻底隔离再议);③`/api/config` 不含 `cwd`(只有 `/api/settings` 有),且 `port` 字段硬编码 2718 不跟随 `--port`,均为既有小瑕疵,未在本批次动;④PG 式 DB migration 编号未动(非 schema 变更)。

> **v6.8 · 批次 5b-1 / 5b-2 / 4a / 4b / UI(2026-10-02 上午→下午,DSH 会话,jev 闸门全程)**:
> - **本轮起点**:v6.7 基线 `602a718` / 263+1(33 files);**终点 HEAD = `ec5fb61`,新基线 428 passed / 1 skipped(61 files)**(+165 测试,typecheck 0,build OK,`as any` src/+web/=0)。5 个批次 25 commits 全部 push,每 commit 立即推。
> - **用户现场提出的架构问题**「沟通员是否可以一直处于 plan 模式,从机制上杜绝直接干活的可能?」→ jev 裁决 **A 方案 conf 1.00**,落地为双层机制保证:①**结构性路由**②**工具限权**。
> - **批次 5b-1 · 沟通员 plan-mode(4 commits `337ccab..6fca0e2`,基线 → 293+1/37)**:
>   - **P1 decide 升 LLM**:`makeLlmCommunicatorDecide`(completeSimple 微型 JSON 分类 {kind,taskGoal,ack},maxTokens 120/timeout 3.5s);解析失败/超时/无模型/`SANSHENG_DECIDE_LLM=0` **四路降级**保留的正则启发式;recentHistory ≤3×80 字符消歧;DI seam = `AgentKernelOptions.decideLlmCall`。
>   - **P2 task 只走 runPlan(§B2 双执行根治)**:task/feedback 在 `routeUserMessage` 后提前 return,不再 `session.prompt`;kernel 把交接确认翻译成合成 assistant turn(确认**恰一条**、先于 plan 错误到达、前端 banner 不被清);`persistHandoff` 落 raw+ack(顺带修离线 FK 会话行真 bug);turn_index 单调;task 离线不再重复 emit `offline_no_session`(5a.5 open#2 收编)。
>   - **P3 工具限权(机制层,非 prompt 软约束)**:**SDK 调研结论 = 可行** —— `CreateAgentSessionOptions.tools` allowlist 对 builtin/extension/custom 统一过滤且仅名单内激活(`_refreshToolRegistry isAllowedTool`)。直答 session = `tools:["read","grep","find","ls"]`(`agentKernel.ts:733`),bash/edit/write/powershell 全部剥离;Executor 走 llmCall 不经 Pi session,零影响。
>   - **P4 feedback 身份接线**(主会话新发现:extractor 5a.5 重写后只跑 assistant 文本,**用户说「记住:X」从不入库**):仅-user 侧 NAME_RE(我叫/我是)/LIKE_RE(我喜欢/讨厌)→ fragments + 身份 fact → `profile.name`。
>   - **P5 prompt 升级链**:`LEGACY_DEFAULTS` 改版本链数组(旧9行 → 5a44行 → 5b-1 46行),`ensureHarness` 三分支结构不变,跨代自动升级、用户编辑永不覆盖。
> - **批次 5b-2 · 回合后异步智能沉淀 + HarnessManager 启动(4 commits `6d97914..aec781c`,→ 312+1/40)**:jev 裁决 **A(保流式)**——不做 D7 字面 JSON 直答(丢流式 + 每次对话押注 JSON 遵循度),改回合后 fire-and-forget 小 LLM 调用从转录提取 artifacts(intent/decision/hypothesis/note),`metadata.source="sedimentation"`,代码层强制宁缺毋滥(kind 白名单/截断/去重/≤3/parse 失败静默/8s 上限),沉淀物=artifacts 与 fragments 快路径两套不混;`HarnessManager` 562 行死代码**在 boot 真正启动**(`harnessBoot.ts` 幂等 + SIGTERM/exit 退订),新增 `GET /api/harness` 只读状态(manager/stats/prompts 6 角色/config/proposals+notes);`proposals` 生产发射点**诚实留空**(executor D13 待 5c,强行接线=垃圾 proposal 自放大)。
> - **批次 4a · 数据完整性(4 commits `cffdcd0..2f526c7`,→ 340+1/48)**:**B3** sqlite-vec 生产真实加载(实证 applied=[1,3,4,5] 跳号)+ migration MAX 游标改**集合判定**自愈(002 幂等);**B8** boot 对账 `reconcileOrphanedRunArtifacts`(进程边界判据:新进程启动瞬间协调层必为空,构造器早于 HTTP listen/WS accept,一次性同步无定时器 → boot 后新建 run 永不被误杀);**C4** embedding upsert 事务化 + LRU 200;**C8** kernel 6 入口 FIFO `opChain` 互斥(abort 同步直调不入队,链内互调走 `*Inner` 防死锁)+ createPiSession 超时 seam/clearTimeout/迟到孤儿 dispose;**C9** isVecAvailable 按实例 + 目录缺失响亮 + 004 幂等 + `parseLimitQuery` 400。
> - **批次 4b · 进程卫生(7 commits `fd3b027..19295c8`,→ 419+1/58)**:**B5** `/api/reset` 不再把 server 变僵尸(删数据前 `kernel.prepareForDataReset()`:abort 在飞 plan/清 pending 回调/丢 Pi session)+ **密钥丢失链断开**(`preserved:[.keyring, settings.json]`;`Storage.reopen()` 默认**不**对账,`reconcileOrphans` 缺省 true 仅 boot;关键发现:`/api/reset` 从不经过 kernel FIFO 链,只有 `/api/kernel/reset` 在链内);**B6** resolveModel 不再改写 pi-ai 共享 catalog + 明文 key 不再进 process.env(四处 completeSimple 改显式传 apiKey;Pi session 链因 SDK ModelRuntime 必须有 env → 收敛为「建 session 前同步一次 active provider」);**B7** db/keyring/settings 权限收紧 600 + 原子 rotate + `docs/SECURITY-NOTES.md`(TOCTOU 威胁模型);**B9** executor 提问进 MessageBus + cancel_question 真正生效;**C1** bus handler `.catch` 兜底 + routeCallback 错误日志;**C2** abort 语义补全(Executor: await 后/副作用前 4 道守卫,命中即 `failed+artifactIds=[]` 不落库不发事件;Orchestrator: `aborted` 终态标志,解决批次 1 退订后实例「复活」);**C3** dropCycles 级联收敛+留痕;**C5** settings 原子写+损坏备份;**C6** WS 心跳;**C11** daemon 尊重显式 PI_OFFLINE=0;**C12** 文档/注释漂移(AGENTS.md 措辞+基线数字、PLAN.md M5 失实、ServerEvent 真身镜像位置更正);**4a-OQ2** limit 解析统一 400(blackboardRoutes)/**4a-OQ3** npm files 补 `migrations/`。
> - **批次 UI · 三 tab 启用 + C10 收口(5 commits `cc3d644..ec5fb61`,→ 428+1/61)**:**工件/目标/Harness** 三 tab 去 disabled 接真实数据源(`/api/artifacts?conversationId=&limit=`、`/api/harness`);**目标页走「intent artifact 投影」方案②**(查证: `shared/types/goals.ts` 零消费者 + migrations 无 goals 表 + HTTP 无 `/api/goals`,三项全否;页面顶部显著标注数据来源,零 mock,换真 M7 时只换数据源);C10 五项逐条收口(Esc 中断**接线**到既有 ws interrupt——推演中 textarea disabled 不派发键盘事件,故挂 window 级;currentUsage 接 `message_end.usage` 真实累加,空闲不渲染;ToolCallCard 两处 `as any` 消除 + 空串 ✓/⏳ 同屏实锤修复;Agents 页删死状态接 artifact `author` 真实角色维度 + 下线恒空 `/api/agents`;AgentPanel 换现行端点);**U3** `/api/health` 暴露 `vecLoaded`(刻意用 `isVecAvailable(db)` 而非 `Storage.vecLoaded`——后者 reopen 后是 stale 历史标志,报健康状态=又一处「看起来正常但不准」),顶栏仅降级时提示;**U4** `handleUserAnswer` decision artifact 落库失败即 fail-closed 不再 publish 悬空 executor_resume。
> - **主会话独立验证门(每批)**:git 为准 + 三件套复跑 + diff 抽查 + 自身 smoke(临时 dataDir + 2719x 端口,2718 生产进程全程未碰、真实 `~/.sansheng` 零读写)。关键实证摘录:task 消息 = 恰一条交接确认 + `no_api_key`、无重复 offline_no_session;「记住:我喜欢绿茶」→ `fact|我喜欢绿茶` 入库;`GET /api/harness` 200 `manager.running=true` + 6 角色状态;新库 migration 集 `1,2,3,4,5` + `fragments_vec` 存在;`POST /api/reset` 后 health/harness/conversations 全 200 + settings 保留 + 库重建后 WS 仍健康;db/keyring/settings 权限 `-rw-------`;`limit=abc` 两端点 400;`health.vecLoaded=true`。
> - **过程事故(记录以防复发)**: overnight 一次 subagent 僵死 9.5h(状态 [running] 但零落盘零进程)→ 判定法=git 零提交 + find 零文件活动 + ps 零进程,重派即恢复;一次因模型切换导致批次 4b 首次派工零落盘中断,同法重派;`/tmp` 草案文件被系统清理(以审查文档为唯一权威源,不影响)。
> - **遗留(均已备案,未做)**:①**5c**:executor D13 callbackReason 错位(HarnessManager 因此无 proposals 来源)+ `handleUserAnswer` 相关后续;②`/api/reset` 现只清会话数据,「含配置全清」需第二档确认(刻意不加,防密钥丢失链);③B6 env 残留彻底消除需改 `ModelRuntime.create({credentials: InMemoryCredentialStore})` 注入(要动 kernel.createPiSession + 全部真实 session 测试,建议单独批次);④B7 `rotate()` 仍需 `SettingsStore.rotateKeys` 参与才能安全接线;⑤工件页无分页/无全局 scope 切换;⑥目标页跨会话历史目标不可见(需真 M7);⑦`message_end.usage` 是否真带 token 需真实 LLM 推演一次确认;⑧commit `982d396` message 尾部 6 字符残渣需 force-push 清理(**不可逆,user-only**,未做);⑨notifyUser toast 通道(无 proposals 发射点=无内容可弹,收益为零)。
> - **USER-side 生效条件**:**重启 2718 生产 server**(仍在跑旧代码;harness md 将自动跨代升级为 46 行版,启动日志可见)。可选清理存量垃圾:`sqlite3 ~/.sansheng/sansheng.db "DELETE FROM fragments WHERE kind='summary';"`(已检索失活,删不删无害)。
> - **浏览器手动验证清单(三 tab)**:先在「对话」选一个会话(否则三页显示引导文案)→ **工件**:标题右侧「N 条」+ kind 过滤 chip(全部/意图/假设/笔记/决策,若有沉淀工件末尾多一个 jade「沉淀 N」),卡片含 kind+status 徽标、`author · 时间`、标题正文;空态提示发 `/plan` 触发。**目标**:标题下必有一行灰色小字声明「数据来源=本会话 intent 工件,M7 未实现,当前为投影视图」;每目标卡含状态徽标+进度条 `1/2 · 50%`+ todo 清单(✓/✗/◌)。**Harness**:绿色「● 运行中」+ `production-llm` 徽标;5 张卡(Manager 运行态 8 计数/角色 Prompt 6 行表格/配置 4 工具 chip+红线+budget/Proposals·Previews **应为空**并显示「当前没有任何 harness_proposal」/Notes 3 条 server 原文)——**若出现编造 proposal 条目即为造假,请报回**。**顺带**:推演中按 Esc 立即中断;顶栏空闲时不显示成本(旧「本轮 idle」已删);vec 正常时顶栏零提示。

> **v6.7 · 批次 5a + 5a.5(2026-10-01 深夜,DSH 会话,用户实测触发的两个问题)**:
> - **用户报障①**(沟通员需要提示词?)→ **5a**(3 commits `304ff04..0b854be`):44 行新默认 communicator prompt 融入 loader(「三生」第一人称/三重身份/直答模式禁 JSON/Observer 最小噪音;D7 结构化协议段排除,留 5b);`ensureHarness` 三分支升级(legacy 未编辑→覆盖升级、用户编辑→保留+log、新默认→幂等),用户手笔至上;chat 双回复修复(canned「已收到」移除,chat 唯一回复=Pi 直答)。**5a 关键发现**:`Communicator.ensureSession()` 无生产调用方,harness prompt 此前根本到不了直答 session(=审查 B1 实锤)。
> - **用户报障②**(发送的消息变成「# Relevant Memories...---User: xxx」blob + 垃圾记忆自我放大)→ 根因三层:ws.ts M3a 富集拼进用户消息 + kernel 把 enriched 全文落库(:884)+ extractor M2 占位把每条 ≥50 字符 assistant 回复原文存 summary(用户库已积 13 条 reasoning+回复垃圾,LIKE 检索命中→注入→模型模仿→再存,自放大)→ **5a.5**(4 commits `0459ba2..602a718`,jev B conf 0.99):
>   - **T1 raw/enriched 分离**:`kernel.prompt(text, {contextBlock})` — Pi session 收富集全文(记忆能力保留,进 Pi JSONL 用户不可见),**messages 表落 raw 原文**;extractor 删「assistant 全文存 summary」分支(留「记住:」fact);`searchFragmentsByText` 默认 kinds 排除 summary(存量垃圾失活不删数据)+ **顺带修复 kinds 参数与 SQL 占位符错序的潜在 bug**(默认生效后必炸,守护测试覆盖)。
>   - **T2 prompt 最后一跳**:`createPiSession` 改经 `createAgentSession({resourceLoader})`,`DefaultResourceLoader.appendSystemPromptOverride` 把 harness prompt 追加为 `<addendum>` 段(SDK 默认 preamble/tools 保留,append 非替换;start/resume/reset 重建即重新 loadHarness,用户编辑 md 即生效;空串回退零 diff)。选型论证:SDK CreateAgentSessionOptions 无 systemPrompt 直字段,before_agent_start 重且 request 级,agentDir 文件生成有覆盖用户风险。
>   - **T3 离线兜底**:无 session 分支 emit `error{code:"offline_no_session"}` 中文提示,前端 chat.ts 零改动兼容(主会话实测确认)。
> - **新基线**:typecheck 0 · **263 passed / 1 skipped(33 files)**(v6.6 的 244+1 → +19)· build OK · `as any` src/=0。
> - **代码 HEAD = `602a718`**(已 push origin)。主会话独立验证:三件套复跑全中 + diff 抽查 + T3 实测 + 端到端 smoke 受 keyring 隔离阻断(minimax-cn key 不随 settings.json 副本走——B7 设计使然,非回归;raw 落库由 kernel-context-block 测试 + 5a.5 subagent sqlite3/JSONL smoke 原文双覆盖)。
> - **生效条件**:用户生产 server(2718)重启后 — harness md 自动升级(有 log)+ 新 prompt 进直答 session + 消息不再变 blob。存量 13 条垃圾 summary 已检索失活;物理清理(可选,用户决定):`sqlite3 ~/.sansheng/sansheng.db "DELETE FROM fragments WHERE kind='summary';"`
> - **遗留**:task 双执行(onTask→runPlan ∥ session.prompt)刻意留 5b(提前 return 会让正则误判时失去直答);decide 正则升级 LLM、D7 respond 管道、HarnessManager 启动、Communicator.ensureSession 死路径统一、工件/Harness/目标 UI(三 disabled tab,M5/M6/M7)= 批次 5b+UI 批次;批次 4(生产卫生)草案在 /tmp/sansheng-batch4-prompt-draft.md;5a.5 open questions(task offline 事件并列抑制/LLM decide 是否吃 contextBlock)记入 5b 输入。

> **v6.6 · 全仓代码审查 + 批次 1-3 修复(2026-10-01 晚,DSH 会话,jev 全程决策闸门)**:
> - **审查**:`docs/CODE-REVIEW-2026-10-01.md`(commit `cef17ac`)——3 个并行只读 review subagent + 主会话抽查核实 + 脚本实证;8 P0 / P1×10 组 / P2×12;根因=组合根零测试覆盖(176 全绿是组件级假象)。
> - **修复范围 jev 裁决**:scope=B(批次 1-3=全部 P0,0.92/conf0.87);单 subagent 串行派工(0.86);批次间主会话独立验证(git 为准+三件套复跑+smoke)。
> - **批次 1(/plan 主链路,7 commits `f620c28..a02865b`)**:A1 TDZ(plan_done 移到 run settle 后,completeRun 先 resolve)、A2 僵尸 Orchestrator(finally shutdown + intent ownership + dispose 兜底)、A3 DAG 通配恒空(废 `"*"` 传真实 convId)、A4 decision.body 注入 resumed prompt + depth 按 todoId、B10-5 plan_done/plan_failed 进 shared union+chat store、**新集成防线 `tests/server/ws-plan-integration.test.ts`(真实 attachWebSocket+runPlan+Orchestrator+Storage,唯一 fake=llmCall 经 `AttachOptions.llmCallFactory` seam)**、追加 dep-failed 级联(上游 failed 即时递归 fail open 下游,run 不再等满 30min)。
> - **批次 1 语义决策(jev 校准)**:移除 `maybeResolveRunOnBlocked` 提前 settle(0.86 STRONG)——run() 现跨「提问→decision→resume」完整周期,settle 收敛为 intent 终态/abort/shutdown/maxRunMs 四路;todo 级失败 → **plan_done 带失败 summary**(与 B2 混合计划一致),plan_failed 保留给编排级错误(timeout/abort/shutdown)。
> - **批次 2(安全三件套,4 commits `1c13a65..77150c2`)**:A5 sandbox 写路径(parent real-vs-real 双闸门 + 最终组件 lstat default-deny + canvas 迁 `~/.sansheng/canvas` mkdtemp)、A6 redirect SSRF(`redirect:"manual"` 循环每跳重过 checkNetRequest,5 跳上限,`too_many_redirects`)、B4 CSRF/rebinding(新 `src/server/http/security.ts`:Host 白名单 421 + Origin hostname 级白名单 403(任意端口,保 vite proxy)+ SFS cross-site 拒 + WS upgrade Origin 钩子;注册在 logger/路由之前)。主会话独立攻击面实测:evil Origin POST /api/reset → 403,evil Host → 421,无 Origin curl → 放行。
> - **批次 3(连接与进程生命周期,4 commits `5f93ccc..dba03e6`)**:S1 kernel **多播 sink**(`sinks:Set` + `attachSink→detach` + `emit` 逐 sink 隔离;Pi session.subscribe 每 session 一次+存退订;start/reset/resume/prompt 全部去 sink 参数;`/api/kernel/reset` stub-sink 劫持根治)、S2 runPlan 进度 **broadcast**(wss.clients)+ setOnTask attach 级接线 + close 不 abort plan、S3 CLI reset 挂死(pause+setRawMode(false)+**unref**,实证仅 pause 不足)、S4 daemon 健康轮询(waitForHealth 10s)+ pid 身份校验(isNodeComm/readPidComm)+ 退出钩子 clearOwnPidFile、F1 App 级 socket 单例(`web/src/lib/appSocket.ts`,Timeline 按钮复活)、F2 bus_replay 客户端接线+按 id 去重+切会话清空(**B7 丢失的另一半补上**)、F3 ready 会话对齐(本地有 turns → load_conversation 让 server resume)、F4 pendingQuestions 乐观移除、F5 BusRow memo 修复(`busRow.ts` 30s 桶比较器)。listener 泄漏审计:无现存泄漏(真缺陷是 sink 闭包陈旧)。
> - **新基线**:typecheck 0 error · **244 passed / 1 skipped(28 files)**(+68 新测试,skip 仍为既有 e2e placeholder)· build OK · boot smoke(health 200 + WS ready + evil Origin 403 + evil Host 421 + vite proxy 200)。`as any` src/=0。
> - **代码 HEAD = `dba03e6`**(已 push origin,master 同步)。
> - **遗留(批次 4/5,见审查文档 §B/§C)**:sqlite-vec 生产死路径+migration MAX 不自愈、/api/reset 僵尸化、resolveModel 共享 catalog 改写+env key、keyring/db 权限形态、settings 静默清空+非原子写、B8 重启对账、B9 MessageBus 审计缺口、C 组杂项;批次5=D7/prompts/HarnessManager 接线+M5 角色。审查文档顶部已加修复状态横幅。
> - **USER-side**:批次 3 报告含 8 项手动浏览器验证清单(流式跨刷新/Timeline 按钮/重连回放/会话对齐/plan 跨刷新/重置按钮/时间标签/daemon 端口占用);真实 LLM E2E **现在才真正可测**(主链路已修通)。

> **v6.5 · 新机(macOS)基线修复 + jev 恢复(2026-10-01 下午,DSH 会话)**:
> - **新机验证全绿**:Node v26.8.1 · typecheck 0 error · **176 passed / 1 skipped(18 files)** · build OK · boot smoke(`/api/health` + `/api/conversations` + `/api/blackboard/global` + `/api/profile` 全 200,`PI_OFFLINE=1`)
> - **修复 2 个 macOS 兼容 bug(`f379c50`)**,新机首跑曾 10 tests failed:
>   1. `sandbox.ts resolve()` 校验 2 拿 realpath 结果与**未解链**的 allowlist entry 比较 → macOS 的 `/tmp`、`/var` 本身是 symlink(→ `/private/*`),合法 tmp 路径全部误报 `symlink_escape`。**不止测试,生产路径同样受影响**(默认 canvas `/tmp/sansheng-canvas` + `newCanvasDir()` 用 `osTmpdir()`)。修复:real-vs-real 比较(新增 `realFormOf` + `matchAllowReal`,entry 不存在时解最长已存在祖先后拼回);安全语义保留(case 10 workspace→/etc/passwd symlink 仍被拒);Linux 行为不变。
>   2. `fs.test.ts` / `integration.test.ts` afterAll 的 `rm(workspace+'/..')` → macOS `rmdir` 拒绝尾段 `..`(EINVAL)→ 改 `rm(dirname(workspace))`。
> - `package-lock.json` npmmirror 元数据漂移单独提交(`bfbf032`,hasShrinkwrap/hasInstallScript 字段,无依赖变化)
> - **jev skill 已恢复**(`~/.dsh/skills/jev/`,selftest 通过,model jev-1.13.0):全局 `~/.dsh/AGENTS.md` 新增 Jev 决策工作流段(用户手笔)+ 本项目 `AGENTS.md` §决策自主 补 jev 流程,待办 #4 关闭
> - MIGRATION-HANDOFF §7 项目侧验证清单已勾完;附录 B #7(jev-check regex)随 pi 扩展弃用,可关闭
> - 代码 HEAD = `bfbf032`(已 push origin);剩余待办以 USER-side 为主(8 manual browser tests + 5 blocker 真实 LLM 实测)+ e2e skipped placeholder
> **v6.4 · 5 E2E blocker 一锅端 (commits `6a522c4`..`e27a3c2`) + ARCHITECTURE.md (`c32c5c6`)**:
> - **B1** Planner/Executor llmCall 注入:`OrchestratorOptions.plannerLlmCall/executorLlmCall` + `ws.ts` 的 `makeLlmCall(kernel)` 工厂(包装 kernel.prompt streaming → Promise<string>)
> - **B2** Orchestrator 完成/失败 → 用户:`ws.ts runPlan` 的 sink 翻译 `completed` → ServerEvent `plan_done` (含 `buildPlanSummary()`) + `todo_failed` → `error` + Orchestrator run catch → `plan_failed`
> - **B3** Communicator ↔ Executor 回路:`kernel.handleExecutorCallback()` 桥接,Communicator 订阅 artifactBus 的 `executor_callback`,Executor emit hypothesis 时既发 bus 也写 messageBus 问题供 Communicator 决策
> - **B4** Communicator.task → Orchestrator.run:`CommunicatorOptions.onTask` 注入 + `setOnTask()` setter,ws.ts 在构造 Communicator 时挂 `({goal, convId}) => void runPlan(convId, goal)`
> - **B5** Orchestrator.routeCallback 默认:覆盖在 B3 修复(Communicator 走 bus 订阅)+ 测试覆盖 default router
> - **新文件** `tests/agents/e2e-blockers.test.ts` 443 行,11 个 it 块覆盖 B1-B5(10 passed + 1 skipped 是 placeholder)
> - 验证:176/176 tests pass on Node v22.23.3(typecheck / build / node sanity 全绿,dist = `dist/src/server/`)
> - **新文档** `/root/projects/sansheng/ARCHITECTURE.md`(12 层模块图,严格自顶向下,无交叉)
> - **5 commits 全部 push origin/master** = `e27a3c2`(HEAD + origin 同步)
> - **dist 路径变化**:`dist/server/` → `dist/src/server/`(tsconfig 输出 src 目录)— node sanity 用 `dist/src/server/ws.js`
>
> **v6.3 · http.ts:224 cleanup + Node 26.8.1 verified (commit `034175b`)**:
> - `src/server/storage/repo/fragments.ts` — 新增 `FRAGMENT_KINDS` (closed-set) + `isFragmentKind()` type guard;`listFragmentsByKind()` 现在接受 `string` 在内部 gate,invalid kinds 返回空数组
> - `src/server/storage/index.ts` — re-export `FRAGMENT_KINDS` + `isFragmentKind` + `FragmentKind` type
> - `src/server/http.ts:224` — `/api/memory/fragments` 移除 `kind as never`,raw query string 直接传(listFragmentsByKind 内部校验)
> - 验证:166/166 tests pass on **Node v26.8.1**(`/api/memory/fragments?kind=invalid_kind` → 200 + `{fragments: []}`,不再走错误路径)
> - `as never` 在 src/ 现仅剩 1 处:`registry.ts:114`(jev-accepted deviation,getBuiltinModel generics collapse)
>
> **v6.2 · as-any sweep (commit `9a312df` + `2de5aeb`)**:
> - 清掉 9 处 `as any` 全部 — `registry.ts:106/108`、`cost.ts:15`、`agentKernel.ts:156/385/457/489/641/643`
> - 新增 4 个 module-level type guards: `hasBaseUrl` / `hasCost` / `isStreaming` / `hasMsgShape`
> - 1 处 `as never` 残留 `registry.ts:114`(`getBuiltinModel` generics collapse `TModelId` to `never`,runtime safe)
> - 推动 AGENTS.md literal compliance(不再使用 `as any` 抑制类型)
>
> **M3+ 状态变化 (v6.0 → v6.1)**:
> - B6 (HarnessManager v0 reinforcement) 已 commit `df5d388`
> - B7 partial (Timeline BusRow memo) 已 commit `e735689`
> - better-sqlite3 v13 + Node 22 upgrade 已 commit `b7a8784`
> - @types/better-sqlite3 v9.6.0 bump 已 commit `bef7cd8`
> - 全部 11 commits 已 push origin/master
> - 附录 B 中 3 项已 close(B6 / push / C2 typo),仅剩 2 项 open(User Profile + manual tests)
> - 见末尾 **附录 C: M3+ 闭环总结 (v6.1 新增)**

---

## ⚡ 当前状态速览(2026-10-02 · 批次 U4 · 前端瘦身)

> **接新会话先读这一节,再往下读旧的 TL;DR(旧的已过时)。**

**HEAD = `37abc3c`,已 push origin/master。验证:typecheck 0 error · 全量
`npm test` **549 passed / 0 failed / 1 skipped(71 files)** · `npm run build` 成功 ·
规则范围内 `as any` = 0。**

### 🎨 批次 U4(2026-10-02 · commit `37abc3c`):六个页面瘦身 —— 只改前端

**起因**:用户原话「现在前端展示的文字内容太多了,而且 view 的结构不太适合人阅读,
你看看各个页面是否能优化一下,**我们只改动前端代码**」。

**读完全部七个页面后的判断**:问题不是「文案写得啰嗦」,而是**开发者自述被当成产品内容
渲染在了页面上**。典型:阻塞队列末尾 5 行讲「等待时长是估算值」、Agents 角色表下四段
讲「为什么只列 4 个角色」和「§1.1 术语规则」、Harness 每张 agent 卡带三处
`file:line` 依据、Goals 顶部一段讲「M7 还没实现,当前为投影视图」。

jev 决策闸门判定 **A(激进删减),conf 0.87 / needsUser 仅 0.46** → 不问用户,直接执行。

**做法:文字分层,不删信息。** 反造假纪律没放松 —— 一个数从哪来、阈值是估算还是实测,
仍然查得到,只是从「必须逐页读」降级为「悬停 / 点开」:

| 层 | 去处 | 例子 |
|---|---|---|
| 结论 | **留屏幕上**,最短的真话 | 「已等 6 分 12 秒 · 超 5 分钟阈值」 |
| 「为什么这么算」 | `title=`(悬停)/ `<Disclosure>`(点开) | 等待时长的估算口径(原文一字未改) |
| 「为什么系统是这个形状」 | **文件头注释** | §1.1 术语规则、critic/memory/reflection 为何不列出 |

**结果:默认上屏中文字数 3040 → 2039(-33%)。**

| 页面 | 前 | 后 | |
|---|---:|---:|---|
| Agents | 639 | 392 | -39% |
| Harness | 1014 | 611 | -40% |
| Artifacts | 412 | 296 | -28% |
| Goals | 131 | 78 | -40% |
| Timeline | 217 | 173 | -20% |
| SettingsPanel | 254 | 166 | -35% |
| AgentPanel | 71 | 48 | -32% |
| MessageList | 43 | 25 | -42% |
| **Memory** | 29 | **50** | **+72%,唯一变多的一页** |

Memory 变多是**有意的**:它从 29 字的**两列裸列表**变成「按 kind 分组 + 真实计数 +
置信度/证据/观察时间」,多出来的字全是**以前根本没显示的字段标签**,不是说明文字。

**结构层面的改动**(不只是文案):

- 新增 `web/src/components/ui/primitives.tsx` —— 把「字号 = 语义」变成有类型的事。
  此前 `style={{fontSize:10}}` 之类的行内样式在 7 个页面手抄两百多次。
- 新增 `web/src/lib/artifacts.ts` —— `useArtifacts()` + 5 张词表。此前同一份读取函数
  与同一批词表被 4 个页面各抄一遍**且已经漂移**(Goals 的 `open` 写「进行中」、
  Agents 写「待处理」)。
- `--cyan` 正式入 token。此前页面一律写 `var(--cyan, #4cc9c0)` 走 fallback,
  而 tokens.css 里根本没有 `--cyan`。
- 滚动容器与 `<main>` 收归 App 一处。早前每个路由组件自己渲染
  `<main className="px-4 pb-4">`,DOM 里是**嵌套 `<main>`(非法 HTML)**。
- 分区名去掉产品设计文档的行号(「① 意图头 / ② DAG 区」对读者零信息量)。

**顺带修掉的三处「界面在骗人」(与 c10-dead-code 同一类问题)**:

1. `ChatComposer` 的 `placeholder` prop **一直是死的** —— ChatSurface 算好三档
   (kernel 未就绪 / 没配 Key / 正常)逐层传下来,组件**根本没解构它**,
   textarea 里写的是写死的「正在生成…」。现在接线。
2. 同一份 error **渲染两遍**(ChatSurface 页头下方 + MessageList 流尾)。只留后者。
3. AgentPanel 里 critic / memory / reflection **三行恒为 idle** —— 同一决定 Agent 页
   早已整行删除,侧栏却还留着,两个视图不一致。

**Agents 页的一个真 bug**:旧的渲染条件 `missingDeps || selfDep || dependsOn.length > 0`
让**每个有依赖的正常节点**都打印一行「缺失依赖 …」样式的文字(因为有 `dependsOn` 就满足)。
现在无异常一个字都不打。

**新增守护**:

- `scripts/web-text-volume.mjs` —— 数**默认上屏**的中文字数。关键在于它排除
  `title=` / `hintTitle=` / `<Disclosure>` 整块 / 只在隐藏位置被引用的 `*_NOTE` 类常量。
  **若只数字面量,前后是平的**(字都还在,只是不再常驻)—— 那种度量会逼着下一批
  **为了刷分去删真信息**,与反造假纪律相反。这个坑脚本文件头记了完整推导。
- `tests/web/text-volume.test.ts` —— 29 条断言:每页上限 + 总量上限 +
  「重点页面确实比 U4 之前少」+ 「①②③④ 分区名与 LifecycleTrack 不许回来」。
  断言**先剥注释再判定**(文件头注释里**应该**保留「原来的 ① 意图头 已删」这类说明)。

**零后端改动、零新依赖、零数据流变更**:同端点、同字段、同真实计数。
Timeline 的两层 `React.memo` / `busThreadPropsEqual` / `buildThreads` 的引用稳定性
**逐字未动**,`lib/busRow.ts` 未触碰(那个比较器有单测,是冻结的)。

**未做浏览器实测**:本项目的手动浏览器验证一直是 USER-only(见下方「已知待办」1)。
本批的验证止于 typecheck / test / build + 子 agent 对真实数据的 SSR 渲染。

---

## ⚡ 上一节:批次 8 · P0 已完成(2026-10-02 · commit `aa5b113`)

> **接新会话先读这一节,再往下读旧的 TL;DR(旧的已过时)。**

**HEAD = `aa5b113`,已 push origin/master。验证:typecheck 0 error · 全量
`npm test` **504 passed / 0 failed / 1 skipped(69 files)** · `npm run build` 成功 · 规则范围内 `as any` = 0。**

### 🔧 真实事故已修(2026-10-02 20:15 · commit `aa5b113`):conv_muqwgghs_4q0u 调研任务整轮报废

**现场**:用户 `sansheng start` 后在 web 上发起「百万级催收外呼语音机器人技术调研报告」,
planner 拆出 7 个 todo,todo-1~4 成功,**todo-5 / todo-6 `Executor · parse failed`,
todo-7 被级联带走 → 整份报告没交出来**。现场原样存在 note `exec-err-boBJpM8r` / `exec-err-uBDq-rMU`
的 body 里(各存前 500 字符)。

**根因是两个独立 bug,叠加后表现为「模型明明交了完整产物,系统说 parse 失败」**:

| # | 位置 | 现场形状 | 为什么炸 |
|---|---|---|---|
| ① | `executor.ts` `inferOutcome` | `{"outcome":"","status":"in_progress","evidence":{…}}` | 把 `outcome:""` 判成「非法取值」→ 直接 `return null`,**批次 7-D 的形状推断根本没机会跑**。evidence 是完整的。实测同一份 payload **删掉** outcome 字段就正常救回。 |
| ② | `shared/jsonRepair.ts` | `{"evidence":{…长 markdown 表格…}}` | 长表格里混进了**未转义的真实换行**。旧 `repairTruncatedJson` 把括号和闭引号都补对了,但裸换行仍是字符串里的控制字符,`JSON.parse` 第二次照样抛 `Bad control character in string literal` → **救回被整体丢弃**。 |

**修法**:① 空串语义等同「没写」,只在取值**非空且**非法时才判失败(`"success"` 这类说错话的原样拒绝,测试仍在);
② 修复后过一道 `escapeControlCharsInStrings`,只转义字符串字面量**内部**的控制字符,正文一个字节不丢;
严格 parse 成功的路径根本不进这一层。

**排查手法(可复用)**:`npm run diagnose` 定位到 note → 从 `blackboards.artifacts_json` 捞出
**逐字**现场 raw → 用真实 `parseJsonLenient` + 逐字复刻的 `inferOutcome` 离线复现 →
**穷举扫描**排除「截断」等显眼嫌疑(本例 303 + 2266 个截断点 100% 能救)→ 剩下的失败面就是真凶。
只存 500 字符这点很吃亏,现场分析**必须**先捞 DB 原文。

⚠️ **待办**:`handleParseFailure` 只存前 500 字符(`executor.ts:527`),现场取证不够用,
建议改成存全量(压缩/截断上限提到 4k)+ 记录 `stopReason`,否则下次同类事故仍要靠猜。


✅ **此前记为「既有的 1 个失败」的 `tests/cli/daemon-start.test.ts:70` 已定性 —— 不是代码缺陷,
是 DSH 沙箱的假象(2026-10-02 20:06 更正)。** 本节早前版本归因为「`isAlive` 依赖 `readPidComm`,
平台相关(本机 macOS)」——**该归因是错的**,已在无沙箱环境证伪。

**真根因**:`readPidComm`(`src/cli/commands.ts:68-79`)用 `execFileSync("ps", ...)` 读进程命令名。
在 DSH file-sandbox(`workspace-write`)下,**spawn 子进程被拒,抛 `spawnSync ps EPERM`**;
`readPidComm` 的 `catch` 吞掉异常返回 `null` → `isNodeComm(null) === false` →
`isAlive` 对**任何** pid 都返回 false → 「对本测试进程返回 true」这唯一一条反向断言必然挂。
同文件另外两条断言(非 node 进程→false、不存在 pid→false)在 `ps` 挂掉时**恰好蒙对**,所以只挂一条。

**证据**:同一测试文件在无沙箱下 **8/8 全过**;`ps -p $$ -o comm=` 在无沙箱下正常返回(`/bin/ps`,Darwin 27.0.0)。
**结论:代码无需改动。** 在 DSH 沙箱内跑 `npm test` 会稳定复现这 1 条假失败;换普通终端或无沙箱环境即消失。
判定这类假失败的通用手法:先单独 `node -e` 复现被禁的 spawn,再无沙箱对照跑一次同一测试。

**P0 六项已全部落地**(4 个并行子任务 + 1 项集成补录,文件互不重叠):

| 项 | 文件 | commit |
|---|---|---|
| §3 blackboard 四区 + §1 角色表 + 失败原因可见 | `web/src/routes/Agents.tsx` | `6b45d39` |
| §4 工件按沟通语义分组 + 待转述视图 | `web/src/routes/Artifacts.tsx` | `ee80ca0` |
| §6 harness 雇员手册 + 三档生效徽章 | `web/src/routes/Harness.tsx` | `a70f464` |
| §5 总线线程化 + 方向分道 | `web/src/routes/Timeline.tsx` | `4ebe2bb` |
| 集成补录:`.sansheng-input` 定义(此前是空 class) | `web/src/styles/globals.css` | `d739a27` |

**设计定稿在 `docs/PRODUCT-DESIGN-2026-10-02.md`**(先读它,里面有全部 file:line 证据 + 4 条实施勘误)。

**诊断(一句话)**:**产品不是太简单,是展示的系统模型和真实系统对不上** —— 三个错位:


1. **角色表在撒谎**:UI 展示 6 个 agent,系统只跑 4 个。`critic`/`memory`/`reflection`
   无 class 实现、无 prompt 消费者。**用户已决定:暂不实现,界面改为不列出**(不等于从
   `RoleKind` 删除 —— 删要动共享类型 + 481 测试基线,保留不动)。
2. **真数据在出进程时被丢弃**:`Orchestrator` 持有 `activeExecutors`/`waiting`/`depthByTodo`
   但全是 `private` 无 getter;`ws.ts:358-373` 丢弃 9 个 `ProgressEvent` 中的 7 个;
   `/api/agents/:id` 硬编码 `{agents:[]}`。
3. **工件被当成日志渲染**:模型是对的(10 kind + author + status 状态机),但按时间倒序平铺。

**排期**:
- **P0(本批,进行中)** —— 6 项,全部是**已有数据的重新组织**,不动 DB / schema / 事件流:
  blackboard 四区工作面 / 工件按沟通语义分组 + 待转述视图 / harness 雇员手册 + 三档生效徽章 /
  角色表只列 4 个 / 总线线程化 / 失败原因上屏。
- **P1** —— 补发被丢弃的 7 个 `ProgressEvent`、Orchestrator 状态快照 getter、
  **`agent_run_traces` 表(migration 006)**、`AgentRunSummary` 复活、
  真实 `/api/executors/:id/state`、`harness_proposal` 发射点。
- **P2** —— harness 写接口、总线→工件闭环、`enabledTools`/`redLines`/`budget` 变成真配置。

**两条已推翻的旧结论(别再走一遍)**:
- ❌「planner/executor 的过程数据拿不到,得等 P2」→ **错**。`completeSimple` 返回完整
  `AssistantMessage`(含 thinking / usage / **真实 cost** / stopReason),`ws.ts:220-224` 只收文本
  其余全丢。数据一直在内存里,是「记下来」不是「拿不到」。详见设计文档 §2.1。
- ❌「harness proposals 为空是因为代码读顶层 `callbackReason` 而提示词写在 metadata 下」
  → **证伪**。真正生效的 `loader.ts` 默认提示词要求顶层,与 `executor.ts:343` 一致。
  真实断点是 **kind 不匹配**:manager 只认 `kind==="harness_proposal"`,
  executor 阻塞时**恒**发 `kind==="hypothesis"`。

---

## TL;DR

Sansheng = 单用户本地 Node 服务。M0-M4 + M3+ B1-B7 + 2 dep bumps + http.ts:224 cleanup + **5 E2E blocker closure** + **ARCHITECTURE.md** 已 commit + push(17 commits remote,origin/master = `e27a3c2`)。
**当前 M3+ 进展**(全部 ✅):
- ✅ **B1** 已 commit(`36694c6`) — BlackboardArtifact v3 + storage + HTTP
- ✅ **B2** 已 commit(`aeec7f6`) — Communicator 3 identities + bus events + Live Trace
- ✅ **B3 + B4** 已 commit(`7228268` + `640204f`) — Orchestrator + Planner + Executor + HarnessManager event-sourced rewrite
- ✅ **Communicator fix** 已 commit(`06abfcc`) — wire user-customized systemPrompt 到 DefaultResourceLoader
- ✅ **B5** 已 commit(`33d60dc`) — Planner + Executor reinforcement(LLM graceful failure + DAG cycle detection)
- ✅ **B6** 已 commit(`df5d388`) — HarnessManager v0 reinforcement(decideFn timeout + HarnessManagerStats + observability)
- ✅ **B7 partial** 已 commit(`e735689`) — Timeline BusRow memo
- ✅ **better-sqlite3 ^13 + Node 22** 已 commit(`b7a8784`)
- ✅ **@types/better-sqlite3 ^9.6.0** 已 commit(`bef7cd8`)
- ✅ **C2 server smoke** 全绿(8min,无 commit)
- ✅ **http.ts cleanup** 已 commit(`034175b`) — `listFragmentsByKind` 用 `isFragmentKind` gate,http.ts 不再 cast
- ✅ **5 E2E blocker closure** 已 commit(`6a522c4`..`e27a3c2`) — user→communicator→blackboard→workers→communicator→user 端到端流程可跑通
- ✅ **ARCHITECTURE.md** 已 commit(`c32c5c6`) — 12 层模块图,严格自顶向下,无交叉

**当前坐标**:**代码 HEAD = `bfbf032`**(v6.5 macOS 修复 `f379c50` + lockfile 漂移 `bfbf032`,其上是本次 docs commit),git clean,**176/176 tests pass**(Node v26.8.1 · macOS 全绿,1 skipped placeholder)。
**origin/master 已同步**(push-first)。

---

## 1. 当前代码状态

```
e735689 perf(timeline): B7 partial · memo BusRow on stable msg reference
33d60dc M3+ B5: Planner + Executor reinforcement
06abfcc fix(communicator): wire user-customized systemPrompt to DefaultResourceLoader
640204f M3+ B3+B4 fixup: align with spec
7228268 M3+ B3+B4: event-sourced Orchestrator + Planner + Executor + HarnessManager
357bb04 wip(M3+): B3+B4 partial work before isolated resume
d3a6896 docs(handoff): v5.1 — M3+ B1+B2 done + worker prompts ready for B3+B4+C2
aeec7f6 (origin) feat(communicator): B2 3 identities + bus events + Live Trace
```

**完成清单**:

| Batch | Commit | 内容 | Tests |
|---|---|---|---|
| **B1** (origin) | `36694c6` | BlackboardArtifact v3 + storage migration + HTTP endpoints | +49 tests |
| **B2** (origin) | `aeec7f6` | Communicator 3 identities + bus events + Live Trace | +2 tests |
| **B3** | `7228268` | Orchestrator event-sourced 重构 | +24 tests |
| **B4** | `7228268` (合 B3) | HarnessManager v0 + Harness UI + CallbackRouter flat shape | (合 B3) |
| **B3+B4 fixup** | `640204f` | 对齐 spec: Orchestrator event 序列 / Executor evidence todo transition | (改测试) |
| **Communicator fix** | `06abfcc` | DefaultResourceLoader 注入 user systemPrompt + vi.hoisted mock test | +1 test |
| **B5** | `33d60dc` | Planner LLM graceful failure + DFS cycle detection; Executor abort() | +6 tests |
| **B7 partial** | `e735689` | Timeline BusRow memoization on stable msg ref | (perf only) |
| **C2** | (无 commit) | Server boot + 4 endpoint smoke,8min 全绿 | n/a |
| **http.ts cleanup** | `034175b` | `isFragmentKind` type guard + remove `kind as never` cast | 166/166 pass |
| **5 E2E blocker closure** | `6a522c4`..`e27a3c2` | Planner/Executor llmCall 注入 + sink 翻译 plan_done/plan_failed + Communicator.handleExecutorCallback 桥接 + onTask 注入 + E2E 测试 | 176/176 pass |
| **ARCHITECTURE.md** | `c32c5c6` | 12 层模块图,严格自顶向下,无交叉 | n/a |

**Tests**:**166/166 pass** (132 → 157 → 163 → 166)

---

## 2. M3+ 架构(15 decisions 锁定)摘要

### 三重身份 (Communicator)
1. **Reactive input** — 接收 user / worker 消息
2. **Plan producer** — 触发 Planner → Executor 链路
3. **Proactive observer** — Intent resolved/failed 时汇报(用户 m00541: 最少噪音)

### 4 Flows (见 PLAN.md §"The Four Flows")

详见 PLAN.md,核心是**Executor 阻塞回调**(用户 message) + **全局 + per-conv 双 blackboard**。

### BlackboardArtifact v3 (PLAN.md §"Data Model")

7 种 kind + execution tracking + DAG ordering:
```
{ kind, status, conversationId?, author, body, parentIntent?, dependsOn[], executors[], createdAt, updatedAt }
```
Kind: `decision / hypothesis / harness_proposal / implementation_preview / intent / todo / note / evidence / critique / reflection`

### 5 bus events
```
artifact_created              // bus broadcast when BlackboardArtifact upserted
artifact_status_changed       // 状态变更(resolved / failed / open / etc)
executor_callback             // Executor 阻塞请求 Communicator decision
executor_resume               // Communicator 决策后 Executor 继续
harness_proposal_created      // Executor 发出的 harness 提案
```

---

## 3. ✅ 已完成 (B1-B5 + B7 partial + C2)

### B1 (`36694c6`) — BlackboardArtifact v3 + storage + HTTP
- `shared/types/blackboard.ts` (NEW) — v3 schema
- `shared/types/bus.ts` (NEW) — bus event types
- `src/server/storage/repo/blackboards.ts` — upsertArtifact / updateArtifactStatus / getArtifact / listArtifacts
- `migrations/005_blackboard_artifacts.sql` (NEW) — artifacts_json 列
- `src/server/http.ts` — `/api/blackboard/:id`, `/api/blackboards/:id`, `/api/blackboard/global`, `/api/artifacts`, `/api/artifacts/:id`, `/api/executors/:id/state`
- **冲突解决**:`@shared/*` runtime alias 不解析 → 改相对路径

### B2 (`aeec7f6`) — Communicator 3 identities + bus events + Live Trace
- `src/server/bus/index.ts` (NEW) — publish/subscribe API
- `src/server/kernel/agentKernel.ts` — switch 扩展 `user_reply` + `artifact_created`
- `src/server/ws.ts` — 5 新 WS events
- `shared/types/ws.ts` (NEW)
- `shared/prompts/communicator.md` (NEW) — D7 structured output + Intent 验证 + Harness risk 分类

### B3 (`7228268`) — Orchestrator + Planner + Executor
- `src/server/agents/orchestrator.ts` (重写) — event-sourced Orchestrator with:
  - Events: `intent_received / todos_planned / todo_started / todo_resolved / callback_routed / callback_escalated / decision_received / completed`
  - Methods: `init() / run() / abort() / shutdown()`
  - Watchdog:5min escalation / 1hr fail
  - Depth limit = 3
- `src/server/agents/planner.ts` (NEW) — `Planner` 类,JSON todo 数组协议,DAG 约束
- `src/server/agents/executor.ts` (NEW) — `Executor` 类,evidence / hypothesis-judgment / hypothesis-harness_proposal / failed 四路径
- `shared/prompts/{planner,executor}.md` (NEW)

### B4 (`7228268`) — HarnessManager v0 + Harness UI
- `src/server/agents/harnessManager.ts` (NEW) — `decideFn` 注入式,dedupe (seen/inFlight/existingPreviewFor),failure note
- `web/src/components/agents/Harness*` — Harness UI cards

### B3+B4 fixup (`640204f`)
- 对齐 spec: Orchestrator event 序列对齐 + Executor evidence 路径加 todo status transition
- 测试失败 4 个 → 修复

### Communicator fix (`06abfcc`)
- `src/server/agents/communicator.ts:24` — 加 `DefaultResourceLoader` import
- `src/server/agents/communicator.ts:285` — 构造 resourceLoader 注入 `opts.systemPrompt`
- `src/server/kernel/agentKernel.ts:203` — 去掉 `?? ""` fallback,让 undefined 透传(loader 用默认 AGENTS.md)
- `tests/agents/communicator.test.ts` — 新增回归测试 + vi.hoisted mock 真验证 loader 构造

### B5 (`33d60dc`) — Planner + Executor 强化
- `src/server/agents/planner.ts`:
  1. **LLM throw graceful** — 写 failure note + intent status='failed',不再 propagate
  2. **DAG cycle detection** — DFS three-color(white/gray/black)标记 cycle 节点并 drop
- `tests/agents/planner.test.ts` +4 cases (zero-valid, dependsOn-unknown, A↔B mutual, A→A self) + LLM-throws 重写
- `tests/agents/executor.test.ts` +2 abort() cases

### B7 partial (`e735689`) — Timeline BusRow memoization
- `web/src/routes/Timeline.tsx` — React.memo 包裹 BusRow + 自定义 prev.msg === next.msg 比较
- **其他 B7 改动未 commit**:`web/src/stores/chat.ts` 加 busStream 清空 + WS 重连触发 `bus_replay`

### C2 (无 commit) — Server smoke
- `npm run dev` boot OK (port 2718)
- 4 endpoint 全 200: `/api/health`, `/api/conversations`, `/api/blackboard/global`, `/api/profile`
- ⚠️ **HANDOFF §C2 路径需修正**:`?scope=global` 实际是路径 `/api/blackboard/global`
- ✅ Profile "暂无 profile" = empty state 正常(无 data 触发)

---

## 4. ❌ 未完成

### B6 — Harness Manager 强化(worker 死亡,未 commit)

**Lost work** — `del_muns7uct_bpe4` 死亡,`/tmp/acp-delegate/` 被 systemd 清。无 commit,无法溯源。

**Plan 改进点**(已知建议,scope 待 worker 重新评估):
1. `decideFn` timeout 防护 — `decideTimeoutMs` 默认 60_000
2. `HarnessManagerStats` 计数器 — received / processed / failed / skippedSeen / skippedStorageDedup / skippedInFlight / seenSize / inFlightSize
3. observability improvements
4. 去重逻辑 review(seen vs existingPreviewFor vs inFlight)
5. 测试覆盖 review(happy / error / edge)

**重新派工建议**:scope "读现有 harnessManager.ts + 列 3-5 个改进 + 实施 + 加 test"。**注意用 `TMPDIR=~/.cache/tmp` 的新会话**(避免再丢)。

### B7 partial completion

- ✅ Done: Timeline BusRow memo (e735689)
- ❌ Not yet: `web/src/stores/chat.ts` 加 busStream 清空 + bus_replay 触发 — 改动在 working tree 但未 commit,可能被覆盖或保留(检查 git stash / reflog)

**重新派工建议**:scope "B7 完整化 — 切会话清空 busStream + WS 重连触发 bus_replay + e2e 验证"。

### 8 manual verification tests(USER-only)

- UI 端到端测试,需用户在浏览器手动触发
- 本机 smoke 不覆盖
- 必须用户在机器前

### Node v26.8.1 环境适配(2026-10-01 已验证 ✅)

- **结论**:**better-sqlite3 v13.0.3 在 Node v26.8.1 上原生兼容,无需版本调整**
- 机制:v13.0.0 切换到 N-API(ABI 跨 Node 版本稳定),prebuilds 是 per-platform(`linux-x64.node` 等 8 个)非 per-Node-version
- 验证(本地):下载 Node v26.8.1 → `npm rebuild better-sqlite3 --build-from-source` → 166/166 tests pass → server boot → `/api/health` 200 + `/api/memory/fragments?kind=invalid_kind` 200 + `{fragments:[]}`
- **Future-proof**:任意新 Node LTS(27/28/29...)发布后,只需 `npm rebuild better-sqlite3 --build-from-source` 一次
- ⚠️ **glibc ABI 风险**:v13.0.3 prebuild 用 glibc 2.x 链接,Linux 上如系统 glibc < 2.17 可能 load 失败(需 from-source rebuild)
- ⚠️ **jev-check false positive**:regex `/ /` 误匹配路径分隔(如 `/tmp/a /tmp/b`),后续待修(无关本次功能)

---

## 5. 派工模板(开盒可用)

### B6 重派 prompt 草稿

```ts
acp_delegate({
  agent: "worker",
  task: `## Sansheng M3+ B6 · Harness Manager 强化(retry)

### 背景
- HEAD = \`e735689\` (B5 done, B7 partial done, B6 lost — 重派)
- 163/163 tests pass
- 已有 harnessManager.ts (在 B4 写的)

### 任务
读 harnessManager.ts + tests/,列出 3-5 个改进点,实施 + 加测试。

### Scope (DO)
1. Phase 0 (5 min):读现有 code,列改进点
2. 实施 3-5 个改进(按优先级)
3. 加 / 改 tests
4. npm run typecheck clean / npm test 163→N+ pass
5. commit

### Scope (NOT DO)
- 不改 orchestrator / planner / executor(B5 done)
- 不改 storage / DB / HTTP routes
- 不做 sqlite 升级 / B7 补完

### 9 项 report 必含
git log / status / typecheck / test / build / 改进点 / files / open questions

### Timeout 45 分钟`,
  cwd: "/root/projects/sansheng",
  model: "balanced",
  async: true,
  timeoutMinutes: 45,
});
```

### jev 替代选择题

未来选择题(包括 sequencing)默认用 jev(`/root/.pi/skills/jev/scripts/jev.sh`),state 写满 5 个段:
1. **现状数据** — 数字 / commits / test count / file path
2. **选项细节** — 每个做什么 + 何时 + 多少
3. **依赖图** — 哪个 blocks 哪个
4. **User 历史信号** — 偏好 / 过去选择模式
5. **Risk profile** — 每选项 known unknowns

详见 MEMORY.md §"Jev 使用方法论"。

---

## 6. 工作流 & 偏好

### 派工标准

- 编码工作**一律派 worker** — Main 不写大量代码
- 工具:`acp_delegate` agent=worker,async=true,model=balanced
- runId 必记录 daily log,完成通知会自动到
- **不要 `sleep N && tail` 轮询** — 等通知即可

### acp_delegate 已知陷阱(从 m01507 IO 读打爆问题学)

- worker activity 文件在 **`$TMPDIR/acp-delegate/`**(`/tmp/acp-delegate` 默认)
- **新会话**已用 `TMPDIR=~/.cache/tmp`(写 `~/.bashrc`),持久化 OK
- **本会话** Pi 进程重启前仍用 `/tmp` — 不会被 systemd 清,**直到下次启动**
- Worker 死亡模式:**长时间 npm test 阻 throttle + 30min timeout + 5min idle watchdog** 是已知 death pattern
- 预防:worker prompt 加 "**`read` 必须 offset+limit** + **`npm test` 跑 1 次就够** + **已读文件 search_context 不重读**"

### jev skill 已安装

- `~/.pi/skills/jev/scripts/jev.sh`
- 3 primitives: noul / choice / score
- 需 `TYPESAFE_API_KEY` env(已配)
- selftest: `~/.pi/skills/jev/scripts/jev.sh selftest`
- **新会话自动加载**,本会话需 `/reload`

---

## 7. 文件指针

- **主 plan**:`/root/projects/sansheng/PLAN.md`(823 行,v5 集成版)
- **handoff**:`/root/projects/sansheng/HANDOFF.md`(本文件,v6.2)
- **memory**:`/root/.pi/agent/memory/MEMORY.md`(长期偏好 + 教训)
- **daily log**:`/root/.pi/agent/memory/daily/2026-09-30.md`(本日工作流)
- **scratchpad**:`scratchpad tool`(working context)

---

## 8. 启动新会话推荐顺序

1. 读这 3 个文件: HANDOFF.md / PLAN.md / MEMORY.md(开盒)
2. `git log --oneline -10` 看 HEAD / `npm run test` 确认 baseline
3. 决定下一步优先级 — **建议先 push 7 commits**(clean state),再派 B6 重做
4. 任何决策先用 **jev**(state 写满 5 段)
5. 派工用 **acp_delegate** 不轮询,等通知

---

## 附录 A: 关键文件清单

### src/server/agents/
- `orchestrator.ts` (550 行) — event-sourced,主控
- `planner.ts` (515 行,B5 后) — JSON todo + DAG cycle detection
- `executor.ts` (~400 行,B5 后) — 4 outcome paths + abort()
- `harnessManager.ts` (~400 行,B4) — 待 B6 强化
- `communicator.ts` (~600 行,06abfcc) — 3 identities + DefaultResourceLoader
- `messageBus.ts` — publish/subscribe

### src/server/kernel/
- `agentKernel.ts` (06abfcc) — switch dispatch + systemPrompt 透传

### shared/types/
- `blackboard.ts` — BlackboardArtifact v3
- `bus.ts` — bus events
- `agents.ts` — RoleKind enum
- `ws.ts` — WS event types

### shared/prompts/
- `planner.md`, `executor.md`, `communicator.md` — LLM system prompts

### web/src/
- `routes/Timeline.tsx` (e735689) — Live Trace timeline + BusRow memo
- `stores/chat.ts` — busStream + WS reconnect (B7 partial, not committed)
- `components/agents/` — AgentPanel / HarnessCards

---

## 附录 B: Open issues / Follow-ups

1. **[BUG · remote verification]** User Profile "暂无 profile" — 已知是 empty state 正常(无 data)。需用户在 UI 触发 M3 reflection 才会生成内容。**STILL OPEN** — 需 UI 触发。
2. ~~**HANDOFF §C2 路径描述错误**: `?scope=global` → 实际 `/api/blackboard/global`~~ ✅ **CLOSED (v6.1)** — C2 server smoke verify pass,本附录已修正
3. ~~**B6 重派时**: 用 `TMPDIR=~/.cache/tmp` 新会话(避免 /tmp 被清)~~ ✅ **CLOSED (v6.1)** — B6 已 commit `df5d388`
4. ~~**push 7 commits**: 本地 `master` 领先 `origin/master` 7 个,建议 `git push origin master`~~ ✅ **CLOSED (v6.1)** — 已 push 11 commits (origin/master = `bef7cd8`)
5. **8 manual verification tests**:USER-only,需在浏览器触发。**STILL OPEN** — 见 PLAN.md §manual-verification / HANDOFF §C2,需 user 手动跑。
6. **E2E 1 skipped placeholder**:`tests/agents/e2e-blockers.test.ts` 含 1 个 `it.skip()` placeholder,可能后续边缘 case 待补。**STILL OPEN** — 边缘 case 覆盖待定。
7. **jev-check slash-alts false positive**:regex `looksLikeMenuOptions()` 会误匹配 bash 路径分隔(如 "8 manual tests / AGENTS.md / jev-check regex")。**STILL OPEN (低优先)** — 需 word-letter pattern 精修,用户已 ack。
8. **AGENTS.md literal 文件**:把 MEMORY 中分散的 rule(as any 禁止 / 9 项 report / push-first / jev-check 流程等)收成 single source of truth。**STILL OPEN** — user 决定何时做。

---

## 附录 C: M3+ 闭环总结 (v6.1 / v6.4 增量)

### 架构落地完整链

```
M3+ B1 BlackboardArtifact v3 + 5 bus events       ✅ 36694c6
M3+ B2 Communicator 三重身份 + Live Trace          ✅ aeec7f6
M3+ B3 + B4 Orchestrator + Planner + Executor       ✅ 7228268 + 640204f
    + HarnessManager event-sourced
M3+ Communicator fix (systemPrompt wire)            ✅ 06abfcc
M3+ B5 Planner + Executor reinforcement             ✅ 33d60dc
M3+ B7 partial (Timeline BusRow memo)               ✅ e735689
M3+ B6 HarnessManager v0 reinforcement             ✅ df5d388
better-sqlite3 ^13 + Node 22 + @types v9            ✅ b7a8784 + bef7cd8
http.ts cleanup (kind as never removal)             ✅ 034175b
5 E2E blocker closure (B1 wiring + B2 plan_done + B3 callback bridge + B4 onTask + B5) ✅ 6a522c4..e27a3c2
ARCHITECTURE.md (12 层模块图)                       ✅ c32c5c6
```

### Sprint metrics

| Metric | v6.1 (B1-B7) | v6.4 (今日) |
| --- | --- | --- |
| Commits this sprint | 11 (10 M3+ + 2 dep bump - 1 overlap) | +6 (5 blocker + 1 ARCHITECTURE) |
| Test count | 132 → **166** (+34, all passing) | 166 → **176** (+10 E2E, 1 skipped) |
| Type errors | 0 | 0 |
| Build status | ✅ OK | ✅ OK (dist = `dist/src/server/`) |
| Origin/master | `bef7cd8` (in sync) | `e27a3c2` (in sync) |
| Native bindings | better-sqlite3 v13.0.3 on Node 22.23.3 | (unchanged) |

### Worker runIds 本 session(可复用)

- **5 E2E blocker(attempt 1)** — 5min worker `del_mup0g23q_mniy` → 派生 sub-worker `del_mup0jgvo_qray`,**watchdog SIGKILL**(5min no-output)。留下 partial B1 → commit `6a522c4` 作为 checkpoint。
- **5 E2E blocker(attempt 2)** — 11min worker `del_mup0txjw_66zi` → 完成所有 B1-B5 + E2E tests + push。被 watchdog 在写 9-item report 时 kill。**最终 HEAD = `e27a3c2`**。

### 教训(v6.4 新增)

- **Worker self-delegation 陷阱**:大任务 worker 可能觉得太长 → 自作主张派生 sub-worker。本案例 sub-worker 派生后父 worker 等待 → watchdog 抓 no-output → 父子双双 SIGKILL。**下次派工时显式禁止派生 sub-worker**。
- **Worker SIGKILL ≠ 任务失败**:5min idle watchdog 经常在 worker 写最终 report 时杀进程,但实际工作 100% 完成。本案:5 commits 已 push / tests 176/176 / build OK / node sanity OK,只差 9-item report 文本。**修复路径**:worker 死了之后,Main 自己读 .out/.session.jsonl 补全 report(本案做法)。
- **Partial work 提早 commit**:本次 6a522c4 partial B1 commit 起 checkpoint 作用 — 即使后续 worker 再次死,已 commit 不会丢。**下次派大任务时让 worker 第一件事 commit "wip:" checkpoint**。

### 下一会话起手 3 件事

1. **8 manual browser verification tests**(USER-only) — 起 `npm run dev`,浏览器按 HANDOFF §C2 跑 8 个 test case
2. **5 blocker 端到端实测**:B1-B5 已 commit 但只在 vitest fakeLlmCall 下验证过,真实 LLM 路径需浏览器触发 /plan 看 plan_done summary 是否渲染正确
3. **(可选)派 worker 处理附录 B #6**(E2E skipped placeholder)或 **#7**(jev-check regex 精修)— 看 user 优先级

#sansheng #m3-plus #v6-4 #b1-b7-done #5-blockers-closed #176-tests #17-commits-pushed #node-22 #better-sqlite3-v13 #architecture-12-layer