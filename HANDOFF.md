# Sansheng 项目交接包

**生成时间**:2026-09-30 16:20 CST · **v6.0**(M3+ B5+B7-partial + Communicator fix landed)
**适用**:下一会话(主对话 / worker)开盒即读
**配套阅读**:`/root/projects/sansheng/PLAN.md`(v5 集成版),`/root/.pi/agent/memory/MEMORY.md`(长期偏好 + 教训)

---

## TL;DR

Sansheng = 单用户本地 Node 服务。M0-M4 + M3+ B1+B2 已 commit + push(10 commits remote)。
**当前 M3+ 进展**:
- ✅ **B3 + B4** 已 commit(7228268 + 640204f) — Orchestrator + Planner + Executor + HarnessManager event-sourced rewrite
- ✅ **Communicator fix** 已 commit(06abfcc) — wire user-customized systemPrompt 到 DefaultResourceLoader
- ✅ **B5** 已 commit(33d60dc) — Planner + Executor reinforcement(LLM graceful failure + DAG cycle detection)
- ✅ **B7 partial** 已 commit(e735689) — Timeline BusRow memoization
- ✅ **C2 server smoke** 全绿(8min,无 commit)
- ❌ **B6 lost** — Harness Manager reinforcement worker 死亡,/tmp 被 systemd 清理,无 commit
- 🔧 **B7 partial** — Timeline.tsx memo 提交,但 chat.ts busStream + bus_replay 改动没 commit
- 🔧 **7 commits 未 push** to origin/master

**当前坐标**:**HEAD = `e735689`**,git clean,**163/163 tests pass**(原 157 + B5 加 6)。
**origin/master 落后 7 commits**。

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

**Tests**:**163/163 pass** (原 132 + B1=181 + ... wait, actually 132 → 157 → 163)

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

### better-sqlite3 v13 upgrade(pending)

- `^11.7.0 → ^13.0.3`
- `engines.node >=20 → >=22`
- **Risk**:sqlite-vec prebuilt binary 是否兼容 v13 ABI(per jev score = low risk)
- 15min 派工

### 8 manual verification tests(USER-only)

- UI 端到端测试,需用户在浏览器手动触发
- 本机 smoke 不覆盖
- 必须用户在机器前

### 7 commits 未 push

- `e735689` → `d3a6896` 共 7 个本地 commits ahead of `origin/master`
- 建议:`git push origin master`(无 conflict 风险)

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
- **handoff**:`/root/projects/sansheng/HANDOFF.md`(本文件,v6.0)
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

1. **[BUG · remote verification]** User Profile "暂无 profile" — 已知是 empty state 正常(无 data)。需用户在 UI 触发 M3 reflection 才会生成内容。
2. **HANDOFF §C2 路径描述错误**:`?scope=global` → 实际 `/api/blackboard/global`(不影响代码,只本文件)
3. **B6 重派时**:用 `TMPDIR=~/.cache/tmp` 新会话(避免 /tmp 被清)
4. **push 7 commits**:本地 `master` 领先 `origin/master` 7 个,建议 `git push origin master`
5. **8 manual verification tests**:USER-only,需在浏览器触发

#sansheng #m3-plus #v6 #b5-done #b7-partial #b6-lost #163-tests #7-unpushed