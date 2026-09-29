# Sansheng 项目交接包

**生成时间**:2026-09-29 18:00 UTC · v5(M3+ Rebalance plan 锁定后)
**适用**:下一会话(主对话 / worker)开盒即读
**配套阅读**:`/root/projects/sansheng/PLAN.md`(v5 集成版),`/root/.pi/agent/memory/MEMORY.md`

---

## TL;DR

Sansheng = 单用户本地 Node 服务(pi SDK + Communicator singleton + 6 worker + 持久化 + fs/http 工具)。M0-M4 全完成(81 tests pass,6 commits 在 remote),M3c 跑了 Communicator + MessageBus + Live Trace,M4 跑了 fs + http + net sandbox + registry + `/api/tools/*` endpoints。

**当前坐标**:M4 → M3+ Rebalance 过渡。**M3+ plan 已锁定**(2026-09-29 17:50 UTC,15 个决策 D1-D15,4 个 flows A/B/C/D,BlackboardArtifact v3 + 10 kind 全局新增/已并入)。

**下一步**:7 batches (B1-B7) 并行派工,实现 M3+ 架构升级。`PLAN.md` §11 + §"实施顺序" 列出执行路径。

---

## 1. 当前代码状态

| 指标 | 值 |
|---|---|
| git head | `4b2a48f fix(ui): history rail no jump on click + agent panel live blackboard` |
| commits 在 remote | 8(M0→M4 全推送) |
| 测试 | **81 pass**(70 + M4 fs/http/integration/UI 共 11) |
| typecheck | 0 errors |
| build | OK |
| data dir | `~/.sansheng/`(默认) |
| 单进程 Node 服务 | ✓,默认 `127.0.0.1:2718`,`--daemon` 支持 |
| bundle 验证 | web dist 含期望字符串 |
| 总文件 | src/server (~40) + web (~30) + shared (~20) + tests (~30) |

**已完成模块**(M0-M4):

```
M0  骨架            package / tsconfig / Hono / vite / design tokens / CLI / daemon
M1  Kernel + 单 agent 对话
M2  持久化 + 记忆    SQLite + sqlite-vec + keyring + fragments extractor
M3a 多 agent 基础    orchestrator + session pool + agents route
M3b System Prompts  planner / executor / critic / memory / reflection 5 个 md + 加载
M3c Communicator + MessageBus + Live Trace
    - Communicator singleton (3 重身份骨架在 v5 扩展)
    - MessageBus (bus.jsonl + WS broadcast)
    - Live Trace Timeline 页
M4  行动工具        fs(3) + http(2) + net sandbox + registry + /api/tools/list + /api/tools/invoke
```

**最近 commits**:
```
4b2a48f fix(ui): history rail no jump on click + agent panel live blackboard
570467b fix(http): per-handler try/catch on blackboard/fragments endpoints
1d492fb feat(tools): M4 http (fetchUrl, postJson, net sandbox, 10 tests)
40e0589 fix(http): global onError returns JSON 500
b5d1404 feat(tools): M4 fs (readFile/writeFile/listDir, 12 tests)
0f01a48 feat(integration): createToolRegistry + /api/tools/{list,invoke}
43e7bf0 docs(handoff): Memory Fragments bug fix (onError)
```

---

## 2. M3+ Rebalance 架构(完整)

来源:本会话主对话维护 → 整合进 `PLAN.md` §"M3+ Rebalance — Core Architecture"

### 核心 insight

- **大多数对话 = 对齐,不是执行**
- **Communicator = 升级版 plan 环节**,产出 BlackboardArtifact 到**全局 bb**(不是每条对话触发多 agent 流程)
- **全局 bb + per-conv bb 双 scope**(D1)
- **3 重身份**(D2):reactive input + plan producer + proactive observer

### BlackboardArtifact v3(M3+ first-class)

- **10 kinds**:decision / hypothesis / harness_proposal / implementation_preview / intent / todo / note / evidence / critique / reflection
- **新增字段**(D8/D13):`scope`, `executors[]`, `dependsOn[]`, `parentIntent`, `metadata.{callbackReason, category, riskLevel, filesToChange}`
- **status**:open / in_progress / waiting_for_decision / resolved / superseded / failed
- **DB migration**:additive only — `blackboards` 加 `artifacts_json` 列,默认 `'[]'`,旧 rows 读时从 `produced_artifacts_json` + `decisions_json` 升级

### 4 个 Flows(详细见 PLAN.md §2)

- **Flow A** — User-initiated:user msg → Communicator → artifacts(decision/hypothesis/intent/note)→ global bb → if `intent` open → Orchestrator spawns Planner
- **Flow B** — Communicator-initiated Proactive Observer:订阅 bb events(resolved/failed)→ emit note + user message(D10 仅此 2 类触发)
- **Flow C** — Executor judgment callback:Executor 写 hypothesis + 阻塞 + bus `executor_callback` → Communicator 决策 → `decision` artifact → Executor resume
- **Flow D** — Executor harness_proposal callback:Executor 写 hypothesis + `reason='harness_proposal'` → Communicator 写 `harness_proposal` artifact → Harness Manager 订阅 → 产 `implementation_preview`(v0 不写)

### 5 个新 bus events

```
artifact_created           ← 全局 + per-conv
artifact_status_changed    ← status 变化
executor_callback          ← Executor 阻塞请求决策
executor_resume            ← Communicator 决策后 Executor 恢复
harness_proposal_created   ← Harness Manager 订阅
```

### Decisions (D1-D15,locked)

D1 双 scope · D2 Communicator 3 重身份 · D3 `intent` open 触发 · D4 复用 M3c infra · D5 其它角色订阅全局 bb · D6 保留 M3a chat UX · D7 structured output + fallback note · D8 execution tracking · D9 阻塞回调 · D10 observer 仅 resolved/failed · D11 每次 callback 产 decision artifact · D12 单本机无 auth · D13 executor 可发 haproposal · D14 haproposal = M6 reactive input · D15 Harness Manager v0 独立 agent 订阅,read-only

---

## 3. 下一步路线(M3+ → M9)

### M3+ 实施顺序(7 batches)

```
Step 1(已完成)✓ 更新文档
  - PLAN.md 替换 (v5 集成版,600+ 行)
  - HANDOFF.md 替换(本文件)
  - MEMORY.md 更新(待 Step 1 收尾)

Step 2(用户 review 文档)⏳

Step 3(worker B1+B2 parallel,45min/each):
  B1 数据模型 + storage migration + HTTP endpoints
    - shared/types/blackboard.ts (BlackboardArtifact v3, 10 kinds)
    - shared/types/bus.ts (5 new events)
    - src/server/storage/repo/blackboards.ts (artifact CRUD + migration)
    - src/server/storage/db.ts (additive migration: artifacts_json column)
    - src/server/http.ts (新增 /api/blackboard/global + /api/artifacts/* + /api/executors/:id/state)
    - tests/server/storage/blackboards.test.ts
    - tests/server/http/blackboard.test.ts + artifacts.test.ts + executors.test.ts

  B2 Communicator 升级 + bus events + Live Trace 渲染
    - src/server/kernel/communicator.ts (3 重身份:reactive + plan producer + observer)
    - src/server/bus/events.ts (5 新 event types)
    - src/server/bus/index.ts (publish/subscribe API)
    - shared/prompts/communicator.md (D7 structured output + Intent 验证 + Harness Proposal 风险分类)
    - web/src/components/agents/BlackboardView.tsx (artifact cards by kind)
    - web/src/components/agents/TraceTimeline.tsx (waiting_for_decision 脉动)
    - web/src/stores/blackboard.ts (Zustand,artifact state)
    - tests/server/agents/communicator.test.ts (3 identities)
    - tests/web/agents/artifact-cards.test.tsx

Step 4(worker B3+B4 parallel,60min/each,after B1):
  B3 Orchestrator 重构 + Planner + Executor
    - src/server/agents/orchestrator.ts (event-sourced)
    - src/server/agents/planner.ts (intent → todos DAG)
    - src/server/agents/executor.ts (evidence + 阻塞回调 judgment/haproposal)
    - src/server/agents/interrupts.ts (CancelToken,watchdog)
    - shared/prompts/planner.md + executor.md
    - tests/server/agents/orchestrator.test.ts + planner.test.ts + executor.test.ts

  B4 Harness Manager v0 + Live Trace 完善
    - src/server/agents/harnessManager.ts (订阅 haproposal,产 implementation_preview,**无 file write**)
    - shared/prompts/harness_manager.md
    - web/src/components/harness/ProposalCard.tsx (preview 渲染)
    - web/src/routes/Harness.tsx (v0 stub,previews)
    - tests/server/agents/harnessManager.test.ts (verifies NO FS mutations)

Step 5(worker B5+B6+B7 parallel,60min/each,after B3+B4):
  B5 Planner + Executor 强化
  B6 Harness Manager 强化
  B7 Live Trace + Agent Panel 整合

Step 6(用户验证):
  - 跑 §验收标准 8 个 manual tests
  - Typecheck / tests / build / smoke
  - git clean
```

### M5-M9 路线(PLAN.md §"实施顺序")

```
M5 ✓(M3+ 后)完整 Executor / Critic / Memory / Reflection 实现 + 全量 Artifacts UI
M6 (scaffolded in M3+ v0 stub,full in 后续 plan)Harness 自优真应用:proposer / riskClassifier / shadowRunner / rollback
M7 守护调度 + Goals + Scheduler UI
M8 失败兜底 + 状态报告 + 进度报告
M9 打磨 + 测试 + 发布
```

### 关键风险(M3+ 新)

- Communicator 误分类 → Intent 验证 else hypothesis
- Executor callback 死循环 → Max depth 3
- Observer 噪音 → D10 仅 resolved/failed
- Harness Manager v0 误写文件 → 代码无 file write path + tests verify
- Global bb 增长 → cleanup M5+
- Structured output parse 失败 → fallback single note
- DB migration 破坏 → additive only
- waiting_for_decision leak → Watchdog 5min→escalate,1hr→failed

---

## 4. 用户偏好(不能违反!)

来源:`MEMORY.md` `#preference #workflow` + `#sansheng`

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
- 一条 tab 看所有 agent 状态(不是每 agent 一 tab)
- 高质感资产 + 矢量 SVG + 现代设计系统

### 不做的
- 中文横幅 / 误报 / 系统外发 / 失控 destructive 操作

---

## 5. 已知坑与教训

### pi-subagent 教训
- **优先用 `acp_delegate`**(取代老 `delegate_task`)
- v4 "empty array = not array" bug 已修,老 workaround 可丢
- 派 worker 后**立即转去别的事**,不要轮询(等自动通知)
- SIGTERM 误报:worker 写完 + commit + push 后被 reap,但产物在仓库

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

### context 管理
- 大 compress 可 reclaim 150K→18K
- 硬限:每 ~30 tool call 主动 compress / 长 file read 拆 offset+limit
- 写代码全派 worker(主会话不写)

---

## 6. 新会话第一条消息建议

```
你是新会话,工作目录是 Sansheng 项目。
先读这 3 个文件再回我:
1. /root/projects/sansheng/HANDOFF.md
2. /root/projects/sansheng/PLAN.md
3. /root/.pi/agent/memory/MEMORY.md
然后告诉我:
- 当前 git head + 最近 3 个 commit
- M3+ Rebalance 架构核心(3 重身份 / 4 flows / BlackboardArtifact v3 / 5 bus events)
- M3+ 实施状态(7 batches 中哪些已完成 / 进行中 / 未开始)
- 下一步 3 个候选 + 建议从哪个开始
```

---

## 7. 一键 ready 验证(新会话可跑)

```bash
cd /root/projects/sansheng
git status --short             # 必须 clean
git log -3 --oneline           # 应见 M4 + UI fix commits
npm run typecheck 2>&1 | tail -5   # 0 errors
npm test 2>&1 | tail -10       # 81 pass
npm run build 2>&1 | tail -5   # OK
ls dist/                       # web dist + server bundle
node -e "import('./dist/server/index.js').then(m => console.log('OK:', typeof m.startServer))"
sansheng start --port 2718 --daemon
sleep 2
curl -s http://localhost:2718/api/health
curl -s http://localhost:2718/api/blackboard/global  # 应返 200 + empty global bb
curl -s http://localhost:2718/api/tools/list  # 应返 6 工具
sansheng stop
```

---

## 附录 A:文件指针(完整 plan)

- **主 plan**:`/root/projects/sansheng/PLAN.md`(600+ 行,v5)
- **Pi docs**:`/root/.pi/agent/install/releases/0.87.1/node_modules/@earendil-works/pi-coding-agent/`
- **MEMORY**:`/root/.pi/agent/memory/MEMORY.md`
- **Daily log**:`/root/.pi/agent/memory/daily/2026-09-29.md`

---

## 附录 B:本会话关键对话 ref(主对话历史)

```
m00525 核心 insight (沟通员 = 升级版 plan 环节)
m00539 3 flows 细化
m00541 D9/D10/D11 锁定 (阻塞回调 + observer 仅 resolved/failed)
m00632 D13 (Executor 实战 haproposal)
m00634 D14/D15 (M6 reactive input + Harness Manager v0 独立 stub)
m00641 finalize plan
m00651 整合 PLAN.md (v5 集成)
m00669 删除 PLAN_new.md
m00671 收尾 + 准备 dispatch (当前)
```

---

## 附录 C:Dispatch 模板(Step 3 B1+B2)

### B1 — 数据模型 + storage + HTTP

```
agent: "worker"
cwd: "/root/projects/sansheng"
model: "balanced"
async: true
timeoutMinutes: 45

task: |
  你是 Sansheng worker,working dir /root/projects/sansheng (node 22 + TypeScript)。
  
  读这两个文件再动手:
  1. /root/projects/sansheng/HANDOFF.md (尤其 §2 M3+ Rebalance 架构)
  2. /root/projects/sansheng/PLAN.md (尤其 "M3+ Rebalance — Core Architecture" 和 §"Data Model")
  
  Scope (DO):
  - shared/types/blackboard.ts (NEW): BlackboardArtifact v3, 10 kinds, BlackboardScope, ArtifactKind, ArtifactStatus
  - shared/types/bus.ts (UPDATE): 加 ArtifactCreatedEvent, ArtifactStatusChangedEvent, ExecutorCallbackEvent, ExecutorResumeEvent, HarnessProposalCreatedEvent
  - src/server/storage/repo/blackboards.ts (UPDATE): artifact CRUD + migration helper
  - src/server/storage/db.ts (UPDATE): additive — `artifacts_json` 列 (nullable, default '[]'), migration function
  - src/server/http.ts (UPDATE): GET /api/blackboard/global, GET /api/artifacts/:id, GET /api/artifacts?scope=&kind=&status=&limit=, GET /api/executors/:id/state
  - tests/server/storage/blackboards.test.ts (NEW): artifact CRUD + migration (legacy row 升级)
  - tests/server/http/blackboard.test.ts (NEW): global bb endpoint
  - tests/server/http/artifacts.test.ts (NEW): artifact CRUD + scope/kind filter
  - tests/server/http/executors.test.ts (NEW): executor state endpoint (mock stub executor)
  
  Scope (NOT DO):
  - 不要改 Communicator / Executor / Planner / Harness Manager / Orchestrator(那是 B2/B3/B4 的活)
  - 不要改 web/ 前端
  - 不要改 v4 测试
  
  Constraints:
  - DB migration additive only — 旧 rows 必须能读
  - 所有 endpoint 必走 onError try/catch (参考现有 handlers)
  - artifact.kind validation (10 kinds whitelist)
  - 不要引入新依赖
  
  Report 必须含 9 项:
  1. git log -1 --stat
  2. git status --short (clean)
  3. npm run typecheck 末尾 5 行
  4. npm test 末尾 10 行 (>= 现有 + 新增)
  5. npm run build 末尾 5 行
  6. node sanity (import dist)
  7. 所有改动文件路径 + 行号
  8. open questions / todo
  9. scoped — 暂不做 server smoke (起 server 后 curl /api/blackboard/global 等可省,等 B2/C1 整合时再做)
```

### B2 — Communicator + bus events + Live Trace

```
agent: "worker"
cwd: "/root/projects/sansheng"
model: "balanced"
async: true
timeoutMinutes: 45

task: |
  你是 Sansheng worker, working dir /root/projects/sansheng (node 22 + TypeScript)。
  
  读这两个文件再动手:
  1. /root/projects/sansheng/HANDOFF.md (尤其 §2 M3+ Rebalance 架构, 4 flows)
  2. /root/projects/sansheng/PLAN.md (尤其 Communicator 3 身份 + bus events + Live Trace)
  
  Scope (DO):
  - src/server/kernel/communicator.ts (UPDATE): 3 身份 (reactive input + plan producer + observer), D7 structured output, Intent 验证, Harness Proposal 风险分类
  - src/server/bus/events.ts (UPDATE): 5 新 event payload types
  - src/server/bus/index.ts (UPDATE): publish/subscribe API for new events
  - shared/prompts/communicator.md (UPDATE): D7 structured output JSON schema + Intent validation + risk classification
  - web/src/components/agents/BlackboardView.tsx (NEW): artifact cards (10 kind colors per PLAN §Defaults)
  - web/src/components/agents/TraceTimeline.tsx (UPDATE): waiting_for_decision 脉动 + 10 kind 颜色
  - web/src/stores/blackboard.ts (NEW): Zustand store for artifacts
  - web/src/lib/ws.ts (UPDATE): handle artifact_created + status_changed + callback events
  - tests/server/agents/communicator.test.ts (NEW): 3 identities + structured output parse + fallback
  - tests/web/agents/artifact-cards.test.tsx (NEW): 10 kind 渲染
  
  Scope (NOT DO):
  - 不要改 Orchestrator / Planner / Executor / Harness Manager (B3/B4)
  - 不要改 artifact 数据模型 (B1)
  - 不要改 storage / DB
  
  Constraints:
  - Communicator LLM 输出必须是 JSON,parse 失败 → emit single note
  - Intent 验证:imperative verb OR non-empty refs,else → hypothesis
  - Observer 订阅:仅 artifact_status_changed when newStatus ∈ {resolved, failed}
  - Live Trace 颜色 per PLAN §Defaults
  - 不要引入新依赖
  
  Report 必含 9 项 (B1 同模板, scoped — 等 B1+C1 整合 server smoke)
```