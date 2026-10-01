# Sansheng 代码审查报告 · 2026-10-01

**审查基线**:HEAD = `4910240`(master,clean)· typecheck 0 error · 176/176 tests · build OK
**方法**:主会话独立深读核心接线(ws/orchestrator/executor/communicator/kernel/bus)+ 3 个并行只读 review(agents 协调层 / 传输存储基础设施 / 前端 shared CLI);所有关键断言均经主会话抽查源码核实;A1/A2(主会话 repro)、A3/A5/A6/B3/B6/C4 及 A8(pty 探针)均有一次性脚本实证(输出摘录见各条,脚本已删)。
**结论一句话**:组件单体质量良好(类型纪律、参数化 SQL、错误处理规范),但**组合根(boot/ws/kernel 接线层)存在系统性断裂——设计文档描述的系统与实际运行的系统不是同一个东西**。176 测试全绿是"组件级测试 + 模拟式 e2e"的假象:所有关键集成路径(DAG 解锁、真实 sink 闭包、跨 run 生命周期、重连、重启对账)零覆盖。

---

## A. P0 — 主链路实际不可用 / 安全穿透(均有实证或确凿代码链)

### A1. plan 完成路径 TDZ 崩溃/永久挂起(实证)
- `src/server/ws.ts:289-299` 的 sink 在 `completed` 事件里访问 `finalBb`,而 `finalBb` 是 `await orchestrator.run(...)` 的返回值;`orchestrator.ts:664-684` 的 `completeRun` 在 **resolve 之前**同步调 sink → sink 访问尚在 TDZ 的 `const finalBb` → `ReferenceError: Cannot access 'finalBb' before initialization`。
- 实证(一次性 repro,真实 Orchestrator + in-memory DB):
  - 完成经 bus 事件路径(`onArtifactStatusChanged` 被 `void` 调用,bus 的 try/catch 只捕同步 throw)→ **unhandled rejection**;`src/server/index.ts` 无任何 rejection handler → 生产进程直接崩溃(Node ≥15 默认 throw)。
  - `completeRun` 在 sink 之前已把 `runResolve/runReject` 置 null → throw 后 `resolve(shape)` 不可达,且 30min runTimer 因 `runReject=null` 变成 no-op → **run() 永久挂起**,ws.ts `activeOrchestrator` 永不清除,后续所有 /plan 返回 `plan_busy`,只能重启。
- 修复方向:`completed` 事件携带 shape,或 ws.ts 在 `await run(...)` 返回后再 build summary;`completeRun` 先 resolve 再发 sink(或 sink 调用包 try/catch + resolve 放 finally)。

### A2. 僵尸 Orchestrator:shutdown() 生产零调用(实证)
- `ws.ts:315-317` runPlan finally 只 `activeOrchestrator = null`,从不 `orchestrator.shutdown()`;`abort()`(orchestrator.ts:269-291)也不退订;`grep -rn "shutdown()" src/` 仅命中定义处。artifactBus 是 globalThis 单例,跨连接存活。
- 实证:第一个 orchestrator 挂起后,第二个 run 发布 intent → **僵尸实例对新 intent 再次 spawnPlanner + spawnExecutor**(repro 输出 `orch1 counters: planner=2 executor=2`)→ 重复 LLM 调用、重复 todo 落库、同一 todo 被双方执行(activeExecutors 是 per-instance 守卫)。
- 叠加:`onArtifactStatusChanged` case1(orchestrator.ts:303-311)对**任何** intent 的 resolved/failed 都 completeRun 当前 run(无 ownership 校验,run() 不记录自己的 intentId)→ 僵尸的旧 intent 收尾会用旧 blackboard resolve 新 run。
- 修复方向:runPlan finally 调 shutdown();run() 记录 myIntentId 并在 completeRun/事件处理前校验归属;或 Orchestrator 提升为 boot 级单例。

### A3. DAG 依赖解锁彻底失效:`conversationId:"*"` 通配符查询恒空(实证)
- `orchestrator.ts:491-495`(`findTodosDependingOn`)传 `conversationId:"*"`,而 `storage/repo/blackboards.ts:309-312` 把它当**字面量** SQL 参数(无通配语义)→ 恒返回 0 条(实测 `wildcard '*' returns: 0`)。
- 后果:任何带 `dependsOn` 的计划,上游 resolve 后 `tryUnblockDependents` 找不到下游 → 永不 spawn → `maybeResolveIntent` 因 pending 非空永不收尾 → run() 挂到 30min 超时 plan_failed。**planner.md 的示例计划(todo-2 依赖 todo-1)就是必挂形态**。
- 测试全绿原因:orchestrator/e2e 测试的所有 todo 都是 `dependsOn: []`(orchestrator.test.ts:77,121,161,194,285;e2e-blockers.test.ts:134,190-191,254…)。
- 同病:`orchestrator.ts:351` 的 `intent.conversationId ?? "*"`。
- 修复方向:传入真实 conversationId(事件源 artifact 自带);或给 repo 加显式跨会话扫描 API,废除 "*" 魔法值。

### A4. 阻塞回调回路功能性断裂:decision 内容到不了 resumed Executor + depth limit 死代码
- `orchestrator.ts:426-432`:decision artifact 取出来只喂了 sink,`resumeExecutor(todo)` 不携带;`executor.ts:212-215` 重跑 prompt 的 siblings 上下文只有 `[kind/status] title (id=…)` 一行,**不含 body**——而用户的回答全文恰在 decision.body(title 是 `User decision for q-exec-x`,agentKernel.ts:303)。
- depth limit:按 executorSessionId 计(orchestrator.ts:376-378),但每次 resume 都 new Executor 换新 sessionId(executor.ts:101)→ 计数恒从 1 起;单 session 的 execute() 只发一次 callback → `failTodoDueToDepth` **生产不可达**(死代码)。orchestrator.test.ts:225 的 depth 测试用 todoId 冒充 sessionId 发 resume(实际 no-op),断言又是三选一宽松集合,没测到真路径。
- 后果:用户认真回答 → executor 重跑看不到答案 → 大概率再产同一 hypothesis 再问 → **无界循环**,每轮烧一次 LLM + 一次用户交互(executor.md:22 承诺的 depth 防线不生效)。
- 修复方向:resumeExecutor 把 decision.body 注入重跑 userPrompt(或 Executor.execute 接受 decision 参数);depth 改按 todoId 跨 session 累计。

### A5. fs sandbox 写入逃逸:符号链接父目录绕过 allowlist(实证)
- `sandbox.ts:324-390` `resolveForWrite` 只做**词法** `matchAllow(parent)`,不做 realpath;最终组件的 symlink 检查用 `fsStat`(follows symlink)→ `isSymbolicLink()` 恒 false,**死代码**(实证 `resolveForWrite passed final symlink`)。`fs.ts:129` 的 lstat 补救只覆盖最终组件是 symlink 的情形,覆盖不了**父目录**是 symlink。
- 实证:allowlist 内 `ln -s <外部目录>` 后,`fs.writeFile` 在沙箱外创建/覆盖任意文件成功(`PWNED-A`/`PWNED-B`),同路径读被 resolve() 的 realpath 校验拦截(读写不对称)。
- 现实触发面:默认 policy 含 `/tmp/sansheng-canvas` 与 `newCanvasDir` 的 `/tmp/sansheng-<id>` —— /tmp 全局可写,任何本地进程可预先埋 symlink(经典 /tmp race);agent 解压含 symlink 的归档到 workspace 同理。
- 修复方向:resolveForWrite 对 parent realpath 后走 matchAllowReal(A1 修复日已为该基建铺路,f379c50);最终组件检查改 lstat;canvas 目录迁到 ~/.sansheng 下或 mkdtemp 创建。

### A6. netSandbox 重定向绕过(SSRF,实证)
- `tools/http.ts:153` `fetch(url, mergedInit)` 未设 `redirect`,undici 默认 follow(≤20 跳);`checkNetRequest`(netSandbox.ts:171-244)只校验**首个** URL,每跳 Location 的 host/port/private-IP 全不复检(全仓 grep "redirect" 零命中)。
- 实证:allowlist=["localhost"] 时,首跳合法 8080 → 302 → `127.0.0.1:<内部端口>` 内容原样返回(`BYPASS: fetch followed 302 … never re-checked`)。生产形态可打到 `127.0.0.1:2718/api/reset`、路由器、云 metadata。
- 修复方向:`redirect:"manual"` 循环处理,每跳重过 checkNetRequest;或至少 `redirect:"error"`。

### A7. WS 事件流生命周期断裂:刷新页面后流式输出/bus 事件永久进死连接
三个独立缺陷叠加,同一后果("server 常驻 + 浏览器刷新"这个最常见操作触发):
1. **kernel sink 一次性捕获**:`agentKernel.ts:425-426` `start()` 时 `session.subscribe(makeHandler(sink))` 绑定首个连接的 sink;`isReady()` 后 `start` 提前 return **不重绑**(agentKernel.ts:174,426);`ensureCommunicator` 早退同样不更新 sink(:238-239),MessageBus 订阅闭包永久持有第一次的 sink(:264-270,与 :153 注释"resume 时重建"矛盾)。`ws.ts:372` 同 convId 的 load_conversation 不触发 resume(唯一重绑路径)。
2. **前端 Timeline 路由无 socket**:socket 生命周期绑死在 chat 路由的 ChatSurface(App.tsx:82-113 三元切换;ChatSurface.tsx:22-33 卸载即 close);而 pending_question 的回答/取消 UI 只在 Timeline 路由(Timeline.tsx:172-185)→ `chat.ts:133-142` `socket?.send` 对 null 静默 no-op,**按钮 100% 失效**。
3. **`POST /api/kernel/reset` 传 log stub sink**(http.ts:182)→ `kernel.reset → start(stub)` → 之后 session 事件全进日志桩,UI 全盲。
- 附带:Pi `session.subscribe` 是**累加**的(agent-session.js:801 `_eventListeners.push`),将来重绑时必须先保存并调用 unsubscribe,否则事件双份→重复落库。
- 修复方向:kernel 持 mutable sink + `setSink()`,连接建立时无条件重绑(先退订旧的);前端 ChatSocket 提升为 App 级单例;Timeline 复用同一连接。

### A8. CLI 交互式 `sansheng reset` 挂死(pty 实证)
- `commands.ts:196-218`:`setRawMode(true)+resume()` 后,resolve 路径只 removeListener,从不 `pause()/setRawMode(false)` → flowing TTY stdin 挂住 event loop,命令打印完结果后进程永不退出;raw mode 下 Ctrl+C/Ctrl+D 变成数据字节,只能另开终端 kill。已用 pty 探针复现("STILL RUNNING")。
- 修复方向:两条 resolve 路径补 `process.stdin.pause(); process.stdin.setRawMode?.(false);`。

---

## B. P1 — 高危缺陷 / 设计功能未接线

### B1. 设计核心功能在生产不可达("文档系统 vs 运行系统")
| 设计(PLAN.md) | 实现现状 | 证据 |
|---|---|---|
| D7:Communicator 每次响应产 `{userReply, artifacts[]}` 写 global bb | `respond()/parseStructuredOutput()/startObserver()` **零生产调用**(仅测试) | communicator.ts:384-651;grep 全 src 无调用方 |
| decide 用 LLM 判断 chat/task/feedback | 恒走**正则启发式**(`重构|修复|…|查一下|分析|总结`),kernel 未注入 decideFn | communicator.ts:77-92;agentKernel.ts ensureCommunicator 无 decideFn |
| shared/prompts/*.md 4 份协议 prompt | **生产从不加载**,LLM 实际收到 5 行 stub(且 stub 未写明顶层必须有 `"outcome"`) | orchestrator.ts:705-719 零调用;planner.ts:137/executor.ts:99 fallback stub;executor.ts:484-492 |
| D13:Executor 发现可复用模式 → harness_proposal → HarnessManager | ①`callbackReason` 代码读**顶层**,prompt 要求写 **metadata**(executor.md:52,68)→ 恒降级 judgment,且 parseOutcome 用顶层推导值覆盖 metadata(executor.ts:270);②HarnessManager **boot 从不 start**(仅测试实例化);③`harness_proposal_created` 事件全仓无 producer | executor.ts:258-273;index.ts 全文无 HarnessManager |
| M5:Critic/Memory/Reflection worker | **无实现**(仅 RoleId 类型 + ensureHarness 生成的 prompt 文件,harness/system_prompts/{critic,memory,reflection}.md 无人消费);PLAN.md:770 里程碑却标 "M5 ✓" | ls src/server/agents/ 无对应文件 |

### B2. chat/task 双重处理 + chat 双回复
- `kernel.prompt`(agentKernel.ts:701-768):routeUserMessage 之后**无条件**继续 `session.prompt(text)`(:766-768)。
  - chat 路径:decide 先 sink 一条 `已收到:…`(communicator.ts:91 启发式 reply),Pi session 再回一条 → **双回复**。
  - task 路径:`onTask → runPlan`(完整 Planner+Executor LLM 花费)与 Pi 直答**并行双执行**;:747-748 注释("task 也走 Pi 直答,Orchestrator 由 /plan 显式触发")与 setOnTask 已接线的事实矛盾。"帮我总结一下"这类聊天命中"总结"即静默开 plan(叠加 A2 僵尸累积)。
- 修复方向:task 分支二选一(onTask 后 return,或撤 setOnTask);chat 分支不再 sink decide 的占位 reply(或 session 存在时跳过);decide 升级为真 LLM 判断。

### B3. sqlite-vec 生产从未加载:向量检索全链路死代码,且 migration 逻辑使漏洞不可自愈(实证)
- `storage/db.ts:17-29` 构造器无 `load(db)`;全仓 `sqlite-vec` import 只在 tests/(6 处)。生产启动 `applied migrations 1,3,4,5`——002 每次被静默 skip(migrations.ts:76-80 catch-and-skip)。
- **不可自愈**:`currentVersion` 用 `MAX(version)`(migrations.ts:32-34)→ 002 被跳过后 MAX=5 → 日后即使补上 extension load,002 也永不重跑(实证:再跑 `applied: []`,`fragments_vec created retroactively: false`)。
- 连带:`agentKernel.ts:1064-1084` 仍为每个 fragment 向 `provider.baseUrl+/v1/embeddings` 发**真实 HTTP**(硬编码 text-embedding-3-small/1536 维),拿回结果后因 `isVecAvailable=false` 在 upsertFragmentEmbedding(fragments.ts:70)直接丢弃——纯浪费网络/token/5s 超时,且 **PI_OFFLINE=1 完全不被 embeddings.ts 尊重**。
- 修复方向:db.ts 构造器 try/catch load;migration 改集合判定(SELECT 全部 version 逐条比对);embedText 尊重 PI_OFFLINE;模型/维度进 settings。

### B4. HTTP API 无 Origin/Host 校验:任意网页可 CSRF 删库
- `http.ts` 全文无 cors/origin/host 校验(grep 0 命中)。`POST /api/reset`(:351-385)`c.req.json()` 不校验 Content-Type → 恶意页面 `fetch('http://127.0.0.1:2718/api/reset',{method:'POST',body:'{"confirm":"reset"}'})`(text/plain 简单请求,**无预检**)即可删除 db/keyring/settings/pi 目录。`/api/tools/invoke`(:315-348)同理可跨站调用 fs.writeFile/http.fetch(借 A6 出网)。无 Host 校验 → DNS rebinding 后可读响应。
- 修复方向:校验 `Origin`/`Sec-Fetch-Site`(仅放行 same-origin/none)+ Host ∈ {127.0.0.1:port, localhost:port};或启动时生成随机 token 注入前端并强制。

### B5. /api/reset 后 server 变僵尸 + 密钥丢失链
- `http.ts:367-375`:`storage.close()` + rmSync 后**无任何重开逻辑**(全仓 `new Storage(` 仅 index.ts:42)→ 除 health 外全部 API 500(use-after-close 被 try/catch 兜住),kernel 落库全失败,必须手动重启。
- 更隐蔽:SettingsStore.cache 与 Keyring 内存 masterKey 仍指向已删文件;若 reset 后发生任何 save() → 用旧 key 重写 settings.json;重启后 Keyring 生成**新随机 key**(keyring.ts:34)→ 已存 apiKey 全部解密失败被静默清空(store.ts:99-101)。
- 修复方向:reset 改"关闭并重建注入点",或删文件后 process.exit 交给 daemon 管理器重启。

### B6. resolveModel 改写 pi-ai 共享 catalog(baseUrl 粘滞)+ 明文 key 进 process.env(实证)
- pi-ai `getBuiltinModel` 返回**共享对象非克隆**(all.js:49);`registry.ts:114-117` 直接 `m.baseUrl = baseUrl` → 用户删除自定义 baseUrl 后进程内依然粘滞(实证:第二次 resolve 无 baseUrl 仍返回旧值,same object: true),`if (hasBaseUrl && baseUrl)` 永不清除。
- `registry.ts:102-107` `process.env[envKey] = apiKey`:server spawn 的一切子进程(Pi session 工具执行)继承全部 provider 明文 key;envKey 映射有多 provider 共享同名 env(registry.ts:76-90,如 moonshot 对)→ 后 resolve 覆盖前者,切 provider 后旧 key 永不删除。
- 修复方向:`{...getBuiltinModel(...)}` 浅拷贝后再改;支持显式清除 baseUrl;env 注入改为 createPiSession 前一次性同步 active provider。

### B7. Keyring/db 安全形态
- `.keyring` = `{version, masterKey:base64}` **明文**存于与 settings.json 同目录(0600)→ "加密"仅为混淆,对能读目录的攻击者零防护。`rotate()`(:68-74)不重加密既有 settings 且 unlink→write 非原子——**一旦接线即数据销毁器**(当前无调用方,上膛未击发)。
- `sansheng.db/-wal/-shm` 实测 **0644**(全部会话/记忆对本机其他用户可读;db.ts:17 未收紧 mode)。
- 修复方向:文档明确威胁模型或接 macOS Keychain;rotate 同步重加密 + tmp/rename;Storage 打开后 chmod 0600。

### B8. 重启/失败无对账:非终态 todo 永久悬挂
- 协调层状态(waiting/depth/todoByExecutorSession/pendingExecutorCallbacks)**纯内存**,重启全丢;SQLite 里 waiting_for_decision/in_progress 的 todo 无任何 boot 对账代码(grep 无 recovery/reconcile)。"事件溯源"仅覆盖进程内生命周期;agent_states(v003)只写 `{historyCount,resumedAt}`(agentKernel.ts:526-533)。
- `onExecutorResume`(orchestrator.ts:418-427)先 clearWaiting(杀 watchdog)再查 todo/decision,查不到就**静默 return** → todo 永久卡死;触发链 A:handleUserAnswer 的 decision upsert 失败仅 warn 但**仍** publish resume(agentKernel.ts:310-320)。
- 手动 PATCH /api/artifacts/:id/status 不发 bus 事件(blackboardRoutes.ts:188-194)→ 人工解卡也不触发连锁。
- 修复方向:resume 查不到时 failTodo 或重建 watchdog;upsert 失败不 publish;boot 时对非终态 todo 对账(重路由或标 failed);repo 写路径统一发 bus 事件。

### B9. cancel_question 对 executor 回调问题完全无效;合成 question 不进 MessageBus
- `handleExecutorCallback`(agentKernel.ts:366-399)手工构造 `q-exec-*` 消息直传 handleWorkerAsk,**未走 bus.ask()** → MessageBus.pending/stream/bus.jsonl 都没有它;`cancelPendingQuestion → bus.reply(id)` → `no pending question` → false(messageBus.ts:106-111),waiting/watchdog/pendingExecutorCallbacks 均不清理;ws.ts:483-486 对返回值不处理。用户点"取消"表面无报错,实际 todo 挂满 1 小时到 failTimer。timeline/bus_replay 也看不到 executor 提问(**审计缺口**,违背 PLAN.md:586 bus 审计设计)。
- 修复方向:cancel 路径同步通知 orchestrator clearWaiting+failTodo;合成 question append 进 MessageBus stream。

### B10. 前端连接/状态一组缺陷(与 A7 同源)
1. **bus_replay 从不发送**:协议三端齐备(shared/types/ws.ts:90;ws.ts:489-505;replayBus@agentKernel.ts:408)唯独客户端不调 → 重连/重启/切路由窗口事件永久丢失。HANDOFF 记载的 B7 该半部分改动**确认丢失从未 commit**(SCRATCHPAD.md:21 亦记录过)。busStream 无 id 去重(chat.ts:372-379),接 replay 前需补。
2. **ready 无条件覆盖 conversationId**(chat.ts:249-257):server 重启(新随机 convId,agentKernel.ts:132)→ 重连 → UI 仍显示旧 turns 但后续消息进**新空会话**——用户看着满屏历史,LLM 一无所知。
3. **pendingQuestions 只增不减**(chat.ts:383-395 仅 append,无任何移除路径)→ 已答/已取消的问题卡片永久残留、可重复提交(再点 → `no_pending_question` 报错)。
4. **BusRow memo 冻结时间**(Timeline.tsx:308):比较函数 `prev.msg === next.msg` 丢弃 `now` prop(每 5s 更新,用于 fmtRel)→ memo 恒 true,"刚刚"永远是"刚刚";:303-306 注释是对 memo 语义的误解。(此即已 commit 的 B7 `e735689`,自带 bug。)
5. **ServerEvent 前端 union 缺 plan_done/plan_failed**(agentKernel.ts:76-88 实际在发,shared/types/ws.ts 无)→ applyEvent 无 case 无 default **静默丢弃**:即使修好 A1,/plan 的完成/失败反馈用户也看不到。artifact_* 5 类事件同样到达即丢(chat.ts switch 无 case)→ M3+ artifact 生命周期 UI 不可见。`blackboard_update` 是死类型(全仓无 emit)。
6. **daemon start 假成功 + pid 无身份校验**(commands.ts:85-105):spawn 后不监听 error/exit、无健康探测即报成功;EADDRINUSE/dist 缺失时子进程秒死但 CLI 已写 pid 并报 ok;前台/daemon 退出钩子不删 pid(server/index.ts:73-96)→ stale pid 被复用时 `sansheng stop` 会 SIGTERM→SIGKILL **杀无关进程**(commands.ts:133-144)。

---

## C. P2 — 值得改进(简表)

| # | 问题 | 位置 |
|---|---|---|
| C1 | bus 订阅 handler `void asyncFn()` 无 `.catch` → handler 内任何异步抛错 = unhandled rejection 崩进程(A1 的放大器);routeCallback 失败 err 未用、零日志 | orchestrator.ts:176-189,411-415 |
| C2 | abort 语义不完整:Executor.abort 只设 flag(llmCall 在飞照跑完并 persist);Orchestrator.abort 不退订、无 aborted 守卫,后续事件仍可唤起新 executor | executor.ts:111,183-185;orchestrator.ts:268-291;ws.ts:458-464 |
| C3 | Planner dropCycles 不级联:unknown-dep 过滤先于 dropCycles,drop 环节点后不重跑过滤 → 存活 todo 依赖已 drop 的 id → 永不 spawn(叠加 A3);warnings 算完即丢,静默发生 | planner.ts:296-311 |
| C4 | upsertFragmentEmbedding 先 DELETE 后 INSERT 不在事务内(实证:维度不匹配失败 → 旧向量已删);embeddings cache Map 无界增长(每条 1536 doubles,只判 TTL 不删) | fragments.ts:72-75;embeddings.ts:13,52 |
| C5 | settings.json 损坏 → **静默**清空全部配置(catch 无日志)且随后 save() 把默认值写回(旧配置永久丢失);写盘非原子(截断 JSON 正好触发前述清空,两缺陷互相成就) | settings/store.ts:76-80,208 |
| C6 | 无 WS 心跳:半开连接不触发 close → wss.clients + busUnsubs 泄漏,send 向死 socket 持续缓冲 | ws.ts 全文 |
| C7 | setOnTask 单槽被每连接覆盖;最后一个 tab 关闭后 task 仍路由到死连接(headless run,进度全丢);ws.on("close") 不 abort activeOrchestrator(孤儿 plan 继续烧 token)、不解绑 onTask | ws.ts:323-325;agentKernel.ts:336-342 |
| C8 | resume/prompt 两条 async 链无互斥:快速切会话+发消息可并发进 resume → 孤儿 Pi session(this.session 被覆盖,旧未 dispose);createPiSession 8s 超时后 createPromise 仍在后台完成产孤儿 session,成功路径 setTimeout 不 clear | ws.ts:367-427;agentKernel.ts:599-610 |
| C9 | isVecAvailable 模块级缓存跨 DB 实例;migrations 目录缺失时静默空表启动;004_blackboards.sql 是唯一无 IF NOT EXISTS 的 CREATE TABLE;`?limit=abc` → NaN → better-sqlite3 datatype mismatch → 500(应 400;对照 :239-240 有防御,不一致) | fragments.ts:32;migrations.ts:15-17,38;http.ts:221 |
| C10 | UI 死代码/空头承诺:「Esc 中断」无 keydown 接线(interrupt() 零调用方);TopBar currentUsage 恒 0("本轮 idle"永现);ToolCallCard 空串结果 ✓+⏳ 同屏(web 唯一 `as any` 在此文件);Agents 页 setAgents 零调用 + server /api/agents 恒 `{agents:[]}`;AgentPanel/Agents 轮询的 legacy `/api/blackboard/:id` 恒 null(upsertBlackboard 全仓无调用方) | ChatComposer.tsx:90-95;TopBar.tsx:111-119;ToolCallCard.tsx:46-65,120;Agents.tsx:12-44;AgentPanel.tsx:87-105;http.ts:189-214 |
| C11 | daemon 强制 `PI_OFFLINE:"1"` 覆盖用户显式 `PI_OFFLINE=0`(前台路径尊重用户值,行为不一致) | commands.ts:90;server/index.ts:31 |
| C12 | 文档/注释漂移:AGENTS.md "server 不 import @shared/*" 实为 "禁 **value** import"(type import 遍地,tsconfig.server include 含 shared/**/*,dist/shared 确实 emit);ws.ts:22-25 镜像注释与同文件 :45-46 自相矛盾,且 ServerEvent 真身镜像在 **agentKernel.ts:56-125** 而非 ws.ts;index.ts:4 注释旧路径 `dist/server/index.js`;PLAN.md:770 "M5 ✓" 失实;ws.ts:227 注释失实 | 各引用处 |

---

## D. 根因分析(为什么 176 全绿掩盖了以上一切)

1. **测试策略与生产接线错位**:组件级单测 + fake 注入覆盖充分,但**组合根(boot/ws/kernel 的接线)零覆盖**。e2e-blockers.test.ts 是"模拟式"测试——复刻 buildPlanSummary 逻辑(:100 注释自认"与 ws.ts 实现一致,避免 export")而非调用真实 ws.ts 闭包,恰好漏掉 A1 的 TDZ;所有 dependsOn 都是 [] 恰好漏掉 A3;shutdown() 在测试里调了、生产没人调,恰好漏掉 A2。
2. **真实 LLM E2E 从未跑过**(HANDOFF v6.4 自认):B1 类"未接线"问题(prompts stub、respond 死代码、decide 正则、HarnessManager 不启动)只在真实路径暴露。
3. **纯内存协调状态 + 无对账**:进程即真相,重启即失忆(B8)。
4. **文档驱动开发但无文档-代码一致性校验**:PLAN/prompt/注释与实现漂移无人察觉(C12、B1 表)。

## E. 修复优先级建议

| 批次 | 内容 | 理由 |
|---|---|---|
| 1 | A1+A2+A3+A4 + B10-5(plan_done 前端接线) | /plan 主链路首次真正可用;之后"真实 LLM E2E"(HANDOFF 待办 #2)才有意义 |
| 2 | A5+A6+B4(安全三件套) | 沙箱写逃逸 + SSRF + CSRF 删库,均为实际可利用面 |
| 3 | A7+A8+B10(连接生命周期) | 刷新即哑巴是当前最影响日常使用的 UX 断裂 |
| 4 | B3+B5+B6+B7+B8+C 组(生产卫生) | 数据完整性与资源泄漏,长驻进程必修 |
| 5 | B1(接线 D7/prompts/HarnessManager)+ M5 角色 | 让实现追上设计;先决:批次 1-2 完成 |

**修复批次 1 的验收标准建议**:补一组**走真实 ws.ts attachWebSocket + 真实 Orchestrator**的集成测试(fake llmCall 可以保留,但闭包/生命周期必须是生产代码路径),覆盖:①plan 完成 → 客户端收到 plan_done;②带 dependsOn 的两级计划全部 resolve;③连续两次 run 无重复 planner 调用(listenerCount 断言);④executor callback → answer → resume 后 executor prompt 含 decision.body。
