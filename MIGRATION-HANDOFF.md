# Sansheng 迁移交接文档(MIGRATION-HANDOFF)

**v2 · 2026-10-01 14:08 CST · 迁移目标改为 DSH**(v1 曾以"恢复到新机 pi"为目标,已被本版取代;用户明确:不迁入本机 pi,迁入当前 DSH 环境)
**迁移方向**:旧机 pi(Linux `/root/.pi/agent` + `/root/projects/sansheng`)→ 新机 **DSH(DeepSeek Harness)**(macOS `/Users/fuyao`,本文档所在会话即 DSH)
**迁移分支**:`migration/setup-2026-10-01`(commit `2b3f1a4`,基于 master `4b280b0`)
**配套阅读**:根目录 `AGENTS.md`(迁移产出的工作规范 single source of truth)、`HANDOFF.md`(v6.4 项目交接)、`docs/pi-memory/`(旧记忆全量归档)
> **注**:本文提到的 `ARCHITECTURE.md` 已删(2026-10-04 批次 18)。它是迁移期的产物,描述的系统后来被整体替换。

---

## TL;DR

- **迁移已完成主体部分**:pi 的长期记忆(MEMORY.md 792 行 + 3 天 daily + SCRATCHPAD)已全量归档到 `docs/pi-memory/`,并浓缩为两级 DSH 指令文件——项目根 `AGENTS.md`(sansheng 规则)+ `~/.dsh/AGENTS.md`(全局工作偏好)。**两者已实测生效**(DSH `dsh-agent-instructions` 即时注入会话上下文)。
- **本机 `~/.pi/agent/` 完全未动**,也不再是工作依赖;`restore.sh` 不需要跑(它是"恢复到新 pi"的脚本,与本迁移方向不符)。
- pi 的 2 个扩展:`empty-array-fix.ts` 是 pi-subagent bug workaround,**DSH 不适用,弃**;`jev-check.ts`(turn-end 审计)DSH 无对等扩展点(desktop profile 未挂 hooks bridge),**降级为 AGENTS.md 行为纪律**。
- **最大缺口:jev skill 不在 bundle 里**,本机也没有;恢复旧机 `~/.pi/skills/jev/` 后可装为 DSH skill(`~/.dsh/skills/jev/`)。
- 源码无需迁移:新机仓库 master `4b280b0` = 快照内容。GitHub 推送凭据已验证可用。

---

## 1. 迁移 bundle 里有什么(原始清单)

分支 `migration/setup-2026-10-01` · commit `2b3f1a4` · 共 ~488 KB:

| 内容 | 说明 | 迁移处置(→ §4) |
|---|---|---|
| `pi-config-essentials/memory/` | `MEMORY.md`(792 行,10-01 权威版)+ `SCRATCHPAD.md` + `daily/2026-09-29..10-01.md` + `recovery/`(1 JSON) | ✅ 归档 + 浓缩进 AGENTS.md |
| `pi-config-essentials/extensions/` | `empty-array-fix.ts`、`jev-check.ts` | ❌ 弃 / ⬇️ 降级为纪律条文 |
| `pi-config-essentials/config/pi-task-models/config.json` | pi-subagent 任务→模型路由(minimax-cn/MiniMax-M3) | ❌ 不适用(DSH 自有模型路由) |
| `pi-config-essentials/settings.json` | 旧机 pi UI 偏好 + 9 个 npm packages | ❌ 不适用 |
| `pi-config-essentials/models-store.json` | 完整模型目录(848 行,含 minimax-cn 自定义 provider) | ❌ 不迁(DSH 用 `cordis.patch.yml`,已配 qwen;需要 minimax 时按 §6-4 添加) |
| `sansheng-snapshot.tar.gz` | 源码快照(174 文件,= master `4b280b0`) | ✅ 无需解压,仓库即快照 |
| `restore.sh` + `README.md` | 恢复到"新机 pi"的一键脚本 + 说明 | 保留在分支上备用,**本次不执行** |

**bundle 刻意排除项**(在哪都找不到,不要找):`auth.json`(API keys)、pi releases(325M)、npm 全局(342M)、`sessions/`(18M)、`session-hoarder/`(208M)、`.ghp_token`、`node_modules/`、`dist/`、`.git/`。

---

## 2. 迁移冻结时的项目状态(2026-10-01 12:38 CST,旧机)

- master HEAD = `4b280b0`,origin 同步,git clean;**176/176 tests pass**(Node v22.23.3 与 v26.8.1 双验证),typecheck 0 error,dist 产物在 `dist/src/server/`
- 已完成:M0–M4 + M3+ B1–B7 + 5 个 E2E blocker(`6a522c4`..`e27a3c2`)+ ARCHITECTURE.md + as-any 清零 + better-sqlite3 v13 / Node 22 升级
- 未完成:8 个 manual browser tests(USER-only)、5 blocker 真实 LLM 实测、附录 B #6/#7/#8(其中 **#8 "AGENTS.md literal 文件" 已借本次迁移落地**)

---

## 3. DSH 侧的持久化机制(迁移落点依据)

来自 `@deepseek-ai/dsh-agent-instructions` / `dsh-skill-filesystem` / `dsh-hooks-*` 包文档(本机 `~/.dsh/profiles/node_modules/`):

| 机制 | 位置 | 行为 |
|---|---|---|
| **用户全局指令** | `~/.dsh/AGENTS.md`(`$DSH_HOME/AGENTS.md`) | 每个会话首个请求即注入(durable baseline) |
| **项目指令链** | 项目根(`.git` 标记)到工作目录的 `AGENTS.md` / `CLAUDE.md`(+ `.local.md` 叠加) | 同上;总预算 65,536 字节,越宽泛的文件越先被裁剪 |
| **Skills** | `~/.dsh/skills/`、`<project>/.dsh/skills/`、`<project>/.agents/skills/` | `<name>/SKILL.md` 或 `<name>.md` + YAML frontmatter;目录有 watcher,增删即时生效;经 `skill` 工具按需加载 |
| **Hooks(可选)** | Claude-Code 桥,需 profile 挂 `dsh-hooks-claude-code` + `hooks.json` | 支持 session start / prompt / tool 前后 / **run 将停止(可强制继续)** / subagent 起止;**本机 desktop profile 未挂载** |
| **模型/设置** | `~/.dsh/profiles/desktop/cordis.patch.yml` + `~/.dsh/settings.yaml` | 当前默认模型 qwen/qwen3.8-max(`dsh-llm-pi-ai` provider) |
| 无长期记忆包 | — | DSH 没有 pi-memory 等价物;**指令文件 + skills 就是记忆机制**,全量历史靠仓库归档 |

---

## 4. 已执行的迁移动作(2026-10-01,本次会话)

| # | 动作 | 产物 |
|---|---|---|
| 1 | pi 记忆**全量归档**进仓库(master 提交,不再依赖迁移分支) | `docs/pi-memory/`(MEMORY.md 792 行 + SCRATCHPAD + daily×3 + recovery + README 溯源) |
| 2 | MEMORY.md 中 sansheng 项目规则**浓缩**为项目指令文件(as-any 纪律、验证三件套、dist 路径、tsconfig/migration/FragmentRow 陷阱、委派规范、push-first、路径映射、待办) | `/Users/fuyao/projects/sansheng/AGENTS.md` |
| 3 | 通用工作偏好(决策自主四例外、委派教训、git/验证纪律)**浓缩**为全局指令文件 | `~/.dsh/AGENTS.md` |
| 4 | 两级指令文件**实测生效**:写入后 DSH 立即注入本会话上下文(项目级 + user-global 两条 system-reminder 均已观察到) | — |
| 5 | jev-check.ts 的核心纪律(jev 前置、conf≥0.7 直接执行不问用户、no-jev 须声明理由)转写为 AGENTS.md 条文;jev 缺位期间以"证据充分即执行"替代 | `AGENTS.md` §决策自主 |
| 6 | 本文档 v1(pi 恢复版)重写为 v2(DSH 版) | 本文件 |

**明确不做的事**:
- ❌ 不向 `~/.pi/agent/` 拷贝任何东西(本机 pi 数据保持原样:9/29 的 18 行旧 MEMORY.md、空 extensions、本机自己的 settings/models-store)
- ❌ 不跑 `restore.sh`(其 rsync 会覆盖本机 pi 的更新配置,且解压会产生嵌套 `sansheng/`;方向也已作废)
- ❌ 不迁 `empty-array-fix.ts`(pi-subagent 空数组 bug 的 workaround,DSH 的 subagent/workflow 是原生实现,无此 bug)

---

## 5. 概念映射表(pi → DSH)

| pi(旧机) | DSH(新机) | 状态 |
|---|---|---|
| `~/.pi/agent/memory/MEMORY.md`(pi-memory 自动注入) | `AGENTS.md`(项目)+ `~/.dsh/AGENTS.md`(全局),`dsh-agent-instructions` 自动注入 | ✅ 已迁 |
| `daily/` + `SCRATCHPAD.md` | 仓库归档 `docs/pi-memory/`(只读历史;DSH 会话内工作清单用 `todo_write` 工具) | ✅ 已归档 |
| `delegate_task mode=isolated`(pi-subagent v5,写代码进项目) | `subagent` / `subagent_fork`(独立上下文;fork 继承会话) | ✅ 映射写进 AGENTS.md |
| `acp_delegate agent=worker`(草稿/PoC) | `subagent`(草稿类产出) | ✅ 同上 |
| `subagent_stage/integrate/promote`(多 worker 图) | `workflow`(JS 编排多 subagent,pipeline/parallel) | ✅ 同上 |
| jev-check.ts(turn_end 审计扩展,强制先 jev) | 无扩展点(profile 未挂 hooks bridge)→ AGENTS.md 纪律条文;若日后要强约束,可挂 `dsh-hooks-claude-code` + Stop hook(exit 2 强制继续) | ⬇️ 降级迁移 |
| jev skill(`~/.pi/skills/jev/scripts/jev.sh`,noul/choice/score) | 目标位 `~/.dsh/skills/jev/`(SKILL.md + 脚本);**skill 本体不在 bundle,旧机才有** | ❌ 缺口 |
| pi-task-models(delegateTask → minimax-cn/MiniMax-M3) | DSH 默认模型 = qwen/qwen3.8-max(cordis.patch.yml `agent-default-model`);subagent/workflow 支持 per-agent `provider`/`model` override | ✅ 机制说明,无需动作 |
| models-store.json(minimax-cn 自定义 provider) | 如需在 DSH 用 MiniMax:在 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `llm-pi-ai.providers` 下照 qwen 样例加 `minimax-cn` 段(apiKeyEnv + baseURL + models) | 📝 备用说明 |
| settings.json packages(pi 扩展生态) | DSH bundles/profiles + GUI settings | ❌ 不适用 |
| `TMPDIR=~/.cache/tmp`(防 systemd 清 /tmp) | macOS 无此问题,不需要 | ❌ 不适用 |
| GitHub PAT via `$GITHUB_TOKEN`/`.ghp_token` | 本机 credential helper 已可用(`27a784d` push 实测成功) | ✅ 已验证 |

---

## 6. 已知差异与坑

1. **AGENTS.md 生效时机**:无文件 watcher;已运行的会话在下一次成功 read/write/edit 或会话恢复时才 reconcile,**新会话必然带上**。两级文件合计约 10 KB,远低于 64 KB 预算,安全。
2. **指令文件别再放大块易变内容**:项目动态状态(HEAD、测试数、待办进度)归 `HANDOFF.md` 管;`AGENTS.md` 只放长效规则,避免每次会话烧 token 又很快过期。
3. **jev 依赖悬空**:AGENTS.md 与归档记忆多处提到 jev;在 skill 恢复之前,所有"跑 jev"的条文按"证据充分即自主决策"执行(已写入)。恢复方法:旧机 scp `~/.pi/skills/jev/` → 新建 `~/.dsh/skills/jev/SKILL.md`(frontmatter: name/description/whenToUse)+ `scripts/jev.sh`,配 `TYPESAFE_API_KEY` 环境变量。
4. **想在 DSH 用 minimax-cn 模型**:编辑 `~/.dsh/profiles/desktop/cordis.patch.yml` → `llm-pi-ai.config.providers` 增加 `minimax-cn`(参照现有 `qwen` 段:apiKeyEnv / api / baseURL / models 列表),重启 DSH。当前默认 qwen3.8-max 不动。
5. **旧文档路径**:归档与 HANDOFF/PLAN 中所有 `/root/...` 读作 `/Users/fuyao/...`(AGENTS.md 已写映射规则)。
6. **本机 `~/.pi/agent/` 是旧数据**(9/29 的 18 行 MEMORY.md、空 daily/extensions),与 bundle 分叉;**已决定不合并、不使用**,若哪天要跑 pi 再以 bundle 为准(见分支上 `migration-bundle/README.md`)。
7. `package-lock.json` npmmirror 元数据漂移(工作区未提交):无实质影响,可还原或单独提交。
8. better-sqlite3 v13.0.3 走 N-API:Node 升级后如 load 失败,`npm rebuild better-sqlite3 --build-from-source` 一次即可。

---

## 7. 验证清单

**已验证(迁移当天)**:
- [x] 项目 `AGENTS.md` 写入后被 DSH 注入会话上下文(system-reminder 观察到全文)
- [x] `~/.dsh/AGENTS.md` 同上(user-global 注入观察到)
- [x] `docs/pi-memory/` 行数核对:MEMORY 792 / SCRATCHPAD 26 / daily 634+627+170
- [x] GitHub push 凭据可用(`27a784d`、`674a9ad` 推送成功)

**已验证(项目侧,2026-10-01 下午 DSH 会话,详见 HANDOFF v6.5)**:
- [x] `npm run typecheck` / `npm test`(176/176)/ `npm run build` 在新机全绿 — **前提:修复了 2 个 macOS 兼容 bug**(`f379c50`:sandbox realpath 校验改 real-vs-real 比较 + 测试清理 `dirname`;首跑曾 10 failed,生产 canvas 路径同受影响,非纯测试问题)
- [x] `PI_OFFLINE=1 npm run dev:server` boot + curl `:2718/api/health` → 200(`/api/conversations`、`/api/blackboard/global`、`/api/profile` 也全 200)。⚠️ 注意:DSH 会话 sandbox(workspace-write)内 server 无法写 `~/.sansheng/`(SQLITE_CANTOPEN),smoke 需在更宽 file policy 下运行
- [x] 新开 DSH 会话,两级 AGENTS.md 首个请求即生效(项目级 + user-global 注入均观察到;会话中途修改 `~/.dsh/AGENTS.md` 也被 reconcile 即时生效)
- [ ] 8 个 manual browser tests(USER-only)+ 5 blocker 真实 LLM 实测 — **仍为 USER-side,未跑**

---

## 8. 迁移后待办

1. ~~**(USER)** 决定 jev skill 是否恢复(旧机 → `~/.dsh/skills/jev/`);恢复后把 jev 决策流程补回两级 AGENTS.md~~ ✅ **已完成(2026-10-01)**:skill 恢复到 `~/.dsh/skills/jev/`(selftest 通过),全局 `~/.dsh/AGENTS.md` §Jev 决策工作流(用户手笔)+ 项目 `AGENTS.md` §决策自主 均已补
2. **(USER)** 决定 `migration/setup-2026-10-01` 分支去留:记忆已归档 master,分支唯一剩余价值是 `restore.sh` + 原始 bundle + pi 恢复路线;建议保留远端、本机可删
3. **(USER)** 决定旧机数据处置:sessions(18M)/ session-hoarder(208M)/ auth.json 仍只在旧机
4. ~~**(可选)** 跑一遍 §7 项目侧验证(typecheck/test/build/dev boot)~~ ✅ 已完成(2026-10-01,全绿,见 §7)
5. **(可选)** minimax-cn provider 接入 DSH(§6-4)
6. ~~**(可选)** 处理 package-lock.json 漂移(§6-7)~~ ✅ 已单独提交(`bfbf032`)
7. 项目待办接 `HANDOFF.md` v6.4(8 manual tests / 真实 LLM E2E / e2e skipped placeholder / jev-check regex 精修——最后这条随扩展弃用可关闭)

---

## 9. 记忆指针(开盒必读顺序)

1. 根目录 `AGENTS.md` — 现行工作规范(single source of truth,DSH 每会话自动注入)
2. `HANDOFF.md` v6.4 — 项目动态状态与待办
3. `docs/pi-memory/MEMORY.md` — 历史全量(派工标准演变、jev 方法论全文、M3+ 15 决策、技术教训原始记录)
4. `docs/pi-memory/daily/2026-10-01.md` — 迁移前最后一个工作日日志(含 5-blocker 一锅端全程与 worker SIGKILL 教训)
5. ~~`ARCHITECTURE.md`~~(**已删,批次 18**)/ `PLAN.md` — 架构与总计划。(现存结构文档:`docs/DESIGN-PLATFORM.md`)

---

## 10. 回滚

- 本次迁移对仓库是**纯新增**(AGENTS.md、docs/pi-memory/、本文档),`git revert` 对应 commit 即可完全回滚
- `~/.dsh/AGENTS.md` 删除文件即回滚(全局指令消失)
- 本机 `~/.pi/agent/` 未被触碰,无回滚需求
- 迁移分支与 bundle 原样保留在 origin
