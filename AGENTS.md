# AGENTS.md — Sansheng 项目工作规范

> Single source of truth:把原 pi `MEMORY.md` 中分散的规则收拢于此(即 HANDOFF 附录 B #8 的落地)。
> 2026-10-01 从 pi 迁移到 DSH 时编写;历史全量记忆见 `docs/pi-memory/`,项目动态状态见 `HANDOFF.md`(v6.4+)。

## 项目速览

- **Sansheng(三生)** = 单用户本地 Node 服务:Pi SDK 驱动多 agent + Blackboard 体系,SQLite + sqlite-vec 持久化,fs/http/browser 三类行动能力。
- **状态指针**(按优先级读):`HANDOFF.md`(当前进度/待办)→ `ARCHITECTURE.md`(12 层模块图)→ `PLAN.md`(v5 集成版)→ `MIGRATION-HANDOFF.md`(pi→DSH 迁移)。
- **基线**:244 passed / 1 skipped(28 files)· typecheck 0 error · build 产物在 `dist/src/server/`(**所有 dist 路径必须含 `src/` 前缀**,如 `dist/src/cli/index.js`)。
- 默认 port 2718 / host 127.0.0.1;数据目录 `~/.sansheng/`。

## 编码纪律

- **`as any` 禁止**:`grep -rn 'as any' src/` 必须为 0;`as never` 仅容忍 `registry.ts:114` 一处(getBuiltinModel generics collapse,jev-accepted deviation)。
- 需要类型收窄时写 module-level type guard(参考 `hasBaseUrl` / `hasCost` / `isStreaming` / `hasMsgShape`)。
- **改完代码验证三件套**:`npm run typecheck` → `npm test` → `npm run build`;新增 HTTP endpoint 时另加 server boot smoke(`PI_OFFLINE=1 npm run dev` + curl `/api/health`)。fs-only / 内部模块改动可免 smoke。
- **不要改 tsconfig 的 rootDir/include**(会破坏 `dist/src/cli` bin 路径);server 端不要 import `@shared/*`,需要的类型在 `src/server/ws.ts` 重复定义并注释同步来源。
- DB migration 编号跟随已有文件顺延(v002 已被 vec.sql 占用,agent_states 是 v003),不要照抄 spec 里的数字。
- `FragmentRow.kind` 是闭合 union(`fact|preference|project|context|summary`),**不要扩展**;reflection fragment 用 `kind:"context"` + `[reflection]` 前缀。
- SettingsStore 全局单例(createApp 注入,不要内部 new);kernel cwd = settings.cwd(默认 $HOME),不是 sansheng 启动目录。
- 引用 API 字段前先查证(grep 源码 / 读类型定义),不要凭记忆假设字段存在。

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
