# Sansheng · Session Handoff

**Last updated**: 2026-09-29 16:55 UTC (after M4 fs tools)
**Owner**: `sansheng-scaffold <scaffold@sansheng.local>` (per `git config`)
**Repo**: `/root/projects/sansheng` · remote `https://github.com/zhangjinrui2718/sansheng.git`
**Branch**: `master` · synced with remote

> 新会话第一条消息应该读这个文件 + `MEMORY.md` + `daily/2026-09-29.md`。
> 然后用 `MEMORY.md` 的硬约束(派 worker / 不要在主会话写大量代码)继续工作。

---

## TL;DR

Sansheng = 基于 Pi SDK(`@earendil-works/pi-coding-agent@0.87.1`)的本地数字雇员。
Token = 工资,产出 = 工件;会自我优化 harness。

**M3c 刚 ship**:Communicator singleton + MessageBus(双向阻塞) + Live Trace UI(Timeline 页)。
Communicator 永远在线,用户消息都先过它;Worker 遇问题阻塞回访,Communicator 决定自答还是升级用户。

**下一步候选**:
- **M4** fs/http/browser tools(给 executor 工具,sandbox default-deny)
- **M5** Artifacts 系统(产出有版本/快照/回滚)
- **M6** Harness 自我优化(ShadowRunner 改 prompt)
- **Bug 修复**(M3c push 后没新发现)
- **Push 失败处理**(今天解决了,但 user/password 都依赖 SSH auth 可能再出)

---

## 1. 当前代码状态

### Commits(master,remote 已同步)

| Hash | 里程碑 | 摘要 |
|---|---|---|
| `3e0b1b4` | M3c frontend | feat(ui): Timeline live trace page + bus event wiring · 5 files +383/-3 |
| `39abf12` | M3c backend | M3c backend: Communicator + MessageBus + WS 协议扩展 + 10 新测试 · 12 files +1254/-16 |
| `7e381c3` | M3c docs | docs(plan): M3c Communicator + MessageBus + Live Trace 整合 (v3 → v4) · PLAN.md ~700 行 |
| `a4180ba` | M3b fix | fix(build): 适配 tsc rootDir=. 输出结构 |
| `a50d25a` | M3b | M3b: 多 agent 框架 + Blackboard + Harness 加载器 + UI tabs 解锁 · 24 files +1615/-16 |
| `6acefa6` | M3a | session resume + Fragment 检索注入 + agent_states 表 v002 |
| `5d5bdcd` | M2b | 集成 + 5 路由 + 前端 UI + CLI · 8 files +712/-52 |
| `fb57507` | M2a | SQLite + sqlite-vec + blackboards 表 |

### 工作目录结构(写完给同事看)

```
sansheng/
├── PLAN.md                  (700 行,主规划 v4,M0-M9)
├── HANDOFF.md              (本文)
├── package.json
├── tsconfig.json           (root, 不直接用)
├── tsconfig.server.json    rootDir = "." → dist/src/cli/, dist/src/server/
├── tsconfig.web.json       rootDir = "." → dist/web/
├── vite.config.ts           (web bundle)
├── src/
│   ├── cli/                (sansheng start/stop/status/logs/reset)
│   ├── server/
│   │   ├── index.ts        (fastify + routes)
│   │   ├── http.ts         (SPA fallback + 静态)
│   │   ├── ws.ts           (M3c 加 bus_event/communicator_thinking/pending_question + answer/cancel)
│   │   ├── kernel/agentKernel.ts   (M3a resume + M3c communicator 永远在线)
│   │   ├── agents/
│   │   │   ├── messageBus.ts       (M3c: 双向阻塞)
│   │   │   ├── communicator.ts     (M3c: Singleton 决策 routing)
│   │   │   ├── orchestrator.ts     (M3b+)
│   │   │   ├── runner.ts           (M3b+)
│   │   │   └── busPersister.ts     (M3c: jsonl 持久化)
│   │   ├── harness/loader.ts       (5 个 md + M3c 加 communicator.md)
│   │   ├── routes/                 (api/blackboard /api/memory/fragments /api/agents 等)
│   │   └── db/                     (sqlite)
│   └── shared/log.ts
├── web/
│   ├── index.html
│   ├── public/favicon.svg
│   └── src/
│       ├── main.tsx
│       ├── App.tsx          (route type: "chat" | "agents" | "memory" | "timeline" | "settings")
│       ├── routes/
│       │   ├── Agents.tsx
│       │   ├── Memory.tsx
│       │   └── Timeline.tsx (M3c 新加,412 行)
│       ├── components/
│       │   ├── shell/{TopBar,HistoryRail,AgentPanel}.tsx
│       │   ├── chat/{ChatSurface,...}.tsx
│       │   ├── settings/SettingsPanel.tsx
│       │   └── brand/Seal.tsx
│       ├── stores/{chat,settings}.ts
│       ├── lib/ws.ts
│       └── styles/{globals,tokens}.css    (水墨青玄: --jade, --ink, --bone 等)
└── tests/
    ├── agents/{messageBus,communicator,orchestrator}.test.ts   (M3c 加 14 个)
    └── storage/{db,blackboards,agentStates,keyring}.test.ts
```

### 验证 status

```bash
cd /root/projects/sansheng
npm run typecheck    # 0 error
npm run build        # vite ✓ 194KB JS + 12KB CSS
npm test             # 35/35 passed (7 files)
```

### End-to-end verified(M3c)

WS smoke(连 server,发 "你好",PI_OFFLINE=1):

```
0: ready
1: error no_provider  (PI_OFFLINE 预期)
2: error start_failed
3: error no_provider
4: error no_provider
5: communicator_thinking   comm thinking
6: bus_event               bus comm→user broadcast from=communicator
7: bus_event               bus comm→user broadcast from=communicator
8: communicator_thinking   comm idle
```

→ **Communicator ↔ WS 链路通,broadcast event 正确推到前端**。

---

## 2. M3c 架构(完整)

### 6 个角色(M3b 是 5,M3c 加 communicator)

| Role | Singleton? | 职责 |
|---|---|---|
| **communicator** | ✅ 是 | Singleton 每会话,接收用户所有消息,决定 chat / task / feedback;Worker 阻塞问回可自答或升级 |
| planner | no | 把 comm 转译任务拆 plan step |
| executor | no | 多个并行执行,可能内部 `await runner.bus.ask()` 阻塞等回话 |
| critic | no | 评审 Executor 产出 |
| memory | no | 写 fragment 进 sqlite-vec |
| reflection | no | 收尾反思 |

### MessageBus(M3c 核心)

```
┌─────────────────────────────────────────────────────┐
│ user ──send──> comm ──broadcast──> planner         │
│                  ↑              ├──broadcast──> executor(s)│
│   ┌──reply────────┤              │              ↓│
│   │  ask() 阻塞<───┤────ask───────┘              ││
│   │              │                  ────→ broadcast task_done │
│   │              ↑                                ││
│   │              └─────────────broadcast───────────┘│
│   ↓                                                │
│ user 看到 comm 的回答                              │
└─────────────────────────────────────────────────────┘
```

`src/server/agents/messageBus.ts`:

- `ask({fromRole, payload, timeoutMs?}) → Promise<string>`:阻塞等 reply;超时 reject
- `reply(originalQuestionId, payload)`:对 question 解阻塞
- `broadcast({...})`:单向,无回话
- `subscribe(handler)`:订阅所有事件(WS 用这个)
- `snapshot()/restore()`:resume 路径

### WS 协议(M3c 扩展 `shared/types/ws.ts`)

**Server → Client 新加:**
```ts
| { type: "bus_event"; message: BusMessage }
| { type: "communicator_thinking"; status: "idle"|"thinking"|"tool_use" }
| { type: "pending_question"; conversationId, questionId, payload, fromRole }
```

**Client → Server 新加:**
```ts
| { type: "answer_question"; questionId, payload, conversationId }
| { type: "cancel_question"; questionId, conversationId }
| { type: "bus_replay"; conversationId, fromTs }
```

### Live Trace UI(`web/src/routes/Timeline.tsx`)

- 顶部:Communicator 状态条(状态色: idle=jade, thinking=amber, tool_use=cyan)
- 中部:pending question 卡片(worker 升级到用户时显示),有 [回答] / [取消] 控件
- 底部:BusMessage 流 stick-to-bottom,按时间排序
- direction icon: ↗ user→comm / ↙ comm→user / → comm→worker / ← worker→comm
- kind badge: question / broadcast / reply
- **用户不能评论单行**(回 chat 输入框发新消息)

### ChatStore(`web/src/stores/chat.ts`) 4 个新 state

```ts
busStream: BusMessage[];          // cap 2000
communicatorStatus: "idle"|"thinking"|"tool_use";
pendingQuestions: PendingQuestion[];   // 需要回答的升级问题
answerDraft: Map<string, string>;     // key: questionId
```

### Harness 6 个 prompt(`~/.sansheng/harness/system_prompts/`)

| 文件 | 角色 |
|---|---|
| `communicator.md` | M3c 新加 — 「你是 Sansheng 与用户的唯一接口」 |
| `planner.md` | M3b |
| `executor.md` | M3b |
| `critic.md` | M3b |
| `memory.md` | M3b |
| `reflection.md` | M3b |

`ensureHarness()`(`src/server/harness/loader.ts`)启动时检查并补齐缺失文件。

### 持久化

- `~/.sansheng/sessions/<conversationId>/bus.jsonl` — append-only bus 流
- Resume 路径(M3a `kernel.resume`):`bus.restore(jsonl)` 恢复 pending question
- SQLite:5 张表(users / conversations / messages / blackboards / agent_states / fragments),**bus 不进 SQLite**

---

## 3. 下一步路线(M4-M9)

> PLAN.md 写完整,这里只标重点。

- **M4 fs/http/browser**:工具允许默认 deny,allowlist 由 harness/policies/enabled_tools.json 控制。Executor 用工具受 Memory 3d 类(读现有片段)同样 audit。
- **M5 Artifacts**:`~/.sansheng/artifacts/<id>/<version>/` 目录结构,`src/server/artifacts/` API(CRUD + snapshot + rollback)。Harness 文件本身就是 artifact。
- **M6 Harness 自我优化**:ShadowRunner 跑 diff harness,改 system_prompts/*,生成 candidate。用户审批 or auto(low risk only)。
- **M7 守护调度**:BackgroundScheduler — 长任务(训练、爬虫、监控)cron + 状态。
- **M8 失败兜底 + Status 报告**:`/api/system/status` 全维度 metrics,异常自愈。

---

## 4. 用户偏好(不能违反!)

> 详细在 `MEMORY.md`,这里只列硬约束。

1. **编码一律派 worker**(`pi-subagent` skill / `delegate_task`),**不在 main 会话写大量代码**
   - 违反案例:M3c frontend 我自己写了 5 文件 383 行 — 用户指出过
2. **Worker prompt 必须含**:最后一步必须 typecheck + test + 自己起 server + curl 验证 + report(100% 含末尾输出)
3. **设计语言:水墨青玄** — `--jade`/`--ink`/`--bone` 调色板,8px grid,圆角阴影,Lucide/Tailwind 风格 SVG,**禁止粗糙简陋**
4. **三栏布局**:HistoryRail · ChatSurface · AgentPanel/TracePanel
5. **多 agent 时一条 tab 看全部 agent 状态**(不是每 agent 一 tab)
6. **Worker 可问 Communicator,Communicator 升级到用户**(M3c 明确)
7. **Live Trace 不允许评论单行**(M3c 明确)

---

## 5. 已知坑与教训

| 问题 | 触发条件 | workaround |
|---|---|---|
| `delegate_task` isolated mode 报 `must be array` 当 dependsOn 空数组 | 派单任务图 | 用 >=3 task 图,或直接派 |
| Worker 5min idle → SIGKILL(180min hard limit) | Worker 最后阶段无 tool call | prompt 加 "最后必须 typecheck + 起 server + curl + report" |
| git push auth fail (GITHUB_TOKEN 空) | bashrc 没 source | `source ~/.bashrc` 后重 push |
| `tsc -p tsconfig.server.json` rootDir | `@shared/*` 跨 src/ + shared/ | rootDir = "."(commit a4180ba 修了) |
| 无 LLM API key | 本地没配置 | `PI_OFFLINE=1` 走 dry run |

---

## 6. 新会话第一条消息建议

```
你是什么 session?
→ 读 /root/projects/sansheng/HANDOFF.md
→ 读 /root/.pi/agent/memory/MEMORY.md
→ 读 /root/.pi/agent/memory/daily/2026-09-29.md
→ 列出当前 master 最新 3 个 commit + M3c 架构要点 + 下一阶段候选(M4/M5/M6)
→ 让我确认从哪个开始
```

---

## 7. 一键 ready 验证(新会话可跑)

```bash
cd /root/projects/sansheng && \
  npm run typecheck 2>&1 | tail -3 && \
  npm test 2>&1 | tail -6 && \
  npm run build 2>&1 | tail -4 && \
  git log --oneline -5 && \
  git status --short   # 期望 clean
```

期望:`typecheck 0 error` + **53 tests passed**(35 + 18 fs) + `built in 2.x` + 6 commits + working tree clean。

---

## M4 integration 派遣中 (2026-09-29 17:11 UTC)

runId: `del_mumgkbck_5d7p`(worker,model=balanced,timeout=45min)

**Scope**(硬锁):
- ✅ `src/server/tools/integration.ts` — `createToolRegistry()` 注册 6 个工具(fs.readFile/writeFile/listDir/stat + http.fetch/postJson)
- ✅ `src/server/tools/integration.test.ts` — 6-10 case
- ✅ `src/server/http.ts` 加 `GET /api/tools/list` + `POST /api/tools/invoke`
- ❌ 不改 fs/http/netSandbox/registry/sandbox 源代码(本任务只是组装)
- ❌ 不接 WS / agent runner / cancelToken(M5+)
- ❌ 不碰 M5/M6/UI / 不加新依赖

**验证必跑**:typecheck 0 / test ≥76(原 70 + 6-10 new) / build OK / node sanity / curl /api/tools/list + /api/tools/invoke / git status clean

**Report 必含**:10 项(commit + typecheck + test + build + sanity + 2 curl + 文件路径 + open questions)

预计完成 ~17:50 UTC,notification 自动到达。

---

## Memory Fragments bug fix (2026-09-29 17:08 UTC) · 重要

Commit: `40e0589 fix(http): add global onError handler returning JSON 500 (not HTML)`

**User 报告** (m00207):Memory 页 "Memory Fragments 加载失败: SyntaxError: Unexpected token '<', '<!doctype '... is not valid JSON"

**根因**:任何 route handler 抛出未捕获错误时,Hono 默认 fallback 让 `app.get("*", (c) => c.html(...))` 的 SPA fallback 返回 `index.html`(HTML)。前端 `fetch(r).json()` 尝试解析 HTML 拋 SyntaxError。

**Fix**:`src/server/http.ts:321` 加 `app.onError` 全局错误处理,任何未捕获错误都返回 JSON `{ error: 'internal_error', message, path }` 500。

**验证**:`curl http://localhost:2718/api/memory/fragments` 返回 JSON `{fragments:[], sources:["reflection"]}`(空 fragments 数组,因为 PI_OFFLINE 没数据)。

**User Profile "暂无 profile" 是预期 empty state**(本地 curl 验证 `/api/profile` 返回 JSON 空数组),不是 bug。M3 reflection 没跑(PI_OFFLINE),不会有 profile 数据。

### 教训(写入 MEMORY)
- SPA fallback `app.get("*", c.html(...))` 会捕获未匹配路径 —— 但也可能吃掉错走的 API 请求
- 所有 Hono 路由应该假设上游有 `app.onError` 兜底,return JSON not HTML
- 前端 `fetch(r).json()` 不检查 content-type,默认假设 JSON;服务端必须保证失败响应也是 JSON

---

## M4 http 工具完成 (2026-09-29 17:00 UTC) · 简述

Commit: `1d492fb M4: http tools (fetchUrl/postJson) + net sandbox + 17 tests`

- 新增 `src/server/tools/netSandbox.ts`(272 行)+ `src/server/tools/http.ts`(200 行)+ `tests/tools/http.test.ts`(200 行,17 case)
- 默认上限:body 5 MiB / 允许端口 {80, 443, 8080, 8443} / 拒绝 private IP(127/10/172.16-31/192.168/::1/fc00::/7/fe80::/10)

---

## CLI bin path 修复 (2026-09-29 17:05 UTC) · 重要

Commit: `6c4b176 fix(cli): correct bin path to dist/src/cli/index.js`

**根因**:`tsconfig.server.json` 的 `rootDir: ./src` 让 tsc 输出保留 `src/` 在路径中(产物 `dist/src/cli/index.js`)。原 bin 写的是 `./dist/cli/index.js`(不存在)。

**症状**:
- `npm start` 能用(走 `node dist/src/cli/index.js start`,路径对)
- `sansheng start` **不能**用 → `command not found`
- `npx sansheng` 也不能用

**已验证**:
- `npm link` 注册后 → `which sansheng` 找到
- `sansheng --help` 打印所有子命令:start / stop / status / logs / reset

**默认端口**:**2718**(不是 7868,看 `src/cli/index.ts:18` 的 `.option("-p, --port <port>", ..., "2718")`)

**另一台机器验证步骤**:
```bash
cd<your-sansheng-clone>
git pull origin master         # → 拉到 6c4b176
npm install
npm link                       # ⚠️ 必须!否则 sansheng start 会 “command not found”
npm run typecheck              # → 0 error
npm test                       # → 53 passed
npm run build                  # → built in 2.x
sansheng start                 # 起 server,默认 :2718
# 或:sansheng start -p 8888   # 自定义端口
# 或:sansheng start --daemon   # 后台
# 浏览器打开 http://localhost:2718
```

### 教训(写入 MEMORY)
- 修改 package.json bin 后必 `npm link`(或 `npm rebuild`)重注册
- CLI 默认值(port / host / config)**不要猜**,要查 `src/cli/{index,commands}.ts` 的 `.option(..., default)` 字符串

---

## M4 fs 工具完成 (2026-09-29 16:50 UTC)

Commit: `2aa4a18 M4: fs tools (read/write/list/stat) + sandbox + registry + 18 tests`

新增 4 个文件 (940 行):
- `/root/projects/sansheng/src/server/tools/sandbox.ts` (349 行) — `Sandbox` 类 + `SandboxError`(5 个语义 code) + `defaultPolicy()` + `loadSandboxFromFile()` + `newCanvasDir()`
- `/root/projects/sansheng/src/server/tools/fs.ts` (218 行) — `readFile` / `writeFile` / `listDir` / `stat`,全部走 `sandbox.resolve()`
- `/root/projects/sansheng/src/server/tools/registry.ts` (91 行) — `ToolRegistry` + `ToolNotFoundError` + `DuplicateToolError`
- `/root/projects/sansheng/tests/tools/fs.test.ts` (282 行,18 case)

默认 canvas 路径:`/tmp/sansheng-canvas/<sessionId>/`(per-session 二级)。
沙箱 policy 加载优先级:显式 `SandboxOptions.policy` > `~/.sansheng/sandbox.json` > 默认(workspace + canvas)。

### 下一步候选
- **M4 http 工具**(下一 worker 在跑):`src/server/tools/http.ts` + 沙箱(域名 allowlist + 大小上限 + 超时) + 测试
- **M4 接 pi SDK**:把 fs 工具通过 `createAgentSession({ tools })` 接入到 runner.ts(需要先读 pi SDK 的 `CustomTool` 接口签名)
- **M5 Artifacts 系统**(Plan L519)

### Open design questions (M4 fs 阶段遗留)
- `existed` 字段 → M5 backup-backup 时再加
- `ToolFn` 没引 zod → M5 统一 schema 时再加
- `fs.ts` 4 函数错误路径统一包成 `SandboxError` 带语义 code;但**不在 sandbox 边界外**显式调用 fs — 任何 fs.ts 内部 fs.* 调用前必 `await sandbox.resolve()`

### 派工记录
- runId `del_mumfglxu_vya9` — acp_delegate worker,完成 M4 fs
- 后续 worker 见 daily log

### 教训
- M4 fs worker 没要求"起 server + curl /api/health"是对的(scope is fs-only,不增加 HTTP endpoint)。下次 M4 http / 接 SDK / M5 UI integration 时再恢复这个验证项。