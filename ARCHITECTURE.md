# Sansheng · 系统功能模块图

**生成时间**: 2026-10-01
**版本**: v1.0
**布局**: 自顶向下,严格层次化,所有箭头单向向下 → **无交叉**

---

## 模块层次(自上而下)

| 层 | 名称 | 职责 |
|---|---|---|
| 0 | Foundational | shared/types · shared/prompts · shared/log |
| 1 | User | 外部使用者 |
| 2 | Web Frontend | React 应用 + 路由 + 组件 + Stores |
| 3 | CLI | commands · start/stop/status/logs/reset |
| 4 | Server Bootstrap | startServer + 守护进程 |
| 5 | Transport | HTTP · WS · artifact 路由 |
| 6 | Agent Kernel | Session 管理 + ServerEvent 派发 |
| 7 | Multi-Agent Coordination | Communicator · Orchestrator · Harness Manager |
| 8 | Worker Agents | Planner · Executor |
| 9 | Bus Infrastructure | artifactBus · MessageBus · BusPersister |
| 10 | Core Infrastructure | Storage · Settings · Providers · Harness Loader · Tools |
| 11 | External Stores | SQLite · Keyring · Settings JSON · Harness Dir · Migrations SQL |

---

## 功能模块图(Mermaid)

```mermaid
flowchart TB
    %% ============================================================
    %% Sansheng 系统功能模块图
    %% 单用户本地 Node 服务 · 2026-10-01
    %% 严格自顶向下,所有箭头单向向下 → 无交叉
    %% ============================================================

    %% ---- Layer 0: Foundational Library ----
    subgraph L0 ["📚 Layer 0 · Foundational (imported by all below)"]
        direction LR
        Types["shared/types/*<br/>blackboard · bus · ws<br/>chat · agents · settings<br/>harness · artifacts · goals"]
        Prompts["shared/prompts/*<br/>communicator · planner<br/>executor · harness_manager"]
        Log["shared/log.ts<br/>ok/warn/error/muted"]
    end

    %% ---- Layer 1: External ----
    User(["👤 Layer 1 · User<br/>(外部使用者)"])

    %% ---- Layer 2: Web Frontend ----
    subgraph L2 ["🌐 Layer 2 · Web Frontend (web/src)"]
        direction TB
        App["App.tsx<br/>路由 + RuntimeConfig"]
        Components["components/*<br/>chat · shell · settings · brand"]
        Stores["stores/*<br/>chat.ts · settings.ts"]
        LibWS["lib/ws.ts<br/>WebSocket 客户端"]
    end

    %% ---- Layer 3: CLI ----
    subgraph L3 ["⌨ Layer 3 · CLI (src/cli)"]
        direction TB
        CmdIdx["index.ts<br/>CLI entry"]
        Cmds["commands.ts<br/>start · stop · status · logs · reset"]
    end

    %% ---- Layer 4: Server Bootstrap ----
    subgraph L4 ["🚀 Layer 4 · Server Bootstrap"]
        direction TB
        Entry["src/server/index.ts<br/>startServer · SIGTERM 守护"]
    end

    %% ---- Layer 5: Transport ----
    subgraph L5 ["📡 Layer 5 · Transport"]
        direction TB
        HTTP["http.ts<br/>Hono app<br/>健康 · 设置 · 会话 · 黑板 · 工件 · 工具"]
        HTTPRoutes["http/blackboardRoutes.ts<br/>B1 artifact 路由"]
        WS["ws.ts<br/>WebSocket Bridge<br/>send · load · plan · bus_replay"]
    end

    %% ---- Layer 6: Agent Kernel ----
    subgraph L6 ["🧠 Layer 6 · Agent Kernel"]
        direction TB
        AK["kernel/agentKernel.ts<br/>Session 生命周期<br/>+ ServerEvent 派发<br/>+ Bus 转发"]
    end

    %% ---- Layer 7: Multi-Agent Coordination ----
    subgraph L7 ["🤖 Layer 7 · Multi-Agent Coordination (src/server/agents)"]
        direction TB
        Comm["Communicator<br/>三重身份:<br/>reactive · producer · observer"]
        Orch["Orchestrator<br/>event-sourced 主循环<br/>+ DAG 调度 + Watchdog"]
        HMgr["Harness Manager<br/>v0 read-only<br/>订阅 harness_proposal"]
    end

    %% ---- Layer 8: Worker Agents ----
    subgraph L8 ["⚙ Layer 8 · Worker Agents"]
        direction TB
        Planner["Planner<br/>JSON todo 协议<br/>+ DFS cycle detection"]
        Executor["Executor<br/>4 outcome paths:<br/>evidence · judgment · failed"]
    end

    %% ---- Layer 9: Bus Infrastructure ----
    subgraph L9 ["📨 Layer 9 · Bus Infrastructure"]
        direction TB
        AB["bus/index.ts<br/>artifactBus<br/>(typed pub/sub)"]
        BE["bus/events.ts<br/>5 事件:<br/>artifact_created / _status_changed<br/>executor_callback / _resume<br/>harness_proposal_created"]
        MB["agents/messageBus.ts<br/>ask/reply + broadcast<br/>(worker ↔ Communicator)"]
        BP["agents/busPersister.ts<br/>jsonl 审计落盘"]
    end

    %% ---- Layer 10: Core Infrastructure ----
    subgraph L10 ["💾 Layer 10 · Core Infrastructure"]
        direction TB
        Storage["storage/*<br/>DB · Keyring · Embeddings<br/>Extractor · Migrations<br/>6 repos:<br/>agentStates · blackboards<br/>conversations · fragments<br/>messages · profile"]
        Settings["settings/store.ts<br/>Provider Config<br/>+ Encrypted API Keys"]
        Providers["providers/*<br/>registry.ts (model 解析)<br/>cost.ts (token 估算)"]
        Loader["harness/loader.ts<br/>加载 system_prompts/*.md<br/>+ DEFAULT_PROMPTS fallback"]
        Tools["tools/*<br/>integration · registry<br/>fs · http<br/>sandbox · netSandbox"]
    end

    %% ---- Layer 11: External Stores ----
    subgraph L11 ["📁 Layer 11 · External Stores"]
        direction TB
        SQLite[("SQLite DB<br/>~/.sansheng/sansheng.db<br/>7 张表")]
        KeyringFile[("Keyring File<br/>~/.sansheng/.keyring<br/>AES-GCM 0600")]
        SettingsFile[("Settings JSON<br/>~/.sansheng/settings.json")]
        HarnessDir[("Harness Dir<br/>~/.sansheng/harness/<br/>system_prompts/*.md")]
        SQLFiles["migrations/<br/>001_initial<br/>002_vec<br/>003_agent_states<br/>004_blackboards<br/>005_blackboard_artifacts"]
    end

    %% ═══════════════════════════════════════════════════════════
    %% EDGES — 严格自顶向下,每个箭头只从上层指向下层
    %% 设计原则:同一父节点的多个子目标按"目标所在层 × 层内位置"有序排列
    %% ═══════════════════════════════════════════════════════════

    %% User → Frontend
    User --> App

    %% Frontend 内部
    App --> Components
    App --> Stores
    App --> LibWS

    %% Frontend → Transport
    Components --> HTTP
    LibWS --> WS

    %% CLI 内部
    CmdIdx --> Cmds
    Cmds --> Entry

    %% Bootstrap → Transport + Kernel
    Entry --> HTTP
    Entry --> WS
    Entry --> AK

    %% Transport 内部 + Transport → Kernel + Transport → Storage + Tools
    HTTP --> HTTPRoutes
    HTTP --> AK
    HTTP --> Storage
    HTTP --> Tools
    HTTPRoutes --> Storage
    WS --> AK
    WS --> Storage
    WS --> Orch
    WS --> AB

    %% Kernel → Coordination + Bus + Core Infra
    AK --> Comm
    AK --> Orch
    AK --> MB
    AK --> BP
    AK --> Settings
    AK --> Providers
    AK --> Loader
    AK --> Storage

    %% Coordination → Worker + Bus + Core Infra
    Orch --> Planner
    Orch --> Executor
    Orch --> AB
    Orch --> Storage
    Comm --> AB
    Comm --> Providers
    Comm --> Loader
    HMgr --> AB

    %% Worker → Bus + Core Infra
    Planner --> AB
    Executor --> AB
    Executor --> Storage
    Executor --> Loader

    %% Bus 内部 + Bus → Core Infra
    AB --> BE
    BP --> Storage

    %% Core Infra → External Stores
    Settings --> SettingsFile
    Storage --> SQLite
    Storage --> KeyringFile
    Storage --> SQLFiles
    Loader --> HarnessDir
```

---

## 模块依赖矩阵(快速参考)

| 模块 | 直接依赖 |
|---|---|
| **App.tsx** | Components, Stores, LibWS |
| **Components/chat** | (UI 纯组件) |
| **Components/shell** | (UI 纯组件) |
| **lib/ws.ts** | (浏览器 WS) |
| **stores/chat.ts** | (Zustand state) |
| **stores/settings.ts** | (Zustand state) |
| **CLI commands** | server/index (startServer), SettingsStore, Keyring, Storage |
| **http.ts** | Hono, settings, kernel(type), storage, tools(integration), blackboardRoutes |
| **http/blackboardRoutes** | storage |
| **ws.ts** | kernel, settings, storage, orchestrator, bus |
| **agentKernel** | settings, providers, storage, messageBus, communicator, harness/loader, busPersister |
| **Communicator** | artifactBus, messageBus, providers, harness/loader, runner |
| **Orchestrator** | artifactBus, storage, planner, executor |
| **Harness Manager** | artifactBus |
| **Planner** | artifactBus |
| **Executor** | artifactBus, storage, harness/loader |
| **Bus Persister** | storage |
| **Storage** | DB, Keyring, Embeddings, Extractor, Migrations, 6 repos |
| **Settings** | Keyring (encryption) |
| **Tools/integration** | registry, sandbox, netSandbox, fs, http |

---

## 关键数据流

### Flow A · 用户消息处理

```
User → App.tsx → ChatSurface
        ↓ WS send
WS → agentKernel.handleSend
        ↓
AgentKernel.resolveActiveModel + createAgentSession
        ↓
Pi Session 内部 LLM 流 → ServerEvent 流
        ↓
WS 广播 → ChatSurface 渲染
        ↓ (extractor)
Storage.insertFragment + embedText → SQLite + vec
```

### Flow B · 多 Agent 协作

```
User 发送 "plan xxx" → ws.ts handlePlan
        ↓
ws.ts 新建 Orchestrator → artifactBus.publish("artifact_created", intent)
        ↓
Orchestrator.run → 订阅 bus → spawn Planner
        ↓
Planner 产 todo → Orchestrator 按 DAG 调度 Executor
        ↓
Executor 阻塞回调 → bus.executor_callback → Communicator 决策
        ↓
Communicator emit decision artifact → bus.executor_resume → Executor 继续
        ↓
全部 todo resolved → intent resolved → Communicator observer 触发 user 通知
```

### Flow C · 工具调用(M4)

```
Agent 决定调工具 → tools/integration.createToolRegistry
        ↓
ToolRegistry.get(name) → 沙箱 + net policy 校验
        ↓
fn(args) → Sandbox.fs / Sandbox.net
        ↓
返回 result → Agent 继续
```

---

## 渲染建议

- **GitHub / GitLab**:直接粘贴 Mermaid 块即可渲染
- **本地**: `npx -p @mermaid-js/mermaid-cli mmdc -i ARCHITECTURE.md -o arch.pdf`
- **VS Code**:安装 "Markdown Preview Mermaid Support" 扩展