# pi 记忆归档(2026-09-28 ~ 2026-10-01)

Sansheng 项目从 **pi**(`@earendil-works/pi-coding-agent`,旧机 Linux `/root/.pi/agent/memory/`)迁移到 **DSH**(DeepSeek Harness)时保留的长期记忆全量归档。

**来源**:`migration/setup-2026-10-01` 分支 `migration-bundle/pi-config-essentials/memory/`(2026-10-01 13:36 CST 打包,权威版)。
**归档时间**:2026-10-01,迁移当天。

## 内容

| 文件 | 说明 |
|---|---|
| `MEMORY.md` | 长期记忆主文件(792 行):项目偏好、派工标准、jev 方法论、架构决策记录(M3+ 15 decisions)、技术教训 |
| `SCRATCHPAD.md` | 迁移时刻的待办便签(多数已完成,少量 pending) |
| `daily/2026-09-29.md` | M0→M3+ plan 锁定 全过程日志 |
| `daily/2026-09-30.md` | B3–B7 派工、as-any sweep、jev-check 扩展调试日志 |
| `daily/2026-10-01.md` | http.ts cleanup、Node 26 验证、5 E2E blocker 一锅端、迁移打包日志 |
| `recovery/*.json` | pi-memory 自动恢复记录(1 条,as-any sweep 会话) |

## 阅读须知

- 所有 `/root/projects/sansheng/...`、`/root/.pi/agent/...` 路径 = 旧机 Linux 路径,新机等价为 `/Users/fuyao/projects/sansheng/...`、`/Users/fuyao/.pi/agent/...`
- 文中 `delegate_task` / `acp_delegate` / `subagent_*` 是 **pi-subagent** 的工具,在 DSH 中对应 `subagent` / `subagent_fork` / `workflow` 工具;教训本身(禁止再委派、checkpoint commit、进程死亡≠失败)仍然适用
- jev skill(`~/.pi/skills/jev/`)**未随 bundle 迁移**,jev-check 扩展也未移植;jev 方法论作为决策纪律浓缩进了根目录 `AGENTS.md`
- 浓缩后的现行规范见仓库根 `AGENTS.md`;项目状态见 `HANDOFF.md`(v6.4);迁移全程见 `MIGRATION-HANDOFF.md`
