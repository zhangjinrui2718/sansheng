# AGENTS.md — Sansheng 项目工作规范

> Single source of truth:把原 pi `MEMORY.md` 中分散的规则收拢于此(即 HANDOFF 附录 B #8 的落地)。
> 2026-10-01 从 pi 迁移到 DSH 时编写;历史全量记忆见 `docs/pi-memory/`,项目动态状态见 `HANDOFF.md`(v6.4+)。

## 项目速览

- **Sansheng(三生)** = 单用户本地 Node 服务:Pi SDK 驱动多 agent + Blackboard 体系,SQLite + sqlite-vec 持久化,fs/http/browser 三类行动能力。
- **状态指针**(按优先级读):`HANDOFF.md`(当前进度/待办)→ `ARCHITECTURE.md`(12 层模块图)→ `PLAN.md`(v5 集成版)→ `MIGRATION-HANDOFF.md`(pi→DSH 迁移)。
- **排查「跑出来不对/失败了/行为怪」** → 读 `docs/TROUBLESHOOTING.md` + 跑 `npm run diagnose`(只读;概览 / 单会话全量 / harness 提示词体检)。**关键事实:artifacts 存在 `blackboards.artifacts_json` 列里(没有独立表);`goal`/`plan_json`/`todos_json` 是恒空的遗留列,别被带偏;`logs/sansheng.log` 恒为 0 字节,日志只走 stdout。**
- **基线**:679 passed / 1 skipped(81 files)· typecheck 0 error · build 产物在 `dist/src/server/`(**所有 dist 路径必须含 `src/` 前缀**,如 `dist/src/cli/index.js`)。*2026-10-03 批次 7-L(worker 升级先问沟通员 + 沟通员判断轮)收尾时点;此前数字(658/79、605/74)批次 7-K 及更早,以本行为准。*`tests/cli/daemon-start.test.ts > isAlive` 在 DSH 沙箱里恒绿,但在禁 `ps` 的环境下会因 `readPidComm` 返 null 而失败(见 commit `832870e`),是环境性失败不是回归。
- **worker 升级的对象是沟通员,不是用户(批次 7-L)**:executor 卡住 → `handleExecutorCallback` → `Communicator.handleWorkerAsk` **先跑一轮判断轮**(`communicator.worker_ask` 提示词 + `makeWorkerAskAdjudicate`)。`verdict=answer` → 直接写 decision + `executor_resume`,**用户零打扰**;`verdict=escalate` → 沟通员**自己新起一个 `q-comm-*`** 问题问用户(带 lean + ruledOut),总线上如实记 `worker→comm` 与 `comm→user` 两级。**判断轮缺席/超时/解析失败一律退回升级**(fail-safe 到用户,不是 fail-open 到替用户拍板)。三条约束:①提问 payload **必须带 hypothesis 全文**,否则判断轮无从判断;②`onEscalate` 里要把 `pendingExecutorCallbacks` 改挂到新 id 并摘掉 `q-exec-*`,否则一次迟到的 cancel 能再杀一遍已恢复的 executor;③判断轮有独立卫生闸门 `SANSHENG_WORKER_ASK=0` + DI seam `workerAskLlmCall`。见 `tests/agents/worker-ask.test.ts` 与 `tests/server/worker-ask.test.ts`。
- 默认 port 2718 / host 127.0.0.1;数据目录 `~/.sansheng/`。
- **harness prompt 生效性(批次 7-B 教训)**:`~/.sansheng/harness/system_prompts/{planner,executor}.md` 由 `Orchestrator` 构造时经 `loadHarness(dataDir)` 解析并注入。7-B 之前这段是**死接线**(`this.dataDir` 存了没用,spawn 只传 `{ storage }`),Planner/Executor 一直拿模块内 6-9 行 stub,`shared/prompts/planner.md` 那份 91 行正经提示词是死代码(`loadPlannerPrompt` 无调用方)。**改提示词前先确认它真的到达模型** —— 见 `tests/agents/orchestrator-harness-prompt.test.ts`。communicator 侧的 harness prompt 一直是对的(agentKernel 走 loadHarness)。
- **各 agent 的工具集合(批次 7-H,已接线)**:`communicator` 只读 10(SDK 4 + canvas 3 + 原生 3)/ `planner` 只要 `board_list`+`board_read`(刻意不给文件读:它不读代码)/ `executor` 上界 13 = 只读 10 + `edit`+`write`+`bash`(jev A2 裁决,链路上唯一该动手的角色);`harness_manager`/`critic`/`memory`/`reflection` 空集合 + `enforced:false`。**网络出口与 `canvas_write` 对所有角色都不可得。** 执行者的写权限随时可收回:从 `harness/tools/executor.json` 的 allow 里删掉对应项,下次 plan 生效。
- **planner / executor 有工具循环(批次 7-H)**:`src/server/agents/toolLoop.ts` 在 `completeSimple` **外面**包一层循环,`ExecutorLlmCall`/`PlannerLlmCall` 签名不变。模型发 `{"tool_call":{...}}` → 执行 → 回灌 → 收敛到原有 JSON 协议。**授权过滤在 Executor/Planner 构造时按 `allowedTools` 做**(不给即空),调用方给全集也越不了权。
- **harness 工具集合 = 权限面,分两层(批次 7-E)**:每个 agent 一份 `~/.sansheng/harness/tools/{role}.json`(实现 `src/server/harness/tools.ts`,与 `system_prompts/` 并列)。`ROLE_CEILING`(代码内)= **架构上界,集合文件突破不了**;集合文件 = 上界内可增减的用户意图。**「升级集合」(改文件)与「解除架构约束」(改 `ROLE_CEILING` 的代码动作)是两件事,别混。** 解析全程 **fail-closed**,越权条目进 `blockedByCeiling` 且必须对用户可见。当前**只有 communicator `enforced:true`**(kernel.createPiSession → `createAgentSession({ tools })`);其余 6 个角色走 `completeSimple` 单轮补全、**没有工具循环**,`enforced:false` = 集合已就位但未接线 —— **别给它们写非空出厂名单**(那是换个姿势继续撒谎,旧 `enabledTools` 就是这么烂掉的)。接线清单见 tools.ts 文件头 4 步;改 `FACTORY_SETS` 时**必须**把旧值追加进 `LEGACY_TOOL_SETS`,否则存量用户文件被永久误判为「用户手笔」(prompt 侧 5a/5b-1/7-B 已踩过三次)。

## 编码纪律

- **`as any` 禁止**:`grep -rn 'as any' src/` 必须为 0;`as never` 仅容忍 `src/server/providers/registry.ts` 内 `getBuiltinModel` 调用处一处(getBuiltinModel generics collapse,jev-accepted deviation;批次 4b B6 后行号已漂移,以 grep 为准)。
- 需要类型收窄时写 module-level type guard(参考 `hasBaseUrl` / `hasCost` / `isStreaming` / `hasMsgShape`)。
- **改完代码验证三件套**:`npm run typecheck` → `npm test` → `npm run build`;新增 HTTP endpoint 时另加 server boot smoke(`PI_OFFLINE=1 npm run dev` + curl `/api/health`)。fs-only / 内部模块改动可免 smoke。
- **不要改 tsconfig 的 rootDir/include**(会破坏 `dist/src/cli` bin 路径);server 端**禁 value import `@shared/*`**(批次 4b C12 更正措辞:旧写法「不要 import @shared/*」自相矛盾 —— `import type { ... } from "@shared/types/agents"` 遍地都是,tsconfig.server.json 的 include 本就含 `shared/**/*`,`dist/shared/**` 确实会 emit,**type-only import 是允许且推荐的**)。被禁的是会**产生运行时依赖**的 value import(`import { X } from "@shared/..."` 会把 shared 拉进 server 的运行时依赖图)。需要在 server 侧重复定义的**协议类型**(如 ClientCommand)在 `src/server/ws.ts` 镜像一份并注释同步来源。
- DB migration 编号跟随已有文件顺延(v002 已被 vec.sql 占用,agent_states 是 v003),不要照抄 spec 里的数字。
- `FragmentRow.kind` 是闭合 union(`fact|preference|project|context|summary`),**不要扩展**;reflection fragment 用 `kind:"context"` + `[reflection]` 前缀。
- SettingsStore 全局单例(createApp 注入,不要内部 new);kernel cwd = settings.cwd(**默认 `~/sansheng-workspace`**,批次 6 起不再是 `$HOME`),不是 sansheng 启动目录。默认值是**惰性**的(`defaultWorkspaceDir()` = `join(os.homedir(), "sansheng-workspace")`,不要在模块加载期算死 —— daemon/CLI 启动时 env 可能被改写);存量 `cwd === os.homedir()` 在 load 期自动迁到新默认(严格相等判定,**不覆盖**用户自定义值),且**只对出厂默认**自动建目录(自定义路径不代建)。sandbox 允许根与此无关(走 `~/.sansheng/sandbox.json`)。
- 引用 API 字段前先查证(grep 源码 / 读类型定义),不要凭记忆假设字段存在。
- **subagent 活性协议(2026-10-02 血泪写入)**:DSH 的 `[running]` 状态**不代表在干活**——出现过 subagent 首轮 LLM 永不返回、状态永久 running、磁盘零落盘零进程的情况(2026-10-02 早上一次,机器无睡眠事件)。因此:①**git 是唯一进度真相**;②派工后**每 ≤30 分钟**查一次 `git log <baseline>..HEAD` + `git status` + `find -mmin`,连续 2 次(≥35-40 分钟)零落盘即判定僵死 → `interrupt_agent` 后**原样重派**(self-contained prompt,禁止子 worker);③长任务拆批,单批控制在 1-2 小时内,缩小单次僵死的损失面;④模型切换/会话中断会让在跑 agent 立即死掉(正常现象,同样以 git 为准重派)。

## 工作方式(用户偏好,必须遵守)

### 决策自主
- **可逆、有依据的决策:直接执行并汇报结果,不要把选项抛回用户。** 只有四类情况才问用户:不可逆操作(删除/push --force)、审美与主观偏好、信息不足、高风险(资金/个人/团队)。
- jev skill **已恢复**(`~/.dsh/skills/jev/`,2026-10-01,selftest 通过):准备抛 A/B/C 选择题前,只要 5 段 state(现状数据/选项细节/依赖图/用户历史信号/risk profile)写得出 → 先 `jev.sh ask` 拿校准概率;conf≥0.7 直接采用,0.4–0.7 看 margin,<0.4 才问用户。完整工作流见 `~/.dsh/AGENTS.md` §Jev + `~/.dsh/skills/jev/SKILL.md`。

### 委派(DSH 工具映射)
- 大的、bounded 的编码任务派 subagent(`subagent` / `subagent_fork` / 多任务用 `workflow`),主会话不手写大量代码;文档更新、小 refactor、验证类工作主会话直接做(委派 overhead 不值)。
- 委派 prompt 必须 self-contained:scope 做/不做清单 + 验证步骤(typecheck/test/build)+ report 要求(git log/status、验证输出末尾若干行原文、改动文件+行号、open questions ≤5 条)。
- **显式禁止 subagent 再委派 sub-worker**(父等子 → idle watchdog 双杀的已知死亡模式)。
- 大任务要求 subagent **第一件事 commit `wip:` checkpoint**;进程被杀 ≠ 任务失败,以 git 状态为准(log/diff/status + 读产物文件),必要时主会话补全 report。
- 派出后台任务后**不要 sleep 轮询**,等完成通知;期间做其他独立工作。

### Git 纪律
- **push-first**:commit 后尽快 `git push origin master`(新机凭据已验证可用);不要攒一批再推。
- 报告进度永远以 git 为准,不以进程/工具输出为准。

## 历史与环境映射

- 旧文档(pi 时代)中 `/root/projects/sansheng/...` → `/Users/fuyao/projects/sansheng/...`;`/root/.pi/agent/...` → 本机 `~/.pi/agent/...`(**注意:本机 pi 数据是旧的,项目已迁 DSH,pi 配置不再是工作依赖**)。
- 本机 Node v26.8.1;better-sqlite3 v13.0.3 走 N-API,任意新 Node 版本只需 `npm rebuild better-sqlite3 --build-from-source` 一次。
- npm registry 为 npmmirror;`package-lock.json` 可能出现镜像元数据漂移(`hasShrinkwrap` 等字段),无实质影响。
- 旧机遗留(需要时从旧机取):pi sessions 归档、session-hoarder。(jev skill 已于 2026-10-01 恢复到 `~/.dsh/skills/jev/`,不再是遗留项)

## 已知待办(接 HANDOFF.md v6.4)

1. 8 个 manual browser verification tests(USER-only,浏览器手动触发)+ 批次 3 新增 8 项连接生命周期手动验证(清单见 HANDOFF.md v6.6)。
2. 5 个 E2E blocker 的真实 LLM 端到端实测(目前仅 vitest fakeLlmCall 验证;**2026-10-01 批次 1-3 修复后主链路已真正可测**——此前 TDZ/僵尸/DAG 通配 bug 只在真实路径暴露,见 docs/CODE-REVIEW-2026-10-01.md)。
3. `tests/agents/e2e-blockers.test.ts` 中 1 个 `it.skip()` placeholder 补边缘 case。
4. ~~jev skill 恢复(旧机 → `~/.dsh/skills/jev/`),恢复后把 jev 决策流程加回本文件~~ ✅ 已恢复 + 本文件 §决策自主 已补 jev 工作流(2026-10-01)。
5. ~~AGENTS.md literal 文件~~ ✅ 本文件即落地(2026-10-01)。
