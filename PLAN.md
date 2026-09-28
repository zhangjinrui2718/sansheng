# Sansheng · 三生机器人 · 实施计划 (v3 · npm + 浏览器访问 + Harness 自我优化)

## 摘要

在空仓库 `/root/projects/sansheng` 中,从零搭建一个**单用户、本机常驻的 Node 服务**:通过 `@earendil-works/pi-coding-agent` SDK 驱动一个**多 agent + Blackboard** 体系(Planner / Executor / Critic / Memory / Reflection),共享一个**SQLite + 向量编码** 的持久化层,具备**文件 / HTTP / 浏览器** 三类行动能力,以**数字雇员**的定位对外服务 —— token 即工资,产出即工件。

Sansheng **通过持续优化自己的 harness**(system prompts / 工具集 / 路由策略 / 红线 / budget / plan templates / context 管理 / memory 阈值)来越来越好地完成用户任务。所有 harness 改动走**影子测试**验证,低风险自动应用,中高风险需用户审批。harness 文件本身是 harness 特殊的 **artifact**,享受全量快照 / 版本 / 回滚。

以 **npm 包**形式分发,启动后默认监听 `http://localhost:2718`,用户从任意浏览器访问即可使用。

> 默认显示名「三生」;在 Web Settings 中可改。

## 关键架构决策(完整版)

### 形态与分发
| 维度 | 决策 |
|---|---|
| 分发 | **npm 包**:`npm i -g sansheng` 或 `npx sansheng`;不打包原生安装程序 |
| 运行时 | **纯 Node.js 进程**(Hono HTTP + WebSocket 服务) |
| 访问入口 | **`http://localhost:2718`**;默认 host `127.0.0.1`,可 `--host 0.0.0.0` 暴露到 LAN |
| 鉴权 | v1 单机单用户,**不设鉴权**;LAN 暴露仅文档提示风险 |
| CLI | `--daemon` v1 必备 · `start/stop/status/logs` · PID 文件 · Node `spawn detached` |
| 开机自启 | **不内置**,文档提供 systemd / launchd / Windows 任务计划模板 |

### Web 视觉
| 维度 | 决策 |
|---|---|
| 布局 | **三栏 A**:会话历史(左)· 对话流(中)· Blackboard + Agent 状态 + Trace(右);小屏右侧折叠为 tab |
| 视觉 | **水墨青玄**:深墨底 + 浅米白 + 青玄主色 + 赭 + 朱砂(仅 destructive) |
| 字体 | Inter / Söhne 主文,中文走思源宋体点缀,等宽 JetBrains Mono |
| 节奏 | 8px 网格,圆角 6–10px,低对比阴影,120–200ms ease-out 动效 |
| 文案 | **中文 only**,不引入 i18n 框架;agent 回复中英文混合正常 |
| a11y | **不做**(单用户本机) |

### 认知与多 agent
| 维度 | 决策 |
|---|---|
| 模型 | **多 agent · Blackboard** · Planner / Executor / Critic / Memory / Reflection · 独立 Pi session + 共享 Blackboard |
| 触发 | **默认 Quick(单 agent 直答)**;`/plan` 触发多 agent;`/multi on/off` 切换本会话默认模式;Settings 默认模式可选 `auto` / `quick` / `plan` / `multi-on` |
| Plan confirm | **复杂才确认**:涉及副作用(改 fs / 外发 / 超 token 阈值)的 plan 才预览;纯对话 plan 直接跑 |
| Destructive confirm | **始终确认**,不受 plan confirm 策略影响 |
| 启发式 | 默认 `quick` 模式不启用;用户选 `auto` 才启发式判断 |
| 代理权 | **④ Plan + 关键点 confirm**:Planner 出方案 → 老板 sign-off → Executor 自己跑;仅破坏性 confirm |

### Sansheng 的"灵魂"—— 数字雇员
| 维度 | 决策 |
|---|---|
| 定位 | **数字雇员** · token = 工资 · 工作 = 产出 · 不做 persona/语气/人设 |
| 用户模型 | **B 半隐式**:Sansheng 推断为主 · Settings「我的画像」可看 · 偶尔小气泡"我觉得你是 X,对吗?"· 维度:技术栈 / 工作节奏 / 沟通风格 / 目标重点 / 硬偏好 / 性格特征 |
| 用户画像存储 | `user_profile(key, value JSON, source, confidence, updated_at, source_ref)`;冲突优先级 `explicit > observed > inferred` |
| 学习机制 | **会话结束自动入库** · **静默** · 冲突弹用户裁决 · `explicit > observed > inferred + 衰减` · 显式通道:`记住:…` / `忘记 X` / 👍👎 / 编辑画像 |
| 进度报告 | **Hybrid**:节点汇报 + 30s 心跳 + 2min 卡住自动暂停 · **默认折叠,展开可看** · 顶部状态条 + Blackboard 永远可见 |
| 状态控制 | `/verbose` / `/quiet` / `/silent` + Settings 四档 |
| 失败响应 | **L1-L4 分级**:L1 重试 / L2 内联认错+修复 / L3 红色中断+等待 / L4 自动暂停+求助 |
| 防护层 | **L0 沙箱** + **L1 死循环检测**(同工具 ≥3 次) + **L2 Token/时间预算**(硬限可配) + **L3 计划预览** + **L4 红线** |
| 红线 | **默认无 + 推荐提示**:出错后 Sansheng 提议"要不要加红线?";用户确认后写入 user_profile |
| 事故回顾 | **只 L3/L4 报**:严重事故立即出"事后分析";L1/L2 落 `incidents` 表不主动报 |

### Harness 自我优化(核心差异化)
| 维度 | 决策 |
|---|---|
| 范围 | **全 harness**:system prompts / tools / routing / 红线 / budget / plan templates / context 管理 / memory 阈值 |
| 自治 | **影子测试通过可自动**:低风险(提示词/模板/context/memory 阈值/routing)通过即自动应用;中风险(工具/重试/budget)通过后仍需用户审批;高风险(红线/沙箱/安全)必须用户审批 + shadow 测试 |
| 风险分类 | Sansheng 提议时自带 category 字段;用户可改其分类 |
| 存储 | **复用 artifact 系统**:harness 文件 = 特殊 artifact(kind=`harness`)· 全量快照 / 版本 / 回滚 / diff 视图 |
| 提议队列 | `~/.sansheng/harness/proposals/{pending,applied,rejected}/` |
| UI | **Harness 页**:文件树 + 编辑器 + 版本 diff + 提议队列 + 影子测试结果 |
| Shadow test 输入 | **复用历史会话**(用户同意后,挑选典型 5-10 个 case) |
| Shadow test 指标 | **全面均衡**:token 用量 + 步骤数 + 错误率 + 用户反馈分,加权评分;新 harness 须所有维度 ≥ 旧版且综合分提升 |
| Shadow test 同意 | 首次启用弹"允许 Sansheng 读取历史会话作为测试输入?"可关闭 |

### LLM 与重试
| 维度 | 决策 |
|---|---|
| Provider | **可插拔单 provider 云 API**(Anthropic / OpenAI / OpenAI 兼容);**无 fallback** |
| Token 经济 | **中级**:消息/会话/日/周聚合 + 月度预算 + 超额提醒 + Settings 成本 dashboard |
| 重试 | **保守 3/4 次**:网络/超时重试 3 次(1s/3s/10s);429 重试 4 次(1s/5s/15s/30s,jitter);总成本 ≤30s |
| 5xx | 不切 provider,持续失败 → 错误卡片 + "在 Settings 切换 provider 后重试"按钮 |
| 401/403 | 不重试,弹"API key 无效" + 跳转 Settings |
| 413 | 触发自动 compact 再试,仍过长提示"对话太长" |
| 流式中断 | 保留 partial response,显示"连接中断"角标,自动重连 |

### 行动能力(沙箱默认拒绝)
| 工具 | 能力 | 沙箱 |
|---|---|---|
| **fs** | read / write / edit / grep / list | 路径必须在用户配置的根目录;越权导出 |
| **http** | fetch 包装 | 域名 allowlist + 每分钟限流 + body ≤5MB + 默认 HTTPS only |
| **browser** | Playwright/CDP 单实例 · navigate / snapshot / click / fill / screenshot / extract | 受 session/host 限制 |
| **shell** | 受限 shell | 命令白名单 + 危险 token 黑名单(`rm -rf /`、`mkfs`、`shutdown`);任何写/删先 confirm |
| **notify** | `node-notifier` | OS toast + WS 推送 |

### 持久化与存储
| 维度 | 决策 |
|---|---|
| 数据目录 | `~/.sansheng/`(可 `--data` 覆盖) |
| DB | **SQLite(better-sqlite3)+ sqlite-vec 向量编码** |
| 路径迁移 | `sansheng migrate --to <new-path>` 工具 + 文档化 cp 步骤 |
| Schema 迁移 | `migrations/*.sql` 编号 + `schema_version` 锁;启动不匹配阻塞;**强制仅追加 / 向后兼容** |
| API key | **AES-256-GCM 加密 SQLite**;master key 随机生成 → `~/.sansheng/.keyring` chmod 0600 |
| 子 session 持久化 | **完整事件流 JSONL**:每个角色 session 的 message_update / tool_call / thinking 全部落 `~/.sansheng/sessions/<conv_id>/<role>/<run_id>.jsonl` |
| 子 session 生命周期 | **同会话复用**:同一对话内角色 session 跨轮复用,新会话新建 |
| 导出 | **不实现** v1;用户自行 `tar czf` |
| 清空 | `sansheng reset` 命令 + 二次确认;Settings 按钮 |

### Artifacts 系统
| 维度 | 决策 |
|---|---|
| 物理位置 | `~/.sansheng/artifacts/<artifact_id>/` 自管独立目录 |
| Kind | **6 种基础** + `harness` 特殊 kind:`doc` / `code` / `project` / `data` / `diagram` / `file` / `harness` |
| 自动产出 | fs write/edit、browser download/screenshot/extract、shell init、http 大体量收藏 |
| 手动产出 | `registerArtifact` 工具 |
| 版本 | **全量快照**:每次 write/edit 快照到 `<id>/.history/<timestamp>/`;主体是最新版;`.history` 可回滚 |
| 命名 | 工具调用时 agent 传入 `title`;fallback 文件名 → `Untitled-<shortid>` |
| 编辑方式 | v1 仅支持通过对话让机器人继续改;Web 内联编辑器不在范围 |
| 可见性 | **全部可见**(归档/删除可逆) |
| 衍生链 | `parent_id` 字段;Artifacts 页可见"衍生自 / 被引用" |
| 来源链接 | `source_conv_id` + `source_run_id` + `source_role`;双向跳转 |
| 跨会话复用 | 用户在新对话提"把上周 X 改一下" → Memory 检索 + artifact 路径/内容上下文拼进新一轮 |

### 守护调度
| 维度 | 决策 |
|---|---|
| 守护调度 | **完整模式**:cron + scanner + reflection + goals;**全部可被用户输入中断** |
| cronEngine | `node-cron` + 持久化(SQLite);重启后恢复 |
| scanner | 扫描用户配置目录(默认 `~/Documents`、`~/projects`),按 mtime/模式触发 |
| reflection | **按需**:每会话结束 + 事件触发 + 用户手动;每日/每周反思**默认关闭**,可在 Settings 启用自定义 cron |
| interruptionGate | 守护任务 `await interruptionGate.acquire()`;用户消息到来即取消挂起(不杀进程,只让出锁) |

### Goal 与行动授权
| 维度 | 决策 |
|---|---|
| Goal 来源 | **Draft Goal + 用户确认**:Sansheng 推断出 Goal 进 Draft(灰色),用户激活才计入主动行动 |
| Goal hierarchy | `愿景(多年)` → `年度` → `季度` → `月度` → `本周` → `今日` |
| Goal 状态机 | Draft → Active → InProgress → Blocked / Done / Dropped / Drift-Detected |
| Drift detection | 每 24h 比对"用户在做的 vs 当前 Active Goal",<30% 相关行为标 ⚠ 并询问 |
| Goal 持续行动 | 每 Active Goal 有 next-action plan;可绑定 cron + 反思输入 + Artifact 产出 |
| 行动授权 | **L3 全自动**:记忆/反思/偏好/任务/提醒全自动;仅破坏性(删/外发/改沙箱外文件)confirm |

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
│   ├── tool-sandbox.md
│   ├── harness.md                     # harness 系统文档
│   └── operations.md
├── src/
│   ├── shared/                        # server ↔ web 共用类型
│   │   ├── http-contract.ts
│   │   ├── ws-events.ts
│   │   ├── blackboard.ts
│   │   └── errors.ts
│   ├── cli/                           # CLI 入口
│   │   ├── index.ts                   # bin 注册(commander)
│   │   └── commands/
│   │       ├── start.ts               # 前台启动(默认) / --daemon
│   │       ├── stop.ts
│   │       ├── status.ts
│   │       ├── open.ts
│   │       ├── config.ts
│   │       ├── migrate.ts             # --data 路径迁移
│   │       ├── reset.ts               # 清空所有数据
│   │       └── dev.ts
│   ├── server/                        # Hono 服务
│   │   ├── index.ts
│   │   ├── app.ts                     # Hono app,挂路由
│   │   ├── ws.ts                      # /ws/chat, /ws/events
│   │   ├── static.ts                  # 托管 dist/web
│   │   ├── routes/
│   │   │   ├── chat.ts
│   │   │   ├── agents.ts
│   │   │   ├── memory.ts
│   │   │   ├── goals.ts
│   │   │   ├── scheduler.ts
│   │   │   ├── artifacts.ts           # artifact CRUD / 浏览
│   │   │   ├── harness.ts             # harness 文件 + 提议 + shadow 测试
│   │   │   ├── profile.ts             # 用户画像
│   │   │   ├── incidents.ts
│   │   │   └── settings.ts
│   │   └── daemon.ts                  # --daemon fork + PID
│   ├── kernel/                        # Pi SDK 封装
│   │   ├── agentKernel.ts
│   │   ├── sessionPool.ts             # 角色 session 池
│   │   ├── eventStream.ts             # 事件 → WS
│   │   ├── toolRegistry.ts
│   │   └── costTracker.ts             # token 用量追踪
│   ├── agents/                        # 多 agent 编排
│   │   ├── roles.ts                   # 5 角色 + system prompt 模板
│   │   ├── blackboard.ts
│   │   ├── orchestrator.ts            # Plan→Execute→Critique→Reflect
│   │   ├── interrupts.ts
│   │   ├── triggers.ts                # Quick vs Plan 启发式
│   │   └── prompts/                   # 角色 prompt 模板(由 harness 系统管理)
│   ├── tools/
│   │   ├── fs/
│   │   ├── http/
│   │   ├── browser/
│   │   ├── shell/
│   │   ├── notify/
│   │   └── registerArtifact.ts        # 手动登记 artifact
│   ├── scheduler/
│   │   ├── cronEngine.ts
│   │   ├── scanner.ts
│   │   ├── reflection.ts              # 会话结束 + 事件触发 + 手动
│   │   ├── goals.ts
│   │   ├── interruptionGate.ts
│   │   └── redLineChecker.ts          # 任何动作前 match 红线
│   ├── memory/
│   │   ├── store.ts
│   │   ├── schema.sql
│   │   ├── migrations/                # 编号 sql 文件
│   │   ├── migrate.ts
│   │   ├── vector.ts
│   │   ├── fragments.ts
│   │   ├── conversations.ts
│   │   ├── artifacts.ts               # artifact CRUD(共享 artifact 系统)
│   │   ├── sessions.ts                # JSONL 子 session 事件
│   │   ├── profile.ts                 # user_profile
│   │   ├── incidents.ts
│   │   └── decay.ts                   # 重要性衰减
│   ├── harness/                        # Harness 自我优化系统(独立目录但复用 artifact)
│   │   ├── manager.ts                 # harness 文件读写
│   │   ├── proposer.ts                # 提议生成
│   │   ├── riskClassifier.ts          # 风险分类
│   │   ├── shadowRunner.ts            # 影子测试
│   │   ├── evaluator.ts               # 综合评分
│   │   ├── rollback.ts
│   │   └── api.ts                     # 给 Sansheng 用的工具
│   ├── providers/
│   │   ├── registry.ts
│   │   ├── anthropic.ts
│   │   ├── openai.ts
│   │   ├── embedding.ts
│   │   └── cost.ts                    # token → 美元估算
│   └── settings/
│       ├── store.ts
│       └── keyring.ts                 # AES-256-GCM + chmod 0600
├── web/                               # React + Tailwind SPA
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                    # 路由 + 7 页 nav
│       ├── routes/
│       │   ├── Chat.tsx
│       │   ├── Agents.tsx             # 多 agent 实时 + Blackboard
│       │   ├── Memory.tsx
│       │   ├── Goals.tsx
│       │   ├── Scheduler.tsx
│       │   ├── Artifacts.tsx          # artifact 浏览 / 预览 / 衍生链
│       │   ├── Harness.tsx            # harness 文件 + 提议 + shadow 结果
│       │   ├── Profile.tsx            # 用户画像(只读 + 编辑)
│       │   └── Settings.tsx           # provider / budget / persona / 沙箱
│       ├── components/
│       │   ├── chat/                  # MessageList / Input / ToolCallCard / ThinkingBlock
│       │   ├── agents/                # AgentCard / BlackboardView / TraceTimeline
│       │   ├── memory/
│       │   ├── goals/
│       │   ├── scheduler/
│       │   ├── artifacts/             # ArtifactCard / PreviewPane / DiffView
│       │   ├── harness/               # HarnessEditor / ProposalsQueue / ShadowReport
│       │   └── ui/                    # 设计系统原语(Button/Card/Dialog/Toast 等)
│       ├── stores/                    # Zustand
│       ├── hooks/
│       ├── lib/
│       │   ├── api.ts                 # fetch + WS 客户端(类型化)
│       │   └── eventBus.ts
│       ├── styles/
│       │   ├── tokens.css             # 设计 token
│       │   └── globals.css
│       └── types/
└── tests/
    ├── unit/                          # vitest
    │   ├── cli/
    │   ├── server/
    │   ├── kernel/
    │   ├── agents/                    # 编排 / blackboard / 中断 / 触发
    │   ├── memory/
    │   ├── tools/                     # 各沙箱
    │   ├── scheduler/
    │   ├── harness/                   # proposer / shadow / evaluator / rollback
    │   └── artifacts/
    └── e2e/                           # Playwright
        ├── boot.spec.ts
        ├── chat.spec.ts
        ├── multi-agent.spec.ts
        ├── harness.propose.spec.ts
        ├── harness.shadow.spec.ts
        ├── scheduler.interrupt.spec.ts
        └── memory.retrieval.spec.ts
```

## 行为与接口

### CLI
```
sansheng start [--port 2718] [--host 127.0.0.1] [--data ~/.sansheng] [--daemon]
sansheng stop
sansheng status                # 显示 PID / 当前地址 / 当前 provider / uptime
sansheng open                  # 在默认浏览器打开 http://localhost:2718
sansheng config [key] [value]  # 查看/设置数据目录、port、host 等
sansheng migrate --to <path>   # 路径迁移
sansheng reset                 # 二次确认后清空 ~/.sansheng
sansheng logs                  # tail ~/.sansheng/logs/sansheng.log
sansheng dev                   # 开发模式:vite dev + tsx watch
```

### REST + WebSocket(主要通道)
- `POST /api/chat` body `{content,opts}` → `{streamId}`;WS 推送 `MessageDelta | ToolCall | MessageDone | Error | NodeUpdate | Heartbeat`
- `GET /api/agents` / `POST /api/agents/interrupt`
- `GET/POST /api/memory/...`、`/api/profile`、`/api/incidents`、`/api/goals`、`/api/scheduler`
- `GET/POST /api/artifacts`、`/api/artifacts/:id`、`/api/artifacts/:id/history`
- `GET /api/harness`、`/api/harness/proposals`、`/api/harness/shadow/:proposalId`
- `POST /api/harness/proposals/:id/{approve,reject,rollback}`
- `GET/PUT /api/settings`、`POST /api/settings/test-provider`

### Blackboard 协议
```ts
type Blackboard = {
  goal: string;
  plan: PlanStep[];            // Planner 写入
  todos: Todo[];               // Executor 维护
  evidence: EvidenceItem[];    // Executor/Critic 写入
  critique: CritiqueRound[];   // Critic 写入
  retrievedMemories: FragmentRef[];
  decisions: Decision[];
  producedArtifacts: ArtifactRef[];  // 本轮产出的 artifact
  ts: number;
};
```
每个角色只读自己需要的字段,写自己的字段;Orchestrator 每轮拉取快照。

### Orchestrator 循环
```
loop while not_done and iterations < max:
  plan = Planner session.update(blackboard)
  result = Executor session.execute(plan, blackboard)
  critique = Critic session.evaluate(result)
  if critique.approve: done = true
  else: blackboard.critique.push(critique); refine plan
end
Reflection session.endOfRun(blackboard) → memory fragment candidates
```
**CancelToken** 贯穿每个 session;用户在 Web 上发新消息即广播 cancel。

### Harness 系统
```
~/.sansheng/harness/
├── system_prompts/{planner,executor,critic,memory,reflection}.md
├── tools/enabled_tools.json
├── policies/{routing,retry,budget,red_lines}.json
├── templates/plan_templates/*.yaml
└── proposals/{pending,applied,rejected}/

# 工具(harness.*)
harness.list()                          # 列出所有 harness 文件
harness.read(path)
harness.propose(path, newContent, rationale, category)   # 写 pending
harness.diff(proposalId)                # 显示 diff
harness.shadow(proposalId)              # 跑影子测试,生成报告
harness.apply(proposalId)               # 仅用户可调用
harness.reject(proposalId, reason)
harness.rollback(path, version)         # 回滚到任意版本
```

**风险分类**(由 proposer.ts 启发式):
- `low` — system prompt 文本 / plan templates / context 策略 / memory 阈值 / routing 微调
- `medium` — 工具开关 / retry policy / budget 阈值
- `high` — red lines / sandbox / 任何安全相关

**影子测试**:`shadowRunner.ts` 挑选历史 5-10 个典型 conversation,新旧 harness 并行跑,evaluator.ts 按 token + 步骤数 + 错误率 + 用户反馈分加权评分;新 harness 须所有维度 ≥ 旧版且综合分提升。

## 测试与验收

### 单元测试(vitest)
- **CLI**:参数解析、`--daemon` fork 流程、PID 清理
- **HTTP/Server**:REST 路由契约、WS 事件 schema 校验、错误返回格式
- **blackboard**:读写隔离、并发更新、序列化稳定
- **orchestrator**:mock 5 角色,验证循环收敛、异常路径、CancelToken 传播
- **triggers**:Quick vs Plan 启发式判定正确
- **interrupts**:用户消息 ≤1 tick 内让步守护任务
- **memory**:schema 迁移、事务回滚、向量 k-NN、衰减、冲突检测
- **artifacts**:全量快照、衍生链、跨会话复用
- **fs/http/shell sandbox**:越权必抛、符号链接阻断、allowlist 之外拒绝
- **harness**:proposer 生成正确、riskClassifier 分类准确、shadowRunner 真实对比、evaluator 评分公式、rollback 还原文件
- **costTracker**:token → USD 估算、月度预算触发提醒

### 集成 / E2E(Playwright)
- **boot**:`sansheng start --port 2719` → `/api/health` 200 → Chat 页可访问
- **chat.basic**:发消息,断言 WS 流 + ToolCall 渲染
- **multi-agent**:`/plan` 触发,断言 Blackboard 出现 plan/evidence/critique 阶段,文件写入沙箱
- **harness.propose**:Sansheng 提议改 system prompt → 出现在 proposals queue → 用户批准 → 新版上线
- **harness.shadow**:提议 → 跑影子测试 → 显示对比报告
- **harness.rollback**:任意提议后回滚,文件恢复
- **scheduler.interrupt**:慢反射任务进行中,中途发 chat,断言守护让步
- **memory.retrieval**:A 会话记住事实,B 会话召回
- **artifacts.cross_conversation**:A 会话产出 artifact,B 会话引用并继续改
- **cli.lifecycle**:`start` → `status` → `migrate --to /tmp/foo` → `stop`

### 验收标准
1. `npm i -g sansheng` → `sansheng start` → `http://localhost:2718` 可访问
2. 单轮聊天:云 API 流式文本正确渲染
3. 多 agent:Plan→Execute→Critic 一轮 cycle 完成,Blackboard 实时可视化
4. 工具:fs / http / browser 跑通真实任务,沙箱强制
5. 记忆:跨会话语义检索有效
6. 守护:cron 任务触发系统消息;用户输入立即中断
7. Sansheng 自动提议改 system prompt,影子测试通过后低风险自动应用;中/高风险需用户审批
8. Harness 文件回滚到任意历史版本,内容完整
9. CLI 全生命周期:`start/status/migrate/reset/stop` 正常,PID 与端口干净
10. `sansheng dev` 起开发模式,前端 HMR + 后端 tsx watch 同时生效
11. Settings 切 provider,silent / 月预算 / 月度 dashboard 正确

## 实施顺序(里程碑)

1. **M0 骨架**:package / tsconfig / Hono + vite + react / 设计 tokens / REST + WS 契约骨架 / `sansheng start` 起来 / 一个空 Chat 页能跑通 `http://localhost:2718`
2. **M1 Kernel + 单 agent 对话**:Settings + Provider + Pi session 流式渲染 + 基础 shell 工具 + cost tracker
3. **M2 持久化 + 记忆**:SQLite + sqlite-vec + schema 迁移系统 + conversations + fragments + 用户画像 + 衰减
4. **M3 多 agent**:5 角色 + Blackboard + Orchestrator + Agents 可视化 + 中断机制 + Quick/Plan 触发
5. **M4 行动工具**:fs / http / browser / notify + 各沙箱
6. **M5 Artifacts 系统**:artifact 自管 + 全量快照 + 6 种 kind + 注册工具 + Artifacts UI
7. **M6 Harness 自我优化**:harness manager + proposer + riskClassifier + shadowRunner + evaluator + rollback + Harness UI
8. **M7 守护调度**:cronEngine + scanner + reflection(按需)+ goals(Draft + 状态机)+ interruptionGate + redLineChecker + Scheduler UI
9. **M8 失败兜底 + 状态报告 + 进度报告**:L1-L4 失败分级响应 + Hybrid 进度 + 节点 + 心跳 + 卡住
10. **M9 打磨 + 测试 + 发布**:设计系统一致化 + 全量单元/E2E + `npm publish` 准备(`files`/`bin`/`prepublishOnly`)

## 明确假设与默认值

- **机器人显示名** = 「三生」;Settings 中可改
- **UI 语言** = 中文 only;agent 回复中英文混合正常
- **默认绑定** = `127.0.0.1:2718`;`--host 0.0.0.0` 由用户显式启用
- **数据目录** = `~/.sansheng/`,可用 `sansheng config data <path>` 改
- **embedding** = 默认复用 chat provider 的 embedding 模型;Settings 可独立指定
- **隐私** = 不收集遥测,无网络上报(除 LLM API 调用)
- **沙箱默认拒绝** = 文件根 / HTTP 域名 / shell 命令均需显式 allow;危险操作 confirm 弹窗
- **平台支持** = Linux + macOS + Windows(Node 20+)均可运行;不提供原生安装包
- **首版暂不做** = 鉴权 / auto-update / 代码签名公证 / 语音输入输出 / 多用户 / 云同步 / artifact 直接 UI 编辑 / 完整 a11y / Provider fallback
- **Harness 优化提案的合规性** = 默认 `auto-apply` 仅低风险且 shadow test 通过;用户可全局关闭或调到 `always-require-approval`
- **历史会话用于影子测试** = 首次启用弹明确同意;用户可随时关闭

## 关键风险与对应

| 风险 | 缓解 |
|---|---|
| Harness 自我修改引入 bug | 影子测试 + 风险分级 + 全量版本可回滚 + 中/高风险必须审批 |
| Sansheng 在 destructive 操作中失控 | L4 自动暂停 + 用户 kill switch + interruptionGate |
| 离线后 token 预算超支 | 月度预算硬限,超额自动暂停新任务 |
| 浏览器/网络工具失败 | 工具错误内联呈现 + 自动重试 + 不影响主对话 |
| 子 session 磁盘增长 | 整次 conversation 归档时压缩 JSONL;Settings 可设保留期 |
| Harness 修改让 Sansheng 偏离雇主偏好 | Shadow test 包含用户反馈分;新增偏好维度可在提议中显式影响 |
