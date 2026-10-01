# Sansheng 迁移交接文档(MIGRATION-HANDOFF)

**生成时间**:2026-10-01 13:54 CST · **迁移日当天写就**
**迁移方向**:旧机 Linux(`/root/projects/sansheng`,pi 0.87.x 时代配置)→ 新机 macOS(`/Users/fuyao/projects/sansheng`)
**迁移分支**:`migration/setup-2026-10-01`(commit `2b3f1a4`,基于 master `4b280b0`)
**配套阅读**:根目录 `HANDOFF.md`(v6.4 项目交接)、`ARCHITECTURE.md`(12 层模块图)、`migration-bundle/README.md`(bundle 原始说明)

> 本文档放在 master 上,是"迁移这件事"的交接;项目本身的交接在 `HANDOFF.md`。
> 迁移 bundle 全部内容在 `migration/setup-2026-10-01` 分支的 `migration-bundle/` 目录下,master 上没有。

---

## TL;DR

- 项目源码**不需要**从 bundle 恢复 —— 新机已 clone 仓库,master `4b280b0` 与快照内容一致(快照就是按 `4b280b0` 打的)。
- 真正需要恢复的是 **pi 配置**(`~/.pi/agent/`):memory(9/29–10/01 三天完整记忆)、2 个自定义扩展、模型目录。
- 新机 `~/.pi/agent/` **已存在且部分数据是旧的/分叉的**,不能无脑跑 `restore.sh` 全覆盖,按 §5 逐项合并。
- bundle **不含** jev skill、API keys、pi releases、sessions 归档 —— 见 §6 缺口清单。
- 恢复完成后按 §7 验证,然后接 `HANDOFF.md` v6.4 的待办继续干活(§8)。

---

## 1. 迁移 bundle 里有什么

分支 `migration/setup-2026-10-01` · commit `2b3f1a4` · 共 ~488 KB:

| 内容 | 大小 | 说明 |
|---|---|---|
| `pi-config-essentials/memory/` | ~2400 行 | `MEMORY.md`(792 行,10-01 13:46 版,**权威版**)+ `SCRATCHPAD.md` + `daily/2026-09-29..10-01.md` + `recovery/`(1 个 JSON) |
| `pi-config-essentials/extensions/` | 2 文件 | `empty-array-fix.ts`(pi-subagent 空数组 bug workaround)、`jev-check.ts`(jev 前置审计扩展,turn_end hook,含 2026-09-30 修复的 event-driven tracker) |
| `pi-config-essentials/config/pi-task-models/config.json` | 13 行 | `fav` profile(minimax-cn/MiniMax-M3, medium)+ `pi-subagent/delegateTask → fav` 任务路由 |
| `pi-config-essentials/settings.json` | 17 行 | 旧机 pi UI 偏好(dark / minimax-cn / 9 个 npm packages) |
| `pi-config-essentials/models-store.json` | 848 行 | 完整模型目录(含 minimax-cn 等自定义 provider) |
| `sansheng-snapshot.tar.gz` | 271 KB | 项目源码快照(174 文件,= master `4b280b0`,排除 node_modules/dist/.git) |
| `restore.sh` | 97 行 | 一键恢复脚本(见 §5 的适用性评估) |
| `README.md` | 110 行 | bundle 原始说明 |

**刻意排除**(恢复时不要找):`auth.json`(API keys,永不入库)、pi releases(325M)与 npm 全局(342M)(npm 重装)、`sessions/`(18M)与 `session-hoarder/`(208M)(留在旧机,需要时 scp)、`.ghp_token`(GitHub PAT)、`node_modules/`、`dist/`、`.git/`。

---

## 2. 迁移冻结时的项目状态(2026-10-01 12:38 CST)

- **master HEAD = `4b280b0`**(= `e27a3c2` 代码 + handoff 文档 commit),origin 同步,git clean
- **176/176 tests pass**(Node v22.23.3 与 v26.8.1 双验证),typecheck 0 error,build OK(dist 产物在 `dist/src/server/`)
- 已完成:M0–M4 全部里程碑 + M3+ B1–B7 + 5 个 E2E blocker(`6a522c4`..`e27a3c2`)+ ARCHITECTURE.md(`c32c5c6`)+ as-any 清零 + better-sqlite3 v13 / Node 22 升级
- 未完成(交接给新机):见 §8

---

## 3. 旧机 → 新机环境对照

| 项 | 旧机(源) | 新机(本 Mac,实测) |
|---|---|---|
| OS / 用户 | Linux, `root` | macOS, `fuyao` |
| 项目路径 | `/root/projects/sansheng` | `/Users/fuyao/projects/sansheng`(已 clone,remote = `https://github.com/zhangjinrui2718/sansheng.git`) |
| pi home | `/root/.pi/agent` | `/Users/fuyao/.pi/agent`(**已存在**,pi 0.99.1 已装:`bin/pi` + `install/releases`) |
| Node | v22.23.3(另验证过 v26.8.1) | **v26.8.1** ✓(better-sqlite3 v13.0.3 N-API 已验证兼容) |
| shell | bash(`TMPDIR=~/.cache/tmp` 写在 `~/.bashrc`) | zsh(macOS 默认;无 systemd 清 /tmp 问题) |
| node_modules | 排除在 bundle 外 | 已存在(324 包) |
| npm registry | 官方 | **npmmirror**(工作区 `package-lock.json` 有未提交的镜像元数据漂移:`hasShrinkwrap`/`hasInstallScript` 字段变化) |
| GitHub 推送 | PAT(`.ghp_token` / `$GITHUB_TOKEN` via `~/.bashrc`) | **已可用**(https remote,2026-10-01 `27a784d` push 实测成功,凭据已在 macOS keychain/credential helper) |
| jev skill | `~/.pi/skills/jev/`(依赖 `TYPESAFE_API_KEY`) | **不存在**(`~/.pi/skills/` 为空) |

> ⚠️ **路径映射规则**:bundle 里所有 memory/handoff 文档中的绝对路径 `/root/projects/sansheng/...` 和 `/root/.pi/agent/...`,在新机一律读作 `/Users/fuyao/projects/sansheng/...` 和 `/Users/fuyao/.pi/agent/...`。

---

## 4. 新机 `~/.pi/agent/` 实测现状(恢复前基线)

| 项 | 现状 | 与 bundle 对比 |
|---|---|---|
| `memory/MEMORY.md` | 18 行,9/29 22:06 的旧版(只有一条 delegate_task 偏好) | bundle 版 792 行(10/01 13:46)**完全取代它**(那条偏好在 bundle §"派工工具新标准" 里已有) |
| `memory/daily/`、`memory/recovery/` | 空目录 | bundle 有 3 天 daily + 1 个 recovery JSON,纯新增 |
| `extensions/` | 空 | bundle 2 个 .ts,纯新增 |
| `settings.json` | 0.99.1,**10 个 packages**(比 bundle 多 `toolflow`、`pi-mcp-adapter`,少 `@ikuma.cloud/pix-mcp`),含 `enabledModels` | **本机版更新,不要覆盖**;bundle 版仅作参考 |
| `models-store.json` | 1.9 KB(10/01 11:30,精简版) | bundle 版 22 KB 完整目录 —— 建议换用 bundle 版(先备份本机版) |
| `config/pi-task-models/config.json` | 有 `fast`/`balanced`/`frontier`/`fav?` 多 profile,`tasks: {}` | bundle 版只有 `fav` + `delegateTask → fav` 路由 —— **需手工合并**(保留本机 profiles,补上 bundle 的 tasks 映射) |
| `auth.json` | 已存在(内容未查验) | bundle 不含,`restore.sh` 也不会碰已存在的 auth.json ✓ |
| `sessions/`、`session-hoarder/` | 已存在(本机自己的) | 旧机归档不在 bundle,需要时从旧机 scp |

---

## 5. 推荐恢复步骤(针对本机实际情况)

`restore.sh` 是为"全新空机器"设计的;本机 pi 已就位、仓库已 clone,**直接整跑会有两个问题**:
1. 快照解压到 `$PWD/sansheng/` → 在仓库里套出嵌套 `sansheng/sansheng/`(冗余,源码 repo 里已有);
2. `rsync` 会用旧机 `settings.json` / `pi-task-models/config.json` 覆盖本机**更新**的版本。

所以推荐手工按项恢复(在仓库根目录执行,当前 checkout 在 `migration/setup-2026-10-01` 分支):

```bash
B=migration-bundle/pi-config-essentials
PI=~/.pi/agent

# 1) memory:先备份本机旧版,再整目录合并(daily/recovery/SCRATCHPAD 是纯新增)
cp "$PI/memory/MEMORY.md" "$PI/memory/MEMORY.md.pre-migration.bak"
rsync -a "$B/memory/" "$PI/memory/"

# 2) extensions:纯新增(本机目录为空)
rsync -a "$B/extensions/" "$PI/extensions/"

# 3) models-store.json:备份后换完整目录版
cp "$PI/models-store.json" "$PI/models-store.json.pre-migration.bak"
cp "$B/models-store.json" "$PI/models-store.json"

# 4) pi-task-models:手工合并 —— 保留本机 profiles,补 bundle 的 tasks 路由
#    bundle 版内容:profiles.fav = minimax-cn/MiniMax-M3(medium);tasks."pi-subagent/delegateTask" = "fav"
$EDITOR "$PI/config/pi-task-models/config.json"

# 5) settings.json:不覆盖。仅当需要旧机的 @ikuma.cloud/pix-mcp 时,
#    手工把这一项加进本机 packages 数组

# 6) 源码:跳过 tar 解压。确认在 master 且干净:
git checkout master && git status --short
npm ci   # 或 npm install;node_modules 已存在时可跳过,验证(§7)通过即可

# 7) auth.json:已存在,不动。自查各 provider 的 key 是否有效(尤其 minimax-cn)
```

**bundle 之外、必须手工补的**:

- **jev skill**:`~/.pi/skills/jev/`(3 primitives: noul/choice/score,需 `TYPESAFE_API_KEY` 环境变量)。**`jev-check.ts` 扩展依赖 `~/.pi/skills/jev/scripts/jev.sh` 路径**,skill 不装,扩展只会 nudge 而无法合规。从旧机 scp,或按旧机安装方式重装。
- ~~**GitHub 推送凭据**~~ ✅ 本机已可用(2026-10-01 实测 push 成功);旧机的 `.ghp_token` 未入 bundle(正确,无需迁移)。
- **TMPDIR 习惯(可选)**:旧机为防 systemd 清 `/tmp` 把 `TMPDIR=~/.cache/tmp` 写进 `~/.bashrc`;macOS 无此问题,若仍想保留习惯写 `~/.zshrc`。
- **(可选)pi 全局工具链**:本机 pi 0.99.1 已装,无需 `npm i -g @earendil-works/pi-coding-agent`。
- **(可选)旧 sessions 归档**:旧机 `~/.pi/agent/sessions/`(18M)+ `session-hoarder/`(208M),需要历史会话时 scp。

---

## 6. 已知差异与坑清单

| # | 坑 | 处置 |
|---|---|---|
| 1 | 本机 `MEMORY.md` 是 9/29 的 18 行分叉版 | 备份后由 bundle 792 行版取代(§5 步骤 1);备份文件确认无用后可删 |
| 2 | `settings.json` 双版本分叉(本机多 toolflow/pi-mcp-adapter/enabledModels,旧机多 pix-mcp) | 以本机版为主,按需手工并入 pix-mcp;**不要**用 bundle 版覆盖 |
| 3 | `pi-task-models/config.json` 双版本分叉 | 手工合并:本机 profiles + bundle tasks 路由 |
| 4 | `restore.sh` 默认行为不适配本机(嵌套解压 + 覆盖新配置) | 用 §5 手工步骤;若坚持跑脚本,先 `PI_HOME`/`PROJECT_DIR` 环境变量指好并自行跳过 settings 覆盖 |
| 5 | bundle 文档内所有 `/root/...` 绝对路径 | 读作 `/Users/fuyao/...`(§3 映射规则) |
| 6 | jev skill 不在 bundle | §5 手工补装,否则 jev-check 扩展空转 |
| 7 | `package-lock.json` 有 npmmirror 元数据漂移(未提交) | 无实质影响;可 `git checkout -- package-lock.json` 还原,或单独提交说明 |
| 8 | better-sqlite3 原生模块 | v13.0.3 N-API 在 Node 26 已验证;若新机 load 失败,`npm rebuild better-sqlite3 --build-from-source` 一次即可 |
| 9 | ~~GitHub push 凭据未配~~ | ✅ 已验证:`27a784d` 推送成功,新机凭据可用,无需再配 |
| 10 | 旧机记忆里的 `acp_delegate`/`/tmp/acp-delegate` 工作流细节 | 部分绑定 Linux/systemd 环境;新机沿用 `delegate_task isolated` 标准即可(MEMORY.md §"派工工具新标准") |

---

## 7. 恢复后验证清单

```bash
node --version                      # v26.8.1 ✓(≥22 即可)
ls ~/.pi/agent/memory/MEMORY.md     # 存在,且应为 792 行 bundle 版
ls ~/.pi/agent/extensions/          # empty-array-fix.ts + jev-check.ts
ls ~/.pi/skills/jev/scripts/jev.sh  # jev skill 就位(手工补装后)
cd /Users/fuyao/projects/sansheng
git log --oneline -1                # master = 4b280b0
npm run typecheck                   # 0 errors
npm test                            # 176/176 pass
npm run build                       # OK,dist 产物在 dist/src/server/
PI_OFFLINE=1 npm run dev            # server boot,curl :2718/api/health → 200
```

pi 侧:重启 pi(或 `/reload`)→ 确认扩展加载无报错、`jev-check` 生效、模型目录里 minimax-cn 可见。

---

## 8. 迁移完成后的待办(接 HANDOFF.md v6.4)

**项目侧**(从旧机原样交接):
1. **8 个 manual browser verification tests**(USER-only)—— `npm run dev` 后按 PLAN.md §manual-verification 在浏览器跑
2. **5 个 E2E blocker 的真实 LLM 实测** —— 目前只在 vitest fakeLlmCall 下验证过;浏览器触发 `/plan` 看 `plan_done` summary 渲染
3. 附录 B 遗留:#6 E2E `it.skip()` placeholder 补边缘 case;#7 `jev-check` slash-alts regex 误报精修(低优先);#8 把散在 MEMORY 的规则收成 AGENTS.md literal 文件

**迁移侧**(本次新增):
4. 按 §5 完成 pi 配置合并 + jev skill 补装
5. ~~配好 GitHub 推送凭据~~ ✅ 已验证(`27a784d` 已推送 origin/master)
6. 决定 `migration/setup-2026-10-01` 分支去留(bundle 建议保留在远端作为快照;本机恢复验证完毕后可不再 checkout)
7. (可选)从旧机 scp sessions 归档
8. (可选)处理 `package-lock.json` 镜像漂移(还原或提交)

---

## 9. 关键教训指针(新机开盒必读)

以下全部在 bundle 版 `MEMORY.md`(恢复到 `~/.pi/agent/memory/MEMORY.md`)里有完整记录,这里只留索引:

- **派工标准**:写代码落地到项目 = `delegate_task mode=isolated`;`acp_delegate` 只用于草稿/PoC(§"派工工具新标准")
- **jev 工作流**:选择题默认先跑 jev,conf ≥ 0.7 直接执行不再问 user;state 写满 5 段(§"Jev 使用方法论")
- **Worker SIGKILL ≠ 失败**:5min idle watchdog 常在写 report 时杀 worker,以 git 状态为准;大任务显式禁止 sub-delegation + 第一件事 commit `wip:` checkpoint(§"Worker SIGKILL on long tasks")
- **better-sqlite3 v13 N-API**:Node 升级零成本,必要时 rebuild 一次(§"better-sqlite3 v13 N-API")
- **as-any 纪律**:src/ 中 `as any` = 0,`as never` 仅 registry.ts:114 一处 jev-accepted deviation(§"as-any sweep final state")

---

## 10. 回滚

- 迁移分支随时可弃:`git checkout master`(bundle 只在 `migration/setup-2026-10-01` 上,master 不受影响)
- `~/.pi/agent/` 的两个 `.pre-migration.bak` 备份可还原本机原始 MEMORY.md / models-store.json
- 旧机数据(sessions、session-hoarder、auth.json、完整 `~/.pi`)仍在旧机原处,未做任何破坏性操作
