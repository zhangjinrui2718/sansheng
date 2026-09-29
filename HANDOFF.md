# Sansheng 项目交接包

**生成时间**:2026-09-29 21:13 UTC · v5.1(系统 PROBE OK 后)
**适用**:下一会话(主对话 / worker)开盒即读
**配套阅读**:`/root/projects/sansheng/PLAN.md`(v5 集成版),`/root/.pi/agent/memory/MEMORY.md`

---

## TL;DR

Sansheng = 单用户本地 Node 服务。M0-M4 全完成(81 tests pass,8 commits remote),**M3+ B1 + B2 也已 commit + push**(132 tests pass,10 commits remote)。M3+ B3+B4 dispatched 但 **3 个 worker 都静默死亡**(11:23 UTC,可能是 OOM / 进程 watchdog)——**未 commit 任何代码**。

**PROBE 确认系统已恢复 OK** — typecheck 0 errors / 132 tests pass / build OK。基础设施问题已无。

**当前坐标**:M3+ B3 待派,**HEAD = `aeec7f6`**,git clean。

---

## 1. 当前代码状态

| 指标 | 值 |
|---|---|
| git head | `aeec7f6 feat(communicator): B2 3 identities + bus events + Live Trace` |
| commits remote | **10**(M0→M4 + M3+ B1 + M3+ B2) |
| tests | **132 pass**(14 files) |
| typecheck | 0 errors |
| build | OK(60 modules) |
| git status | clean |
| bundle sanity | ✅ `import dist/src/server/index.js` → startServer is function |
| server smoke | ⚠️ **未通过**(C2 待派) |

**最新 10 commits**:
```
aeec7f6 feat(communicator): B2 3 identities + bus events + Live Trace
36694c6 feat(blackboard): B1 data model + storage migration + HTTP endpoints
2f4cd48 M4 integration: tool registry wires fs+http, /api/tools/{list,invoke} endpoints, 11 tests
4b2a48f fix(ui): history rail no jump on click + agent panel live blackboard
570467b fix(http): per-handler try/catch on blackboard/fragments endpoints returning JSON 500
40e0589 fix(http): add global onError handler returning JSON 500
1d492fb feat(tools): M4 http (fetchUrl, postJson, net sandbox, 10 tests)
b5d1404 feat(tools): M4 fs (readFile, writeFile, listDir, 12 tests)
0f01a48 feat(integration): createToolRegistry + /api/tools/{list,invoke}
43e7bf0 docs(handoff): Memory Fragments bug fix + M4 http completion
```

---

## 2. M3+ B1 + B2 已完成 + commit + push

### B1 (`36694c6 feat(blackboard): B1 data model + storage migration + HTTP endpoints`)

**新增文件**:
- `shared/types/blackboard.ts` — BlackboardArtifact v3, 10 kinds
- `shared/types/bus.ts` — 5 新 event payload types
- `migrations/005_blackboard_artifacts.sql` — additive migration
- `src/server/storage/repo/blackboards.ts` — artifact CRUD + migration helper
- `src/server/http/blackboardRoutes.ts` — 4 新 endpoints
- 4 个新测试文件

**4 新 endpoints**:
- `GET /api/blackboard/global`
- `GET /api/artifacts/:id`
- `GET /api/artifacts?scope=&kind=&status=&limit=`
- `GET /api/executors/:id/state`

**DB migration**:additive,`artifacts_json` 列(nullable, default `'[]'`),旧 rows 读时升级

### B2 (`aeec7f6 feat(communicator): B2 3 identities + bus events + Live Trace`)

**核心改动**(906 insertions / 12 deletions,9 files):
- `src/server/agents/communicator.ts`(377 lines added) — 3 重身份(reactive input + plan producer + observer)
- `src/server/bus/events.ts`(NEW) — 5 新 event types
- `src/server/bus/index.ts`(NEW,141 lines) — publish/subscribe API
- `src/server/kernel/agentKernel.ts`(32 lines) — switch case 扩展 `user_reply` + `artifact_created`
- `src/server/ws.ts`(50 lines) — 5 新 WS events
- `shared/types/ws.ts`(27 lines) — WS types
- `shared/prompts/communicator.md`(NEW) — D7 structured output + Intent 验证 + Harness risk 分类
- `src/server/storage/db.ts` + `migrations.ts`(additive column + dynamic path resolution)

**5 新 bus events**:
```
artifact_created
artifact_status_changed
executor_callback
executor_resume
harness_proposal_created
```

**Live Trace**:`web/src/components/agents/` + `web/src/stores/blackboard.ts` — 10 kind 颜色 + waiting_for_decision 脉动

### 冲突解决记录(C1 worker 留下的)

- **`@shared/*` runtime path alias 不解析** → 改成相对路径(4 个 B1+B2 文件)
- **`agentKernel.ts:562` exhaustive switch** — 加 `user_reply` + `artifact_created` case
- **`migrations.ts` `MIGRATIONS_DIR`** — 双候选路径(src/ + dist/)
- **`ensureBlackboardArtifactsColumn`** — missing-table 防御(no-op)

---

## 3. M3+ 架构(15 decisions 锁定)摘要

来源:`PLAN.md` "M3+ Rebalance — Core Architecture" 完整版

- **D1** Blackboard 双 scope:global + conversation
- **D2** Communicator = 3 重身份:reactive input + plan producer + observer
- **D3** Execution trigger:`artifact.kind='intent' status='open'`
- **D4** 复用 M3c infra(Communicator singleton + MessageBus + Live Trace)
- **D5** 其它角色订阅全局 bb
- **D6** 保留 M3a chat UX
- **D7** Structured output(LLM emits artifact array JSON);fallback = single `note`
- **D8** Artifact execution tracking:`executors[]`, `dependsOn[]`, `parentIntent?`
- **D9** 阻塞回调:Executor pause → Communicator decides → emit `decision` → resume
- **D10** Observer 仅在 resolved/failed 汇报
- **D11** 每个 callback 产生 `decision` artifact
- **D12** 单用户本地,无 auth
- **D13** Executor 可发 `harness_proposal` callback
- **D14** haproposals = M6 reactive input
- **D15** Harness Manager v0 = 独立 agent 订阅,read-only

### 4 Flows

- **A**:User msg → Communicator → artifacts → global bb → if intent open → Orchestrator spawns Planner
- **B**:Communicator observer 订阅 bb events(resolved/failed)→ emit note + user message
- **C**:Executor judgment callback → Communicator decides → Executor resume
- **D**:Executor harness_proposal callback → Communicator 写 haproposal → Harness Manager preview(v0)

---

## 4. 下一步 — M3+ B3 + B4 + C2 待派(parallel)

### B3 — Orchestrator + Planner + Executor(60min)

详见 `PLAN.md` §"M3+ Rebalance — Core Architecture" + §"实施顺序"

**Scope**:
- `src/server/agents/orchestrator.ts` (REWRITE):event-sourced,订阅全局 bb
  - `artifact_created kind='intent' status='open'` → spawn Planner
  - Planner 返回 todos → spawn Executors(DAG-aware via `dependsOn[]`)
  - `executor_callback` → 路由给 Communicator,标记 executor.status='waiting_for_decision'
  - decision artifact → route 到 waiting executor + resume
  - watchdog:5min 升级 user,1hr 标 failed
  - max callback depth:3
- `src/server/agents/planner.ts` (NEW):接 `intent` artifact → LLM → 产 `todo` artifacts(DAG)
- `src/server/agents/executor.ts` (NEW):接 `todo` artifact → LLM → 产 `evidence` artifact + 可触发 callback
  - judgment callback:reason='judgment' + 阻塞
  - harness_proposal callback:reason='harness_proposal' + 阻塞
- `src/server/agents/interrupts.ts` (UPDATE):CancelToken 广播
- `shared/prompts/planner.md` + `executor.md` (NEW)
- 测试:`orchestrator.test.ts` + `planner.test.ts` + `executor.test.ts`

**NOT DO**:不改 BlackboardArtifact(B1)、不改 Communicator(B2)、不改 Harness Manager(B4)、不改 web/

### B4 — Harness Manager v0 + Harness UI(60min)— parallel with B3

**Scope**:
- `src/server/agents/harnessManager.ts` (NEW):订阅 `harness_proposal`,产 `implementation_preview`,**v0 read-only**
- `shared/prompts/harness_manager.md` (NEW)
- `src/server/index.ts` wire Harness Manager + bus subscriptions
- `tests/server/agents/harnessManager.test.ts` (NEW):**测试必须 verify 无 FS mutation**
- `web/src/components/harness/ProposalCard.tsx` (NEW)
- `web/src/routes/Harness.tsx` (UPDATE / NEW):v0 UI,注明 read-only
- `tests/web/harness/ProposalCard.test.tsx` (NEW)

**NOT DO**:不改 Orchestrator / Planner / Executor(B3)、不改 Harness Manager apply 逻辑(M6 真应用)、不改数据模型

**⚠️ 注意 B3+B4 并行** — B4 不要碰 B3 改的文件,typecheck 冲突来自 B3 时,跳过那些文件

### C2 — Server Smoke Debug(15min)— after B3

**背景**:B1+B2 commit 后 worker 试图跑 server smoke 失败(server 没起来,curl 全 "Failed to connect")。

**Scope**:
1. **诊断**:reproduce 失败,foreground 跑 `node dist/src/cli/index.js start`,捕获完整 stderr
2. **修**:让 server 真的 bind 2718
3. **curl smoke**:8 个 manual tests(参考 PLAN.md §6):
   ```
   curl /api/health
   curl /api/blackboard/global
   curl /api/artifacts?limit=5
   curl /api/executors/test-executor-1/state
   curl POST /api/artifacts (note)
   curl /api/tools/list
   curl POST /api/chat
   curl POST /api/agents/interrupt
   ```

### 派工模板

```ts
acp_delegate({
  agent: "worker",
  task: <prompt 含 scope + 验证 + 9 项 report>,
  cwd: "/root/projects/sansheng",
  model: "balanced",
  thinkingLevel: "medium",
  async: true,
  timeoutMinutes: 60,  // B3/B4
  // 或 15, // C2
})
```

### ⚠️ 派工踩坑提醒(重要!)

1. **writer conflict**:同一时刻只能有 1 个 worker 写 workspace。B3+B4 必须同时派(B3 先 admit 后 B4 才进),不要先派一个等完成再派另一个
2. **C2 等 B3 完成** 后再派(不要尝试同时 3 个)
3. **45min 硬限不够** — B3+B4 给 60min(可能代码量大)
4. **commit + push + report 最后 5min 容易超时** — 如果超时,resume worker 派 "只 commit + push + report" 短任务

---

## 5. 实施路径(完整 7 batches)

```
B1 数据模型 + storage + HTTP ✅ 36694c6
B2 Communicator + bus events + Live Trace ✅ aeec7f6
B3 Orchestrator + Planner + Executor ⏳ READY TO DISPATCH
B4 Harness Manager v0 + Harness UI ⏳ READY TO DISPATCH (parallel with B3)
B5 Planner + Executor 强化 ⏳ after B3+B4
B6 Harness Manager 强化 ⏳ after B3+B4
B7 Live Trace + Agent Panel 整合 ⏳ after B3+B4
C2 Server smoke debug ⏳ after B3
```

**M3+ 完成后** → M5(完整 Executor/Critic/Memory/Reflection + Artifacts UI)→ M6(Harness 真应用)→ M7(Scheduler)→ M8-M9(打磨发布)

---

## 6. 用户偏好(不能违反!)

### 工作方式
- **编码工作** **一律**派 worker — 不要在主会话写大量代码
- **派工标准工具**:`acp_delegate` agent=`worker`,async=true,model=balanced
- worker report 必须 100% 包含 9 项清单:
  1. `git log -1 --stat`
  2. `git status --short` (clean)
  3. `npm run typecheck` 末尾 5 行
  4. `npm test` 末尾 10 行
  5. `npm run build` 末尾 5 行
  6. node sanity 验证 (import dist 产物)
  7. 所有改动文件路径(绝对路径 + 行号)
  8. open questions / 后续 todo (≤5)
  9. (scoped 任务可省 server smoke)

### 视觉与设计
- 暖中性 `--bone-*` 蓝/琥珀 `--accent-*` 深浅双层
- 7 页路由(Chat/Agents/Memory/Goals/Scheduler/Artifacts/Harness/Profile/Settings)
- 一条 tab 看所有 agent 状态
- 高质感资产 + 矢量 SVG + 现代设计系统

### 不做的
- 中文横幅 / 误报 / 系统外发 / 失控 destructive 操作

---

## 7. 已知坑与教训

### pi-subagent 教训
- **优先用 `acp_delegate`**(取代老 `delegate_task`)
- **worker 静默死亡**:曾发生 B3/B4/PROBE 在 11:23 UTC 被同步 kill(可能 OOM / 进程 watchdog)— 无 completion 通知。**对策**:派后观察 5-10min,无 activity 立刻 resume + 给明确小任务
- **SIGTERM 误报**:worker 写完 + commit + push 后被 reap,但产物在仓库(C1 即如此)
- **writer conflict**:同 workspace 1 writer,B3+B4 必须并行派,C2 等 B3 完成

### bash 子 shell 教训
- bash 不 source ~/.bashrc → `$GITHUB_TOKEN` 用前 export
- `nohup ... > log 2>&1 < /dev/null &` 比 `disown + sleep + tail` 稳
- 长 prompt heredoc + pkill + sleep 易 137(SIGKILL)→ 拆开跑

### sansheng 教训
- **history rail**:useEffect deps 移除 `conversationId`,加 shallow sameList 比对
- **agent panel**:不要 hardcoded placeholder,要 dynamic fetch + 轮询
- **http endpoints**:每 route handler 内 try/catch + `errMsg()` helper,4 路由覆盖
- **onError**:app.onError 兜底 + 必返 JSON not HTML,前端 fetch 不检查 content-type
- **fetchUrl sandbox**:hostname allowlist + 私网 IP 拒绝(method/size 限制)
- **`@shared/*` runtime path alias 不解析** — 改成相对路径
- **CLI `start` 没起来** — server smoke 失败,需要 C2 修
- **migrations dir** — `MIGRATIONS_DIR` 在 dist/ 路径下指到不存在的位置,改双候选路径

### context 管理
- 大 compress 可 reclaim 150K→18K
- 硬限:每 ~30 tool call 主动 compress / 长 file read 拆 offset+limit
- 写代码全派 worker(主会话不写)

---

## 8. 新会话第一条消息(直接 copy-paste 用)

```
你是新会话,工作目录是 Sansheng 项目。
先读这 3 个文件再回我:
1. /root/projects/sansheng/HANDOFF.md
2. /root/projects/sansheng/PLAN.md
3. /root/.pi/agent/memory/MEMORY.md
然后告诉我:
- 当前 git head + 最近 5 个 commit
- M3+ Rebalance 架构核心(3 重身份 / 4 flows / BlackboardArtifact v3 / 5 bus events)
- M3+ 实施状态(7 batches 中哪些已完成 / 进行中 / 未开始)
- 下一步 3 个候选(B3 / B4 / C2)+ 派工建议(顺序 + timeout + 注意事项)
```

---

## 9. 一键 ready 验证

```bash
cd /root/projects/sansheng
git status --short             # 必须 clean
git log -5 --oneline           # 应见 aeec7f6 + 36694c6 + 2f4cd48
npm run typecheck 2>&1 | tail -3   # 0 errors
npm test 2>&1 | grep -E "Tests|Test Files" | tail -3   # 132 pass
npm run build 2>&1 | tail -3   # OK
node -e "import('./dist/src/server/index.js').then(m => console.log('OK:', typeof m.startServer))"
```

⚠️ **跳过** `sansheng start` + curl 8 个 manual tests — C2 待派,server smoke 暂不通过。

---

## 附录 A:文件指针

- **主 plan**:`/root/projects/sansheng/PLAN.md`(600+ 行,v5)
- **handoff**:本文件(v5.1)
- **MEMORY**:`/root/.pi/agent/memory/MEMORY.md`
- **Daily log**:`/root/.pi/agent/memory/daily/2026-09-29.md`
- **Pi docs**:`/root/.pi/agent/install/releases/0.87.1/node_modules/@earendil-works/pi-coding-agent/`
- **B3+B4+C2 worker prompts**:本文件 §4(含 scope + 约束 + 验证)

---

## 附录 B:本会话关键对话 ref

```
m00525 核心 insight (沟通员 = 升级版 plan 环节)
m00539 3 flows 细化
m00541 D9/D10/D11 锁定
m00632 D13 (Executor 实战 haproposal)
m00634 D14/D15 (M6 reactive input + Harness Manager v0)
m00641 finalize plan
m00651 整合 PLAN.md (v5)
m00677 收尾(HANDOFF/MEMORY 第一次更新)
m00691 用户 sign-off dispatch B1+B2
m00731 用户问跑完没 → 发现 B1+B2 完成
m00745 C1.5 resume → B2 commit + push
m00763 派 B3 + B4 + C2 (C2 writer conflict)
m00769 派 B4 (retry)
m00778 用户问进展 → 发现 B3+B4 静默死亡
m00784 用户问进展 → 派 PROBE
m00794 PROBE 完成(系统恢复 OK)
m00796 用户要求停任务 + 新开 session (current)
```

---

## 附录 C:Worker 完整 prompt 模板(ready to dispatch)

### B3 prompt(可直接用)

```
你是 Sansheng worker, working dir `/root/projects/sansheng` (node 22 + TypeScript, vitest + Hono + React web)。

# 必读(先读再动手)

1. /root/projects/sansheng/HANDOFF.md (§2-§4)
2. /root/projects/sansheng/PLAN.md "M3+ Rebalance — Core Architecture" + §"实施顺序"

# 任务:B3 — Orchestrator 重构 + Planner + Executor (60min)

## Scope (DO)

### Server
- src/server/agents/orchestrator.ts (REWRITE):event-sourced
  - artifact_created kind='intent' status='open' → spawn Planner
  - Planner 返回 todos → spawn Executors(DAG-aware parallel/sequential via dependsOn[])
  - executor_callback → 路由给 Communicator,标记 executor.status='waiting_for_decision'
  - decision artifact emitted → route 到 waiting executor + resume
  - watchdog: 5min 升级 user, 1hr 标 failed
  - max callback depth: 3,超过 escalate
- src/server/agents/planner.ts (NEW):接 intent artifact → LLM → 产 todo artifacts(DAG)
- src/server/agents/executor.ts (NEW):接 todo artifact → LLM → 产 evidence artifact + 可触发 callback
  - judgment callback: 写 hypothesis + reason='judgment' + 阻塞
  - harness_proposal callback: 写 hypothesis + reason='harness_proposal' + 阻塞
- src/server/agents/interrupts.ts (UPDATE):CancelToken 广播 + watcher
- shared/prompts/planner.md + executor.md (NEW or UPDATE)
- tests/server/agents/orchestrator.test.ts (UPDATE 或 NEW)
- tests/server/agents/planner.test.ts (NEW)
- tests/server/agents/executor.test.ts (NEW)

### 启动集成
- src/server/index.ts(或合适入口) wire Orchestrator + bus subscriptions

## Scope (NOT DO)
- 不改 BlackboardArtifact 数据模型(B1)
- 不改 Communicator 3 身份(B2)
- 不改 Harness Manager(B4)
- 不改 web/

## Constraints
- 不引入新依赖
- DAG-aware executor 调度(不是 parallel-everything)
- watchdog 每 30s 检查
- max callback depth 严格 3
- 跳过 server smoke(C2 排查中)

## 验证
npm run typecheck 2>&1 | tail -5
npm test 2>&1 | tail -10
npm run build 2>&1 | tail -5
node -e "import('./dist/src/server/index.js').then(m => console.log('OK:', typeof m.startServer))"

## Report 必含 9 项
1. git log -1 --stat
2. git status --short(必须 clean)
3. npm run typecheck 末尾 5 行
4. npm test 末尾 10 行(>= 132 + 本批次)
5. npm run build 末尾 5 行
6. node sanity 输出
7. 所有改动文件路径 + 行号
8. open questions / 后续 todo
9. 省略 server smoke

完成后 commit + push, commit message: feat(orchestrator): B3 orchestrator + planner + executor with DAG + callbacks
最后写 worker_report.md summary。
```

### B4 prompt(可直接用)— 与 B3 并行

```
(同 B3 模板,scope 改为 Harness Manager v0:

- src/server/agents/harnessManager.ts (NEW):订阅 harness_proposal,产 implementation_preview, **v0 read-only 严格**,**不写任何文件**
- shared/prompts/harness_manager.md (NEW):强调 read-only
- tests/server/agents/harnessManager.test.ts:必须 verify 无 FS mutation
- web/src/components/harness/ProposalCard.tsx (NEW)
- web/src/routes/Harness.tsx (v0 stub UI)
- tests/web/harness/ProposalCard.test.tsx (NEW)

NOT DO: 不改 Orchestrator / Planner / Executor (B3), 不改数据模型, 不触发 M6 apply

⚠️ B3 也在 parallel 跑,不要碰 B3 文件。如果 typecheck 冲突来自 B3,跳过那些文件,只在 harnessManager / web/harness / tests/... 里跑验证。

commit message: feat(harness): B4 Harness Manager v0 read-only preview + Harness UI
)
```

### C2 prompt(可直接用)— 等 B3+B4 完成

```
你是 Sansheng worker, working dir /root/projects/sansheng。

# 任务:C2 — Server Smoke Debug (15min)

## 背景
B1+B2 commit 后 worker 试图跑 server smoke 失败:
node dist/src/cli/index.js start --port 2718 --host 127.0.0.1 --data /tmp/sansheng-b1-smoke
# → "Failed to connect to 127.0.0.1 port 2718 after 0 ms: Couldn't connect to server"

即 server 没起来(或 bind 失败 / 立即崩溃)。

## Scope (DO)
1. 诊断: foreground 跑 start 命令, 捕获完整 stderr
2. 修: 让 server 真起来 + bind 2718
3. curl smoke: 8 个 manual tests 起步
   curl /api/health
   curl /api/blackboard/global
   curl /api/artifacts?limit=5
   curl /api/executors/test-executor-1/state
   curl POST /api/artifacts (note)
   curl /api/tools/list
   curl POST /api/chat
   curl POST /api/agents/interrupt
   每个返 JSON(可能 4xx/5xx, 但不是 connection refused)

## NOT DO
- 不改架构(修 bug + 加 logging 即可)
- 不碰 B3 / B4 文件
- 不改 tests/(除非加 server smoke 回归 test)

## Constraints
- 不引入新依赖
- 加 logging 知道 server 为什么没起
- foreground 跑诊断, background 跑 smoke

## 验证
rm -rf /tmp/sansheng-b1-smoke && mkdir -p /tmp/sansheng-b1-smoke
node dist/src/cli/index.js start --port 2718 --host 127.0.0.1 --data /tmp/sansheng-b1-smoke &
sleep 3
# 跑 8 个 curl
kill $SERVER_PID

## Report 9 项
1. git log -1 --stat
2. git status --short(必须 clean)
3. typecheck 末尾 5 行
4. test 末尾 10 行
5. build 末尾 5 行
6. node sanity 输出
7. **8 个 curl 输出**(原样贴, 标哪个 fail)
8. 修了什么 / 为什么
9. open questions / 后续 todo

commit message: fix(server): C2 server smoke debug + startup logging
```