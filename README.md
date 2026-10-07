# 三生 · Sansheng

> 单用户本机常驻的 Node 服务:Pi SDK 驱动**五个角色的 agent 组织**,SQLite 持久化,
> HTTP + WebSocket + 托管前端。制品是**工件**(`artifacts` 表),不是聊天记录。
>
> Token 是工资,产出是工件。

**闭环两头都是机制,不是提示词**:立项由业务经理执行(`project_open`);交付之后
项目进入**待收货** —— 只有**甲方在界面上点出来的验收裁决**(`delivery_verdicts`)
成立,项目才谈得上收口。作者写下的 `accepted` 只表示「**定稿**」,不表示甲方点头。

**组织架构是一等数据**:`agents` / `projects` / `project_assignments` 在库里;
**角色属性在代码里**(`ROLE_SPECS`)。所以「甲方只与业务经理交互」这类边界是
**机制保证的**,不是提示词里的约定 —— 越权调用在工具层被拒绝。

## 快速开始

```bash
npm install
npm run build                 # 产出 dist/src/cli/index.js + dist/web

node dist/src/cli/index.js platform-serve
# → http://127.0.0.1:2718
```

首启没有 provider:打开界面 → 设置 → 选 Provider / Model / 填 API Key / 设工作目录。
之后在接待会话里直接说你的诉求 —— **不需要填「创建项目」表单**:立项是业务经理的
动作(它调 `project_open`),谈拢之后它会开项目,并把这段对话迁进新项目。

`npm link` 之后可以直接用 `sansheng` 命令。

## CLI

不带任何参数 = 起平台服务。

| 命令 | 作用 |
|---|---|
| `platform-serve` | 常驻宿主:HTTP + WS + 托管前端 + 调度器(默认 `127.0.0.1:2718`) |
| `platform smoke` | 真 provider 建真会话,校验「声明 vs SDK 实际激活」,并列出缺失的提示词单元 |
| `platform-run` | 真跑一个工作项(**写真实数据目录**) |
| `help` | 看全部选项 |

常用选项:`--data <目录>`(数据目录,默认 `~/.sansheng/`,`SANSHENG_DATA` 亦可)、
`--port <端口>`、`--host <地址>`、`--cwd <目录>`(代码工具的工作根)。

## 五个角色

| 角色 | 职责 | 甲方接口 |
|---|---|---|
| `business_manager` 业务经理 | 收敛诉求、立项、交付、对甲方播报 | ✅ **唯一** |
| `project_manager` 项目经理 | 拆解成工作项、推进、整合交付物,不见甲方 | — |
| `research_worker` 研究员 | 交**信息**:方案 / 架构图 / 伪代码 / 汇报材料(`html_report`) | — |
| `coding_worker` 工程师 | 交**能跑的东西**:可独立部署到 Docker 的代码服务(`code_service`) | — |
| `quality_reviewer` 质检 | 质检审查,只写 `review_finding` | — |

> 两个执行角色按**产出形态**分,不按层级分;唯一的能力差别是编码工多一个
> `code.write`。`worker` 这个名字在代码与库里都已不存在。

完整规格(ceiling / writeKinds / promptUnits / boundaryDeny)在
`src/platform/identity/role.ts` 的 `ROLE_SPECS`。增删角色 = 改那个联合 + `ROLE_SPECS`,
是一次显式代码评审。

## 工具面:三道门,只减不增

工具 = **能力 × 作用域**。判定分两个阶段,因为输入不同:

- **求解期** `solveToolset(agent, project, userToolSet?)`:ceiling 门 + scope 门。
  越权项落到 `blockedByCeiling` / `blockedByScope`,**对用户可见**(fail-closed + 可见性)。
- **调用期** `authorizeCall(...)`:`kind`(写哪种记录)与 `target`(问谁)都是**调用参数**,
  求解期根本不知道 —— 塞进求解期只会得到一个「假装校验过了」的假门。

三层工具面:

```
L1  ROLE_SPECS[role].ceiling                     代码内常量(架构上界)
L2  <dataDir>/harness/tools/{role}.json          用户可编辑的集合文件  ← 只在上界内收窄
L3  出厂集合 = L2 的初值(由 ceiling 推导,不另存名单)
```

**「升级集合」(改文件)与「解除架构约束」(改代码)是两件事。** 集合文件永远突破不了
ceiling —— 想放开上界得走代码评审。L2 的坏文件**不会**被当成空名单(那等于悄悄收回
全部权限),而是退化成出厂行为,并在成员页的「角色 harness」卡片里响亮报出「这份文件当前没有生效」。
文件名必须是 `<role>.json`;写错了不会被读取,成员页会把落空的文件名列出来。

## 提示词(harness)

- 单元内容在 `harness/system_prompts/`(**14 个唯一单元**);构建时由
  `scripts/copy-harness.mjs` 拷进 `dist/harness/` 作为**出厂副本**。
- 运行时从**数据目录**读:`<dataDir>/harness/system_prompts/{unitId}.md`。
- **新数据目录不会自动播撒出厂单元。** 用 `--data <临时目录>` 首跑时,
  `platform smoke` 会打印「声明了但盘上没有」,模型只拿到机械生成的角色简报。
  要让它生效,先把出厂单元放进 `<dataDir>/harness/system_prompts/`
  (或走成员页「角色 harness」卡片的「恢复出厂」)。
- 成员页的「角色 harness」卡片可以直接编辑单元:改前自动备份(留最近 10 份),保存后显示的是
  **后端回读**到的正文;「恢复出厂」写回出厂字节(不是删文件)。

## 开发

```bash
npm run dev        # 并发:tsx watch 起 platform-serve(2718) + vite(5173)
                   # 浏览器开 http://localhost:5173(vite 把 /api 与 /ws 代理到 2718)
```

`npm test` 是 vitest。测试用**注入 seam** 替换 SDK 边界(不需要 provider / API Key /
网络),详见 `tests/platform/session.test.ts` 的文件头。

## 验证链(改完必须全过)

```bash
npx tsc -p tsconfig.server.json --noEmit
npx tsc -p tsconfig.web.json --noEmit
npm test
npm run build
npm run check:design      # 设计文档 ↔ 代码的一致性(E1–E14)
```

`check:design` 每次核对:能力 **35** · 工具 **45**(= 38 平台 + 7 SDK 内置)·
角色 **5** · 出厂集合 **5**。改 `ROLE_SPECS`、`CAPABILITY_TOOLS` 或设计文档后它最可能红。

## 数据

- 默认数据目录 `~/.sansheng/`,库文件 `sansheng.db`(WAL)。
- 迁移在 `migrations/`:**007–010 建平台表**,**011 DROP 旧系统的 7 张表**,
  **012** 加上全局唯一的接待会话;之后逐批加平台表(最新 **028** 知识语料)。
- **两套知识存储,别混**(判据:会不会淡忘):
  · **记忆** `memory_fragments` / `memory_profile` —— 关于**用户**,模型写,会淡忘;
  · **知识语料** `knowledge_chunks` + FTS5 `knowledge_fts` —— 关于**项目 / 组织**,
    平台索引、agent **只读**(`knowledge_search` / `knowledge_read`),正文留在原处不复制。
    每条块带 `tier`(030):**定稿**(deliverable / decision / 甲方原话…)排在
    **原始材料**(evidence / 角色自己的工作叙述…)前面 —— 分级只看来源的结构化列,
    平台**不判断内容从哪来**(详见 `docs/DESIGN-KNOWLEDGE.md`)。
  设计见 [`docs/DESIGN-KNOWLEDGE.md`](docs/DESIGN-KNOWLEDGE.md)。
- 平台表**不得复用旧表名**:`CREATE TABLE IF NOT EXISTS` 撞名时静默无操作,
  新表根本建不出来。加表前先 `ls migrations/` 查名。
- **日志只走 stdout** —— `~/.sansheng/logs/sansheng.log` 恒为 0 字节,别去 tail 它。

## 文档

| 文档 | 内容 |
|---|---|
| [`AGENTS.md`](AGENTS.md) | **工作规范**(每个 DSH 会话自动注入):坐标、纪律、静默失败清单 |
| [`docs/DESIGN-PLATFORM.md`](docs/DESIGN-PLATFORM.md) | 结构、能力模型、授权、存储、运行时拓扑 |
| [`docs/DESIGN-AGENTS.md`](docs/DESIGN-AGENTS.md) | 五个角色的职责 / ceiling / 出厂集合 / 提示词单元 |
| [`docs/ADR-001-harness-wiring.md`](docs/ADR-001-harness-wiring.md) | 会话在哪建、平台工具怎么变成 SDK 的 customTools |
| [`HANDOFF.md`](HANDOFF.md) | 批次进度与历史现场 |

三份设计文档**有已知的与代码不符处**,以代码为准(文档是意图)。

> `docs/PRODUCT-DESIGN-2026-10-02.md`、`docs/CODE-REVIEW-2026-10-01.md`、
> `docs/pi-memory/**`、`MIGRATION-HANDOFF.md` 记的是**旧系统**
> (`src/server/**`,2026-10-04 清场时整体删除)。当历史读,**不要当操作手册**。
> `docs/TROUBLESHOOTING.md` 现在只留一份「已失效」说明 + 归档命令。
