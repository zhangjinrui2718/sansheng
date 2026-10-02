# Sansheng · 三生机器人 · 实施计划 (v5 · + M3+ Rebalance)

**版本**:v5 — 在 v4 (Communicator + MessageBus + Live Trace) 之上,完成**沟通员角色重定位**(从 chat reply agent 升级为 plan producer + observer + reactive input) + **全局 blackboard** 引入 + **Executor 阻塞回调机制** + **Harness Manager v0** 接入

**生效日期**:2026-09-29
**上一版本**:[PLAN.md v4](7e381c3 docs(plan): M3c Communicator + MessageBus + Live Trace 整合)

---

## 摘要

在空仓库 `/root/projects/sansheng` 中,从零搭建一个**单用户、本机常驻的 Node 服务**:通过 `@earendil-works/pi-coding-agent` SDK 驱动一个**Communicator Singleton + 多角色 Worker Pool** 体系——Communicator 作为**三重身份**(reactive input + plan producer + proactive observer)与用户和 worker 协作,Planner / Executor / Critic / Memory / Reflection / Harness Manager 6 个 worker 通过**全局 blackboard + per-conversation blackboard** 协作,Executor 可**阻塞回调**到 Communicator(judgment 或 harness_proposal),共享一个**SQLite + 向量编码** 的持久化层,具备**文件 / HTTP** 两类行动能力(M5+ 加 browser / shell / notify)。

**核心对话模型(M3+ rebalance)**:大多数对话 = 对齐,不是执行。Communicator 把对话**转化为结构化 artifact**(decision / hypothesis / intent / note / harness_proposal),写入全局 blackboard,只有 `intent` 类 artifact 触发 Planner → Executor 执行链。Communicator 后台 observer 在 bb 事件(resolved/failed)上主动向用户汇报。Executor 干活时如遇判断点 → 写 hypothesis + 阻塞 + 回调 Communicator → 拿到 `decision` artifact 后 resume;若发现可复用模式 / 缺工具 / 更好方案 → 回调 kind=`harness_proposal` → Harness Manager 订阅处理(生成 implementation_preview,**v0 不写文件**,M6 apply 是后续 plan)。

Sansheng **通过持续优化自己的 harness**(system prompts / 工具集 / 路由策略 / 红线 / budget / plan templates / context 管理 / memory 阈值)来越来越好地完成用户任务。Harness 改动有**两个入口**:(1) M5+ Reflection 主动提议;(2) M3+ Executor 实战提议(本 plan 的 D13)。所有 harness 改动走**影子测试**验证,低风险自动应用,中高风险需用户审批。harness 文件本身是 harness 特殊的 **artifact**,享受全量快照 / 版本 / 回滚。

以 **npm 包**形式分发,启动后默认监听 `http://localhost:2718`,用户从任意浏览器访问即可使用。

> 默认显示名「三生」;在 Web Settings 中可改。

---

## 关键架构决策(完整版)

### 形态与分发

- **单进程 Node 服务** + 内置 Web SPA(react+vite)
- **CLI**:`sansheng start [--port 2718] [--host 127.0.0.1] [--daemon] [--data <path>]`
- **npm 包分发**(`npm install -g sansheng`);首次启动初始化 `~/.sansheng/`
- **离线优先**:不收集遥测,无网络上报(除 LLM API 调用)
- **绑定默认** `127.0.0.1:2718`;`--host 0.0.0.0` 需用户显式启用

### Web 视觉

- **设计 tokens**:`--bone-*` 暖中性 + `--accent-*` 蓝/琥珀强调;深浅双层
- **7 页路由**:Chat(主对话)/ Agents(多 agent + blackboard)/ Memory(片段)/ Goals / Scheduler / Artifacts / Harness / Profile / Settings
- **三栏布局**(主对话):会话历史(左)+ 对话流(中)+ Blackboard + Agent 状态 + Trace(右);小屏右侧 tab 折叠
- **Live Trace Timeline**(M3+ 强化):artifact 卡片按 kind 颜色 + status 徽章 + waiting_for_decision 脉动

### 认知与多 agent(M3+ 重构)

详见 §"M3+ Rebalance — Core Architecture"。

**角色清单(7 个)**:
- **Communicator**:singleton,常驻,3 重身份(reactive input + plan producer + proactive observer)
- **Planner**:per-intent,产出 todo artifacts(DAG)
- **Executor**:per-todo,产出 evidence / 阻塞回调(judgment 或 harness_proposal)
- **Critic**:per-evidence-batch,产出 critique
- **Reflection**:per-intent-end,产出 reflection
- **Memory**:continuous background,产出 consolidated note
- **Harness Manager (v0 stub)**:per-harness_proposal,产出 implementation_preview,**v0 不写文件**

**Blackboard 双 scope**:`scope: 'global'`(单例,`__global__`,跨会话共享意图/知识)+ `scope: 'conversation'`(每会话独立 scratch state)。

### Sansheng 的"灵魂"—— 数字雇员

- **token 即工资,产出即工件**:用户预算 = 雇员工资上限
- **持久化人格**:memory fragments + user profile = 雇员长期记忆
- **harness = 雇员手册**:可被雇员自己改、用户审
- **失败分级响应**(L1-L4):轻微 → 重试,中等 → 暂停,灾难 → 安全

### Harness 自我优化(核心差异化)

- **双输入源**(M3+):(1) Reflection 主动提议;(2) Executor 实战提议(D13)
- **风险分类**(由 proposer.ts 启发式):
  - `low` — system prompt 文本 / plan templates / context 策略 / memory 阈值 / routing 微调
  - `medium` — 工具开关 / retry policy / budget 阈值
  - `high` — red lines / sandbox / 任何安全相关
- **影子测试**:新 harness 在 replay sandbox 跑历史任务,对比 KPI(成功率 / token 用量 / 反馈分)
- **自动应用**:仅低风险 + shadow test 通过
- **用户审批**:中风险弹 chat 通知,高风险必须显式确认
- **全量回滚**:harness 文件享受版本化,任意版本可回退

### LLM 与重试

- **provider 抽象**:Anthropic / OpenAI / 自定义 OpenAI-compatible / 本地 Ollama
- **keyring**:AES-256-GCM 加密,`chmod 0600`,密码可选(默认 OS keychain via `keytar`)
- **重试**:指数退避 + jitter;上限 3 次 / 1 任务
- **fallback provider**:本月不上,后续
- **thinking level**:全局设置 + per-agent override(`harness.systemPrompts.<role>.thinkingLevel`)

### 行动能力(沙箱默认拒绝)

- **fs**:`/tmp/sansheng-canvas/<sessionId>/` 是默认根,allowlist 内才允许操作
- **http**:hostname allowlist + 私网 IP 拒绝 + method/size 限制
- **browser** (M5+):Playwright headless,domain allowlist
- **shell** (M5+):命令白名单,禁止管道到网络
- **notify** (M5+):发邮件/系统通知,需用户授权
- **sandbox violation**:必抛 + 写入 audit trail

### 持久化与存储

- **SQLite + sqlite-vec**:`~/.sansheng/sansheng.db`
- **5 张表**:
  - `users` — 单用户
  - `conversations` — 会话元数据
  - `messages` — 完整 IO 流(append-only)
  - `blackboards` — Blackboard 快照,**新加 `artifacts_json` 列**(M3+)
  - `agent_states` — agent session 状态
  - `fragments` — 长期记忆片段 + 向量
- **bus 不入 SQLite**:`~/.sansheng/sessions/<conversationId>/bus.jsonl` append-only
- **keyring**:`~/.sansheng/keyring.enc` AES-256-GCM
- **harness**:`~/.sansheng/harness/{system_prompts,enabled_tools.json,policies}/`,M5+ 才有完整版本化
- **additive migration**:`artifacts_json` 默认 `'[]'`,旧 rows 读时从 `produced_artifacts_json` + `decisions_json` 升级(M3+)

### Artifacts 系统(M5+ 全量,M3+ 雏形)

- **6 种 kind**(v5 M5+):document / code / config / plan / dataset / report
- **M3+ 雏形**:`BlackboardArtifact` 用 10 种 kind(decision / harness_proposal / implementation_preview / intent / todo / note / evidence / critique / reflection / hypothesis)
- **全量快照**:任意时刻可恢复
- **衍生链**:`source_conv_id` + `source_run_id` + `source_role`;双向跳转
- **跨会话复用**:新对话提到"上周 X" → Memory 检索 + artifact 上下文拼进

### 守护调度

- **完整模式**(M7):cron + scanner + reflection + goals;**全部可被用户输入中断**
- **cronEngine**:`node-cron` + 持久化(SQLite);重启后恢复
- **scanner**:扫描用户配置目录(默认 `~/Documents`、`~/projects`),按 mtime/模式触发
- **reflection**:**按需**:每会话结束 + 事件触发 + 用户手动;每日/每周反思**默认关闭**,可在 Settings 启用
- **interruptionGate**:守护任务 `await interruptionGate.acquire()`;用户消息到来即让出锁

### Goal 与行动授权

- **Goal 状态机**:Draft → Active → Paused → Completed / Cancelled
- **行动授权**:每 goal 可绑 budget cap / risk ceiling;超限自动暂停

---

## M3+ Rebalance — Core Architecture

> 来源:本会话主对话维护(commit 链:`570467b` → `2f4cd48` → 待 `XXXXXXX` PLAN/HANDOFF/MEMORY 更新)

### Decisions (locked with user m00541 + m00634)

| ID | Decision | Rationale |
|----|----------|-----------|
| **D1** | Blackboard 双 scope:`global` + `conversation` | 有些 work IS per-conv;global 用于跨 conv intent |
| **D2** | Communicator = reactive input + plan producer + proactive observer | 用户 m00539:Communicator 是中心,不只 chat reply |
| **D3** | Execution trigger:`artifact.kind='intent' status='open'` | Artifact 自身编码 trigger |
| **D4** | 复用 M3c 基础设施 | Singleton, MessageBus, Live Trace — 正确,只升级语义 |
| **D5** | 其它 role 订阅全局 bb | 用户"记录到全局 blackboard" |
| **D6** | 保留 M3a chat UX 作 Communicator 输入面 | 不动前端 |
| **D7** | Structured output (LLM emits artifact array);fallback = single `note` | 比独立 classifier 时延低 |
| **D8** | Artifact 有 execution tracking:`executors[]`, `dependsOn[]`, `parentIntent?` | DAG ordering + agent 记住自己执行哪些 |
| **D9** | 阻塞回调 — Executor 暂停 → Communicator 决策 → emit decision artifact → resume | 用户 m00541:推理简单 + audit trail |
| **D10** | Observer 只在完成/异常时汇报(resolved/failed) | 用户 m00541:最少噪音 |
| **D11** | 每个 callback 产生 `decision` artifact | Audit trail;未来 agent 可见 |
| **D12** | 单用户本地;无 auth | 本地优先 |
| **D13** | Executor 可发第二种 callback:`harness_proposal` | 用户 m00632:executor 可能注意可复用工具 / CLI / 更好方案 |
| **D14** | Harness proposals = M6 reactive input | M6 有 proactive + reactive 双输入 |
| **D15** | Harness Manager v0 = 独立 agent,订阅 `harness_proposal` artifacts | 用户 m00634:架构最干净;v0 只 routing + preview,M6 apply + shadow test |

### The Four Flows

#### Flow A — User-initiated
```
user message → Communicator
  → produces BlackboardArtifacts (decision/hypothesis/intent/note)
  → write to global bb
  → if any artifact.kind='intent':
      - bus.publish('artifact_created', intent)
      - Orchestrator picks up → spawns Planner
  → chat reply: "已记录 N 条 artifact: [list]. 触发执行? [Y/N]"
```

#### Flow B — Communicator-initiated (Proactive Observer)
```
Communicator subscribes to bus events (no polling):
  - artifact.status changes to 'resolved' (todo completion)
  - artifact.status changes to 'failed'
  - intent.status changes to 'resolved'

  → Communicator LLM evaluates: "User needs to know? → Y" (D10)
  → emits a `note` artifact: "汇报: intent X 已完成, todos: [N+M, M+N]"
  → emits user chat message: "Hey, 完成啦!"
```

#### Flow C — Executor callback (D9 judgment)
```
Executor working on todo T encounters decision point:
  - emits hypothesis artifact (status='open', refs=[T, ...])
  - bus.publish('executor_callback', { executorSessionId, hypothesisId, reason='judgment' })
  - Executor blocks (status='waiting_for_decision')

Orchestrator routes callback to Communicator:
  - Communicator reads context: hypothesis + todo + parent intent + relevant refs
  - Communicator LLM decides: (a) autonomous decision OR (b) ask user
  - emits `decision` artifact (refs=[hypothesis, todo, intent])

Orchestrator routes resume:
  - Executor receives decision artifact in scope
  - continues work
```

#### Flow D — Executor harness proposal (D13)
```
Executor working on todo T notices:
  - reusable pattern emerging → could be a tool
  - missing tool → could build it
  - better approach → could refactor
  - CLI / policy / prompt improvement idea

  → Executor emits `hypothesis` artifact (kind=hypothesis_pre)
  → Executor fires callback with reason='harness_proposal'
  → Executor blocks

Orchestrator routes to Communicator:
  - Communicator evaluates proposal (LLM)
  - Communicator writes a `harness_proposal` artifact to bb:
      - body: markdown describing change
      - metadata: { category, riskLevel, evidenceCount, relatedArtifacts, estimatedEffort }
  - Communicator may ask user (high-risk) OR mark ready
  - bus.publish('artifact_created', haproposal)  ← Harness Manager picks up

Harness Manager (D15):
  - subscribes to artifact_created kind='harness_proposal' status='open'
  - For v0: produces `implementation_preview` artifact (markdown diff)
  - For v0: routes preview to user via note + Communicator
  - v0 does NOT write files — that's M6
```

### Data Model — `BlackboardArtifact` (v3)

```ts
// shared/types/blackboard.ts (new file)
export type BlackboardScope = 'global' | 'conversation';

export type ArtifactKind =
  | 'decision'                       // resolved decision
  | 'hypothesis'                     // open hypothesis (executor raised; needs resolution)
  | 'harness_proposal'               // D13: proposal to upgrade harness (routed to Harness Manager)
  | 'implementation_preview'         // D15: Harness Manager preview (no file writes in v0)
  | 'intent'                         // triggers Planner
  | 'todo'                           // DAG step within intent
  | 'note'                           // free-form knowledge (alignment memos, observer reports)
  | 'evidence'                       // observation from Executor
  | 'critique'                       // Critic's review of evidence batch
  | 'reflection';                    // Reflection session's summary

export type ArtifactStatus =
  | 'open'
  | 'in_progress'
  | 'waiting_for_decision'           // Executor paused on callback (D9/D13)
  | 'resolved'
  | 'superseded'
  | 'failed';

export interface BlackboardArtifact {
  id: string;
  scope: BlackboardScope;
  conversationId?: string;
  kind: ArtifactKind;
  title: string;
  body: string;
  refs?: string[];
  author: 'user' | 'communicator' | 'planner' | 'executor' | 'critic' | 'memory' | 'reflection' | 'harness_manager';
  status: ArtifactStatus;

  // D8: execution tracking
  executors?: string[];
  dependsOn?: string[];
  parentIntent?: string;

  // D13: structured metadata
  metadata?: {
    callbackReason?: 'judgment' | 'harness_proposal';
    category?: 'tool' | 'cli' | 'prompt' | 'policy' | 'red_line' | 'budget';
    riskLevel?: 'low' | 'medium' | 'high';
    estimatedEffort?: string;
    evidenceCount?: number;
    relatedArtifacts?: string[];
    filesToChange?: Array<{
      path: string;
      changeType: 'create' | 'modify' | 'delete';
      diffPreview?: string;
    }>;
    [k: string]: unknown;
  };

  createdAt: number;
  updatedAt: number;
}

export interface Blackboard {
  conversationId: string;            // '__global__' for global bb
  goal?: unknown;
  plan?: unknown;
  todos: unknown[];                  // legacy
  evidence: unknown[];
  critique?: unknown;
  artifacts: BlackboardArtifact[];
  artifactIndex: Record<string, number>;
}
```

**Storage migration**: additive only.
- `blackboards` table gets `artifacts_json` column(nullable)
- On read, if null → initialize from `produced_artifacts_json` + `decisions_json` (best-effort)
- Defaults to `'[]'` for new rows

**Global Blackboard**:`Blackboard` with `conversationId='__global__'`, `scope='global'`. Single instance.

---

## 项目结构

```
sansheng/
├── package.json
├── README.md
├── LICENSE
├── tsconfig.json
├── tsconfig.server.json
├── vite.config.ts                     # web 构建
├── vitest.config.ts
├── playwright.config.ts               # e2e 对 http://localhost:2718
├── docs/
│   ├── architecture.md
│   ├── agent-protocol.md              # Blackboard 协议
│   ├── blackboard-artifacts.md        # M3+ BlackboardArtifact 详细 spec
│   ├── executor-callback.md           # M3+ D9/D13 callback 机制
│   └── harness-manager.md             # M3+ D15 Harness Manager v0 spec
├── shared/                            # 跨 server + web 类型
│   ├── types/
│   │   ├── agents.ts                  # RoleId, BlackboardSnapshot, BusMessage
│   │   ├── blackboard.ts              # M3+ BlackboardArtifact (D8/D13)
│   │   ├── tools.ts                   # M4 tool registry types
│   │   └── bus.ts                     # bus events
│   ├── prompts/                       # M3b+ default system prompts
│   │   ├── communicator.md            # M3c + M3+ 升级 (D7 structured output)
│   │   ├── planner.md                 # M3b + M3+ intent → todos DAG
│   │   ├── executor.md                # M3b + M3+ callback 触发 (D9/D13)
│   │   ├── critic.md                  # M3b
│   │   ├── memory.md                  # M3b
│   │   ├── reflection.md              # M3b
│   │   └── harness_manager.md         # M3+ D15 (NEW)
│   └── log.ts
├── src/
│   ├── cli/
│   │   ├── index.ts
│   │   └── commands.ts                # start/stop/status/open/config/logs/dev
│   ├── server/
│   │   ├── index.ts                   # startServer(),init global bb (M3+)
│   │   ├── http.ts                    # Hono app + /api/chat/* + M3+ /api/blackboard/global + /api/artifacts/*
│   │   ├── ws.ts                      # WS broadcast + M3+ bus events
│   │   ├── settings/
│   │   │   └── store.ts
│   │   ├── providers/
│   │   │   ├── index.ts
│   │   │   └── cost.ts
│   │   ├── kernel/
│   │   │   ├── agentKernel.ts         # single-agent mode (M1) + multi-agent hooks (M3+)
│   │   │   ├── communicator.ts        # M3c singleton + M3+ 3 identities
│   │   │   ├── sessionPool.ts         # 角色 session 池
│   │   │   ├── eventStream.ts         # Pi events → WS
│   │   │   ├── toolRegistry.ts        # M3c
│   │   │   └── costTracker.ts
│   │   ├── agents/                    # 多 agent
│   │   │   ├── orchestrator.ts        # M3+ event-sourced refactor
│   │   │   ├── planner.ts             # M3+ NEW
│   │   │   ├── executor.ts            # M3+ NEW
│   │   │   ├── harnessManager.ts      # M3+ D15 NEW (v0 stub)
│   │   │   ├── interrupts.ts          # 中断 + CancelToken
│   │   │   └── triggers.ts            # mode routing (planned deprecation in v5)
│   │   ├── bus/                       # M3c MessageBus
│   │   │   ├── index.ts
│   │   │   ├── persist.ts
│   │   │   └── events.ts              # M3+ artifact_created / status_changed / executor_callback / resume / haproposal_created
│   │   ├── tools/
│   │   │   ├── fs/                    # M4 fs tools (3)
│   │   │   ├── http/                  # M4 http tools (2) + net sandbox
│   │   │   ├── browser/               # M5+
│   │   │   ├── shell/                 # M5+
│   │   │   ├── notify/                # M5+
│   │   │   ├── integration.ts         # M4 createToolRegistry
│   │   │   ├── registry.ts            # shared registry interface
│   │   │   └── netSandbox.ts          # shared sandbox policy
│   │   ├── storage/
│   │   │   ├── db.ts                  # SQLite + M3+ artifacts_json migration
│   │   │   ├── keyring.ts             # AES-256-GCM + chmod 0600
│   │   │   ├── embeddings.ts
│   │   │   ├── extractor.ts           # fragment extractor
│   │   │   └── repo/
│   │   │       ├── conversations.ts
│   │   │       ├── messages.ts
│   │   │       ├── fragments.ts
│   │   │       ├── blackboards.ts     # M3+ artifact CRUD + migration
│   │   │       └── agentStates.ts
│   │   ├── harness/
│   │   │   ├── loader.ts              # ensureHarness + loadHarness (M3b)
│   │   │   ├── proposer.ts            # M6 harness proposal generator (scaffolded M3+)
│   │   │   ├── riskClassifier.ts      # M6
│   │   │   ├── shadowRunner.ts        # M6
│   │   │   └── rollback.ts            # M6
│   │   ├── scheduler/                 # M7
│   │   │   ├── cron.ts
│   │   │   ├── scanner.ts
│   │   │   └── goals.ts
│   │   └── artifacts/                 # M5+ 全量
│   ├── daemon.ts                      # --daemon fork + PID
│   └── shared/                        # 通用工具
│       └── util/
├── web/                               # React + Tailwind SPA
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                    # 路由 + 9 页 nav (M3+ 加 Artifacts)
│       ├── routes/
│       │   ├── Chat.tsx
│       │   ├── Agents.tsx             # 多 agent 实时 + Blackboard
│       │   ├── Memory.tsx
│       │   ├── Goals.tsx
│       │   ├── Scheduler.tsx
│       │   ├── Artifacts.tsx          # artifact 浏览 / 预览 / 衍生链 (M5+ full; M3+ scaffold)
│       │   ├── Harness.tsx            # harness 文件 + 提议 + shadow 结果
│       │   ├── Profile.tsx            # 用户画像
│       │   └── Settings.tsx           # provider / budget / persona / 沙箱
│       ├── components/
│       │   ├── chat/                  # MessageList / Input / ToolCallCard / ThinkingBlock
│       │   ├── agents/                # AgentCard / BlackboardView / TraceTimeline (M3+ artifact cards)
│       │   ├── memory/
│       │   ├── shell/                 # HistoryRail / AgentPanel (M3+ artifact state) / Topbar
│       │   ├── artifacts/
│       │   └── harness/
│       ├── stores/
│       │   ├── chat.ts                # Zustand
│       │   ├── bus.ts                  # WS bus state
│       │   └── blackboard.ts          # M3+ NEW: artifact state
│       └── lib/
│           ├── api.ts
│           ├── ws.ts
│           └── design.ts              # 设计 tokens
├── tests/
│   ├── server/
│   │   ├── http/
│   │   │   ├── blackboard.test.ts
│   │   │   ├── artifacts.test.ts      # M3+ NEW
│   │   │   ├── executors.test.ts      # M3+ NEW
│   │   │   ├── tools.test.ts
│   │   │   └── chat.test.ts
│   │   ├── agents/
│   │   │   ├── orchestrator.test.ts   # M3+ event-sourced
│   │   │   ├── planner.test.ts        # M3+ NEW
│   │   │   ├── executor.test.ts       # M3+ NEW (judgment + haproposal)
│   │   │   ├── harnessManager.test.ts # M3+ NEW (v0 stub)
│   │   │   └── communicator.test.ts   # M3+ 3 identities
│   │   ├── tools/
│   │   │   ├── fs/
│   │   │   ├── http/
│   │   │   └── integration.test.ts
│   │   └── storage/
│   │       ├── db.test.ts
│   │       ├── blackboards.test.ts    # M3+ artifact migration
│   │       └── ...
│   └── e2e/                           # Playwright
│       ├── boot.spec.ts
│       ├── chat.spec.ts
│       ├── multi-agent.spec.ts        # M3+ 4 flows
│       ├── callback.spec.ts           # M3+ D9/D13
│       ├── observer.spec.ts           # M3+ D10
│       ├── harness.propose.spec.ts
│       └── harness.shadow.spec.ts
└── scripts/
```

---

## 行为与接口

### CLI
```
sansheng start [--port 2718] [--host 127.0.0.1] [--data ~/.sansheng] [--daemon]
sansheng stop
sansheng status                # PID / 当前地址 / provider / uptime
sansheng open                  # 浏览器打开 http://localhost:2718
sansheng config [key] [value]  # 数据目录、port、host 等
sansheng migrate --to <path>   # 路径迁移
sansheng reset                 # 二次确认后清空 ~/.sansheng
sansheng logs                  # tail ~/.sansheng/logs/sansheng.log
sansheng dev                   # vite dev + tsx watch
```

### REST + WebSocket(主要通道)
- `POST /api/chat` body `{content,opts}` → `{streamId}`;WS 推送 `MessageDelta | ToolCall | MessageDone | Error | NodeUpdate | Heartbeat`
- `GET /api/agents` / `POST /api/agents/interrupt`
- **M3+ 新增**:
  - `GET /api/blackboard/global` → `{ blackboard: { artifacts: BlackboardArtifact[] } }`
  - `GET /api/artifacts/:id` → `{ artifact: BlackboardArtifact }`
  - `GET /api/artifacts?scope=&kind=&status=&limit=` → `{ artifacts: BlackboardArtifact[] }`
  - `GET /api/executors/:id/state` → `{ status, currentArtifact?, waitingFor?: hypothesisId }`
- **M4 已加**:`GET /api/tools/list` / `POST /api/tools/invoke`
- **WS 新事件**(M3+):`artifact_created`, `artifact_status_changed`, `executor_callback`, `executor_resume`, `harness_proposal_created`

### Blackboard 协议(M3+ 重构)

详见 §"M3+ Rebalance — Data Model"。

**关键变化(v4 → v5)**:
- Blackboard 字段 `producedArtifacts[] / decisions[] / todos[] / evidence[]` **合并**到 `artifacts: BlackboardArtifact[]`(first-class)
- 新加 `scope`, `executors[]`, `dependsOn[]`, `parentIntent`, `metadata.{callbackReason, category, riskLevel, filesToChange}`
- 新增 `__global__` singleton
- `BlackboardArtifact.kind` 从 8 类扩到 10 类(+harness_proposal, +implementation_preview)

**总线事件**(v5):
- `artifact_created` → 全局 + per-conv
- `artifact_status_changed` → status 变化
- `executor_callback` → Executor 阻塞请求决策
- `executor_resume` → Communicator 决策后 Executor 恢复
- `harness_proposal_created` → Harness Manager 订阅

### Orchestrator 循环(M3+ 重构)

**v4 模式**(per-conversation 同步循环):
```
memory → planner → executors (parallel) → critic → reflection → persist
每条用户消息触发
```

**v5 模式**(event-sourced service):
```ts
class Orchestrator {
  // 订阅全局 bb
  onArtifactCreated(artifact: BlackboardArtifact) {
    if (artifact.kind === 'intent' && artifact.status === 'open') {
      this.spawnPlanner(artifact);
    }
    // Harness Manager 订阅 haproposal (separate)
  }

  // Planner 返回 → spawn Executors (DAG-aware parallel/sequential)
  onPlannerProducedTodos(intent: BlackboardArtifact, todos: BlackboardArtifact[]) {
    for (const todo of todos) {
      if (todo.dependsOn.every(dep => dep.status === 'resolved')) {
        this.spawnExecutor(todo);
      }
    }
    // watch deps changes; when satisfied → spawn
  }

  // Executor 阻塞
  onExecutorCallback(executor: ExecutorSession, hypothesis: BlackboardArtifact) {
    // route to Communicator via bus
    bus.publish('executor_callback', { ... });
    // mark executor.status = 'waiting_for_decision'
  }

  // Communicator 决策
  onDecisionEmitted(decision: BlackboardArtifact) {
    // route to waiting executor
    const executor = this.waitingExecutors.get(decision.refs[0]);
    executor.resume(decision);
  }

  // watchdog
  startWatchdog() {
    setInterval(() => {
      for (const [exec, hypothesis] of this.waitingExecutors) {
        if (Date.now() - hypothesis.createdAt > 5 * 60_000) {
          this.escalate(exec, hypothesis);  // user notification
        }
        if (Date.now() - hypothesis.createdAt > 60 * 60_000) {
          this.markFailed(exec, hypothesis);
        }
      }
    }, 30_000);
  }
}
```

**最大 callback depth**:3 层,超过升级用户

### Communicator 与 MessageBus 协议(M3+ 升级)

**v4**:Communicator 是 chat reply agent,接 user message,返 chat reply

**v5**(3 重身份):

**输入面**:
1. **reactive input** — user messages
2. **executor callback** — bus events `executor_callback` (reason=judgment 或 harness_proposal)
3. **bb event observer** — 订阅 `artifact_status_changed` 当 status ∈ {resolved, failed}

**输出面**:
1. **user reply** — chat message
3. **bb artifact** — BlackboardArtifact(decision / hypothesis / intent / note / harness_proposal)
4. **executor decision** — 通过 `executor_resume` event + `decision` artifact 携带

**Communicator System Prompt** (M3+ 强化):
```markdown
# Communicator (M3+ v5)

你是 Sansheng 与用户和 worker 的**唯一接口**。

## 三重身份

1. **Plan Producer**(每次对话):把用户消息转为 BlackboardArtifact 数组
2. **Reactive Input**(用户消息或 executor 回调):上下文对齐,产出 artifacts 或 user reply
3. **Proactive Observer**(bus 订阅):bb 事件 → 决定是否汇报用户(D10:仅 resolved/failed)

## Structured Output (D7)

每次响应必须产出 JSON:
```json
{
  "userReply": "string (markdown,可选)",
  "artifacts": [
    {
      "id": "uuid",
      "scope": "global" | "conversation",
      "kind": "decision" | "hypothesis" | "intent" | "note" | "harness_proposal",
      "title": "one line",
      "body": "markdown body",
      "refs": ["artifact_id_or_path", ...],
      "metadata": { ... }
    }
  ]
}
```

`userReply` 和 `artifacts` 都可为空(若双方都是空 → 解释为什么不产出)

## Intent 验证

`kind='intent'` 必须满足:
- body 非空 + 含 imperative verb(refs 也可作为辅助)
- 若不满足 → 降级 `hypothesis`(D7 + §Defaults)

## Harness Proposal 风险分类

`kind='harness_proposal'`:
- `category`: tool / cli / prompt / policy / red_line / budget
- `riskLevel`: low / medium / high
- low → 直接路由 Harness Manager
- medium → user chat 通知
- high → user 必须显式 confirm

## Observer 触发(D10)

仅汇报:
- artifact.status ∈ {resolved} (intent 或 todo 完成)
- artifact.status = failed

其它状态变更(in_progress, waiting_for_decision)→ 仅 bb 内部状态,不打扰用户
```

**MessageBus 接口**(v5 不变主体,加新事件):
```ts
type BusDirection = "user→comm" | "comm→worker" | "worker→comm" | "comm→user";
type BusKind = "question" | "broadcast" | "reply";

// M3+ 加 event payload 类型
interface ArtifactCreatedEvent {
  type: 'artifact_created';
  artifact: BlackboardArtifact;
}
interface ArtifactStatusChangedEvent {
  type: 'artifact_status_changed';
  artifactId: string;
  oldStatus: ArtifactStatus;
  newStatus: ArtifactStatus;
}
interface ExecutorCallbackEvent {
  type: 'executor_callback';
  executorSessionId: string;
  hypothesisId: string;
  reason: 'judgment' | 'harness_proposal';
}
interface ExecutorResumeEvent {
  type: 'executor_resume';
  executorSessionId: string;
  decisionArtifactId: string;
}
interface HarnessProposalCreatedEvent {
  type: 'harness_proposal_created';
  artifact: BlackboardArtifact;
}
```

### Harness 系统

**v4 不变** + M3+ 加双入口:
- Reflection 主动提议(v4 path)
- **Executor 实战提议(D13)** ← M3+ 新

**v0 Harness Manager**(D15):
- 订阅 `artifact_created kind='harness_proposal' status='open'`
- 读 proposal + context
- 产出 `implementation_preview` artifact(markdown diff + filesToChange[])
- 通过 Communicator 通知用户
- **v0 不写文件**

**M6 真应用**(独立 plan):
- 自动 apply(低风险)or 用户审批(中/高风险)
- 影子测试 + rollback

---

## 测试与验收

### 单元测试(vitest)

**基础(已实现)**:
- CLI:参数解析、`--daemon` fork、PID 清理
- HTTP/Server:REST 路由契约、WS 事件 schema
- blackboard:读写隔离、并发更新、序列化
- orchestrator:mock 角色、循环收敛、异常路径、CancelToken
- triggers(计划废弃于 v5)
- interrupts:用户消息 ≤1 tick 内让步
- memory:迁移、事务、向量 k-NN、衰减、冲突
- fs/http sandbox:越权必抛、符号链接阻断
- costTracker:token → USD、月度预算

**M3+ 新加**:
- **artifacts**:全 10 kind round-trip;status transitions;DAG cycle 拒绝;migration from old schema
- **global bb**:singleton 行为;scope 过滤
- **callback dispatch**:**实现** judgment + harness_proposal;watchdog 5min/1hr
- **observer**:resolved/failed → user message;in_progress → NOT user message
- **structured output parse fallback**:malformed JSON → single `note`
- **Harness Manager v0**:subscribes;produces preview;**verifies NO file writes**
- **migration**:现有 rows 升级到 artifacts_json

### 集成 / E2E(Playwright)

**基础(已实现)**:
- boot / chat / multi-agent

**M3+ 新加**:
- `multi-agent-v5.spec.ts` — 4 flows
- `callback-judgment.spec.ts` — Executor → Communicator → decision
- `callback-haproposal.spec.ts` — Executor → Communicator → Harness Manager preview
- `observer.spec.ts` — D10 触发验证
- `artifact-cards.spec.ts` — Live Trace 渲染所有 10 kind

### 验收标准(M3+ 完成后)

1. `npm run typecheck` 0 errors
2. `npm test` ≥130 pass(81 + 49+ 来自 B1-B7)
3. `npm run build` 成功
4. `sansheng start --daemon -p 2718` + curl 8 个 manual tests 全过:
   - Test 1:alignment only → no Executor activity
   - Test 2:execution path → observer fires user message on completion
   - Test 3:judgment callback → Executor pauses → Communicator decides → resume
   - Test 4:haproposal callback → Harness Manager produces preview → NO files written
   - Test 5:observer report → note artifact present
   - Test 6:global bb state → ≥8 artifacts
   - Test 7:per-conv bb still works
   - Test 8:Harness Manager v0 did NOT write files
5. M4 工具 smoke:`/api/tools/invoke` 仍通过

---

## 实施顺序(里程碑)

```
M0 ✓ 骨架 — package / tsconfig / Hono / vite / 设计 tokens / CLI
M1 ✓ Kernel + 单 agent 对话
M2 ✓ 持久化 + 记忆
M3 ✓ 多 agent 基础(M3a/b/c)
M4 ✓ 行动工具(fs + http + net sandbox + registry)

[M3+ Rebalance — current focus]
  - Step 1(主会话):更新 PLAN.md(本文件)/ HANDOFF.md / MEMORY.md
  - Step 2(用户 review):等用户签收文档
  - Step 3(worker B1+B2 parallel):数据模型 + storage migration + HTTP endpoints
  - Step 4(worker B3+B4 parallel):Communicator 升级 + bus events + Live Trace 渲染
  - Step 5(worker B5+B6+B7 parallel):Orchestrator 重构 + Planner + Executor + Harness Manager v0 + Live Trace cards
  - Step 6(用户验证):跑 §验收标准 8 个 manual tests

M5 ◐ 部分(批次 4b C12 更正:旧行写「M5 ✓」失实)—— 已实现:Executor(完整)、Memory(fragments + embeddings + 回合后沉淀);**未实现**:Critic、Reflection 的完整形态(现只有沉淀产出的 `[reflection]` context fragment)、全量 Artifacts UI(只有 Timeline 的简化渲染)
M6(scaffolded in M3+ v0 stub,full in 后续 plan)Harness 自优真应用:proposer / riskClassifier / shadowRunner / rollback
M7 守护调度 + Goals + Scheduler UI
M8 失败兜底 + 状态报告 + 进度报告
M9 打磨 + 测试 + 发布
```

---

## 明确假设与默认值

- **机器人显示名** = 「三生」;Settings 中可改
- **UI 语言** = 中文 only;agent 回复中英文混合正常
- **默认绑定** = `127.0.0.1:2718`;`--host 0.0.0.0` 由用户显式启用
- **数据目录** = `~/.sansheng/`,可用 `sansheng config data <path>` 改
- **embedding** = 默认复用 chat provider 的 embedding 模型;Settings 可独立指定
- **隐私** = 不收集遥测,无网络上报(除 LLM API 调用)
- **沙箱默认拒绝** = 文件根 / HTTP 域名 / shell 命令均需显式 allow
- **平台支持** = Linux + macOS + Windows(Node 20+)均可运行
- **首版暂不做** = 鉴权 / auto-update / 代码签名公证 / 语音输入输出 / 多用户 / 云同步
- **Harness 优化提案** = 默认 `auto-apply` 仅低风险且 shadow test 通过;M3+ v0 Harness Manager 不写文件
- **历史会话用于影子测试** = 首次启用弹明确同意;用户可随时关闭
- **M3+ Defaults**(PLAN_new §5):
  - Intent 验证:imperative verb OR non-empty refs;else → hypothesis
  - Callback trigger:Executor LLM 判 irreversible/ambiguous → judgment;reusable/missing/better → haproposal
  - Observer 触发:仅 resolved/failed(D10)
  - Harness Manager v0:read-only,emit implementation_preview
  - Harness risk 分类:LLM 自动分 low/medium/high;Communicator 路由
  - Global bb cleanup:暂不做(M5+)
  - Live Trace 颜色:decision=blue,hypothesis=amber,harness_proposal=gold,implementation_preview=cyan-gold,todo=gray,evidence=cyan,critique=pink,reflection=violet,note=neutral,intent=green;waiting_for_decision 脉动

---

## 关键风险与对应

| 风险 | 缓解 |
|---|---|
| Harness 自我修改引入 bug | 影子测试 + 风险分级 + 全量版本可回滚 + 中/高风险必须审批 |
| Sansheng 在 destructive 操作中失控 | L4 自动暂停 + 用户 kill switch + interruptionGate |
| 离线后 token 预算超支 | 月度预算硬限,超额自动暂停新任务 |
| 浏览器/网络工具失败 | 工具错误内联呈现 + 自动重试 + 不影响主对话 |
| 子 session 磁盘增长 | 整次 conversation 归档时压缩 JSONL |
| Harness 修改偏离雇主偏好 | Shadow test 包含用户反馈分;偏好维度可在提议中显式影响 |
| **M3+ 新** | |
| Communicator 误分类(note 当 intent) | Intent 验证;else → hypothesis |
| Executor callback 死循环 | Max depth 3;超 → escalate user |
| Observer 噪音 | D10:仅 resolved/failed |
| Harness Manager v0 误写文件 | v0 代码**无** file-writing path;tests verify no FS mutation |
| Harness Manager v0 preview 不准 | preview 是 markdown;no auto-apply |
| Global bb 无限增长 | cleanup() for resolved/superseded > 30d(M5+) |
| Per-conv vs global 混淆 | 独立 endpoints;UI scope badge |
| Structured output parse 失败 | fallback → single `note` |
| DB migration 破坏 | additive only;`artifacts_json` nullable |
| Planner v1 太简 | LLM w/ structured output;iterate |
| waiting_for_decision leak | Watchdog 5min→escalate;1hr→failed |