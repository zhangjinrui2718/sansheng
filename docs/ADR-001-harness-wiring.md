# ADR-001 · Harness 接线:让三重门控从声明变成生效

**状态**:待评审
**日期**:2026-10-03
**关联**:设计 1 §7(装配)、§10.3 阶段 5;设计 2 §2–§5

---

## 1. 为什么需要这份 ADR

设计 1 §10.3 把「BC5 接线」标为**唯一需要单独评审**的一步,理由是它改动的是
7-E / 7-H / 7-O 三批已经验证过的裁决的形状。

现在的状态是:**新的授权模型全部建好了,但没有任何东西调用它。**

| 已就位(批次 1–6) | 尚未发生 |
|---|---|
| `ROLE_SPECS` — 四个角色的 ceiling / writeKinds / clientFacing | 没有真正装配到任何 agent 会话 |
| `solveToolset()` — 三重门控求解 | 没有调用方 |
| `dispatch()` — 调用期拦截 + 32 个工具实现 | 没有调用方 |
| `MemoryPort` — 可替换记忆后端 | — |

`src/platform/**` 现在是**一座建好但没通电的工厂**。

---

## 2. 要决定的四件事

### Q1 · 会话在哪里创建?

**选项 A**:改旧的 `src/server/kernel/agentKernel.ts` 的 `createPiSession`,把
新的 `solveToolset` 结果传进去。

**选项 B**:在平台侧新建一个会话工厂(`src/platform/runtime/session.ts`),
旧的 `AgentKernel` 一行不动,继续服务旧系统。

**决策:B。**

理由与用户 2026-10-03 定的策略一致 —— **新模块独立可验证,不考虑与旧模块兼容**。
选项 A 会让「新授权模型的第一次真实运行」直接发生在旧系统的核心链路上:一旦出
问题,分不清是新模型错了还是接线错了,而且旧系统立刻不可用。选项 B 让新工厂
可以对着测试、对着一个 CLI 入口独立跑起来,验证通过再谈替换。

**代价**:过渡期存在两个会话创建点。这是可接受的 —— 它们服务的是两套互不相干
的工具与角色体系,旧的那个会在阶段 8 删除。

### Q2 · 平台工具怎么变成 SDK 的 `customTools`?

SDK 的 `ToolDefinition.execute(args, ctx: ExtensionContext)` 需要一个只有 Pi
session 里才有的 ctx;而我们的工具是纯函数,依赖全部显式注入。

**决策:写一层薄适配壳,不在工具里掺 SDK 类型。**

```
PlatformTool.run(args, ToolRunContext)       ← 纯函数,已可独立测试
        ↓ 适配壳(唯一接触 SDK 类型的地方)
ToolDefinition.execute(args, extensionCtx)   ← 从闭包取 ToolRunContext
```

适配壳**不做任何逻辑**:不校验、不兜底、不转换参数。它只把 `extensionCtx`
忽略掉,把闭包里捕获的 `ToolRunContext` 交给纯函数。

这是 7-H 教训的直接应用:

> 「不要把 SDK `ToolDefinition` 适配成 `LoopTool` —— 它的 execute 签名要求第 5 个
> 参数 `ctx: ExtensionContext`(非可选),而 llmCall 路径根本没有 session 上下文,
> 适配就得上 `as never`。正确做法是**把实现抽成纯函数**,两条路径各自包一层薄壳。」

**不变式**:适配壳里不许出现 `as never` / `as any`;一旦需要,说明逻辑漏进了壳。

### Q3 · `ToolRunContext` 谁来组装?

工具需要 `db / agent / project / now / newId / memory` 六项。这是**装配职责**,
不该散落在每个调用点。

**决策:新建 `src/platform/runtime/assembly.ts`,单一职责是「给一次调用组装 ctx」。**

```ts
buildToolContext(deps: RuntimeDeps, agentId: string, projectId: string): ToolRunContext
```

`RuntimeDeps` = db + memory port + id generator + clock。会话工厂持有一份,每次
工具调用按当前 agent 与项目组装。

**明确不做**:不做「当前项目」的隐式全局。一个 agent 可能同时在多个项目里,
`projectId` 必须显式传出 —— 这正是设计 1 §4.3 scope 门能成立的前提。

### Q4 · 旧的 harness 配置怎么办?

旧系统有:`ROLE_CEILING`、`TOOL_ENFORCEMENT`、`FACTORY_SETS`、`LEGACY_TOOL_SETS`
(`src/server/harness/tools.ts`,571 行)+ harness 写面(`apply.ts` + 备份 + 版本链)。

**决策:本阶段一行不动,原样保留。**

它们服务的是旧系统的 7 个角色与旧工具名;新系统只有 4 个角色与 41 个工具,两套
配置没有可映射关系。等阶段 8 旧系统整体删除时一起走。

**但要立刻记一笔账**:见 §5「必须补的欠账」。

---

## 3. 决策汇总

| 问题 | 决策 |
|---|---|
| 会话在哪创建 | 平台侧新建 `runtime/session.ts`,旧 kernel 不动 |
| 工具怎么进 SDK | 一层无逻辑适配壳;纯函数保持纯净 |
| ctx 谁组装 | `runtime/assembly.ts` 单一职责;项目显式传入 |
| 旧 harness 配置 | 本阶段不动,阶段 8 一起删 |

---

## 4. 落地清单

**新增**:
- `src/platform/runtime/assembly.ts` — ctx 组装
- `src/platform/runtime/sdkAdapter.ts` — PlatformTool → SDK ToolDefinition 的薄壳
- `src/platform/runtime/session.ts` — 会话工厂(建 agent session,装配工具集)

**不改**:`src/server/**` 全部

**验证方式**(这一阶段没有 UI,靠这三条):
1. 单元测试:适配壳产出的 `ToolDefinition[]` 名字集合 === `solveToolset().tools`
2. 契约测试:一个**假 SDK**(只记名字、注入假 args)跑通「装配 → 调用 → 结果」
   全链,证明工具真的挂上了
3. **不变式测试**:`solveToolset(agent).tools` 里的每一个都必须在
   `adapter(agent)` 的产出里 `TOOL_INDEX.has()` —— 这是 8-A 那条
   「集合文件声称的工具必须在池子里」的同款防线,只是搬到了新侧

第 3 条要现在写。8-A 的事故形态是「集合文件说有 13 个,循环里只有 6 个,
于是提示词教模型调不存在的工具 → 编造」;新侧同样有这个风险面,而它**只在
真正接线那一刻才暴露** —— 那正是最贵的时刻。

---

## 5. 必须补的欠账(接线时一并做,不许拖)

### 5.1 `client.*` 的传输面还没建

设计 2 里「只有业务经理能跟甲方说话」由 `ROLE_SPECS.clientFacing` 保证,但
`ask_client` / `tell_client` 两个工具**还没有实现**(它们需要 WS 传输:
提问挂起等待用户、播报投递到前端)。

**风险**:`business_manager.ceiling` 里写着 `client.ask` / `client.message`,
而工具表里没有对应实现。当前 `dispatch` 会如实报「还没建实现」—— 这是对的。
但**在接线之前必须补上**,否则接完线业务经理会发现自己的核心职责缺一块,而
系统不会崩 —— 只会静默降级。那是最难发现的一类问题。

### 5.2 「谁被卡住了」没有注入面

`asks` 有 `askedByMeOpen`,meetings 有 `pendingMeetingsFor`,但**没有任何机制
把它们送进 agent 的回合**。旧系统靠 watchdog + 事件推送。

**风险**:新模型里提问者进 blocked,而收到方**不会主动知道**有东西在等它。
不加注入面,整个升级链在真实运行中会停摆 —— 而单元测试全绿,因为它们都是
显式调用的。

**这是接线前必须解决的第二件事**,形态可以是:会话启动时把待办注入 system
prompt,或每轮检查一次。

### 5.3 调度器缺席

`listOverdueAsks` / `expireAsk` 有了,但没有东西周期性调用它们。设计 1 §12
的未决问题 #3(「周期对焦的触发方式」)也是同一件事。

**本阶段可以不做**,但必须在文档里明确:**没有调度器时,超时机制是不生效的** ——
即一个提问者可能永久停在 blocked。这属于「如实标注未接线」,不是遗漏。

---

## 6. 回滚

本阶段**不改任何旧文件**,所以回滚 = `git revert` 本批次,旧系统完全不受影响。

这是选 B(Q1)换来的最大好处:高风险步骤的爆炸半径被限制在新代码内部。

---

## 7. 评审要点

请重点确认三件事:

1. **Q1 选 B 是否同意** —— 它意味着过渡期有两套并行的会话体系。若希望更早
   收敛,可以改为「平台会话工厂就绪后立即改旧 kernel 转发」。
2. **§5.1 / §5.2 是否必须在接线前完成** —— 我判断是「必须」:它们不是优化,
   是让升级链真正转起来的前提。若认为可以先接再补,风险是接线后系统看起来
   能用但核心链路静默失效。
3. **§5.3 调度器是否接受「先不做、只如实标注」**。
