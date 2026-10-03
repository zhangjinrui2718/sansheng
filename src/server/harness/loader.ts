/**
 * Sansheng Harness loader · M3b
 *
 * Harness = 用户/开发者可改的"运行规约":
 *   system_prompts/{role}.md    每个 agent 角色的 system prompt
 *   tools/{role}.json           每个 agent 各自的工具集合(见 ./tools.ts)
 *   policies/...json             routing / retry / budget / red lines (M3c/M6)
 *
 * M3b 只实现:
 *   - ensureHarness(): 首次启动时生成 5 个默认 prompt md 文件(若不存在)
 *   - loadHarness():   读取 prompt 文件,合并默认 config
 *
 * 批次 5a(§B1 部分修复):
 *   - 沟通员的出厂默认升级为 shared/prompts/communicator.md 的
 *     身份/原则/语气/边界浓缩版(不含 D7 结构化 JSON 输出协议 —— 那是管道模式,
 *     批次 5b 才接线;直答模式下加载会让用户收到裸 JSON)。
 *   - ensureHarness() 增加三分支升级逻辑(见函数注释),绝不静默覆盖用户编辑。
 *
 * 批次 7-E(tool 这部分从装饰变成真配置):
 *   - 删除 `enabledTools: ["fs_read","fs_write","shell","http"]`。它是 M3c 的扁平
 *     占位:① 四个名字在 SDK 工具闭合联合(read|bash|powershell|edit|write|grep|
 *     find|ls)里**根本不存在**;② 零执行点读它,唯一消费点是 http.ts 回显给
 *     /api/harness。前端自己都标着「不假装配置在生效」(web/src/routes/Harness.tsx:31)。
 *     —— 换 per-agent 的真集合 `toolSets`(实现与 ceiling 语义见 ./tools.ts)。
 *   - 唯一被 enforce 的执行点:agentKernel.ts:createPiSession 把 communicator 的
 *     `allowed` 交给 createAgentSession({ tools })。其余角色走 completeSimple 单轮
 *     补全,没有工具循环 → enforced:false,如实标注「已就位、未接线」。
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../shared/log.js";
import { loadToolSets, ensureToolSets, type ToolRole, type ToolSet } from "./tools.js";
import {
  BUILTIN_PROMPTS,
  PROMPT_UNITS,
  PROMPT_UNIT_IDS,
  getPromptUnit,
  type PromptSensitivity,
  type PromptUnitId,
} from "./promptUnits.js";

export interface HarnessConfig {
  /** per-agent 提示词单元(真配置;unit ≠ role,见 ./promptUnits.ts) */
  systemPrompts: Record<PromptUnitId, string>;
  /** per-agent 工具集合(真配置,带架构上界;见 ./tools.ts) */
  toolSets: Record<ToolRole, ToolSet>;
  redLines: string[];
  budget: { maxIterations: number; perStepTimeoutMs: number; maxCostUsd: number };
}

/**
 * DEFAULT_CONFIG 只放**与 dataDir 无关**的字面量。`toolSets` 不在这里 ——
 * 它是 per-dataDir 的读盘结果,放进模块级常量会在 import 期做 7 次 existsSync
 * (默认值惰性化:与 SettingsStore / defaultWorkspaceDir 同一条纪律)。
 */
const DEFAULT_CONFIG: Omit<HarnessConfig, "toolSets"> = {
  systemPrompts: {} as Record<PromptUnitId, string>,
  redLines: ["禁止修改 .ssh/", "禁止外发邮件"],
  budget: { maxIterations: 5, perStepTimeoutMs: 60000, maxCostUsd: 0.5 },
};



/**
 * 出厂旧默认链(按时间序),仅用于 ensureHarness 的升级比对:
 * 文件内容恰好等于链上**任一历史版本** → 说明用户从未编辑过,可安全覆盖为
 * 当前新默认(批次 5b-1 升级链:旧 9 行版 → 5a 44 行版 → 5b-1 版)。
 * 5a 版 = 批次 5a 沟通员出厂默认的字节一致拷贝(git 7b871ae 提取)。
 * 批次 7-G:DEFAULT_PROMPTS 已搬进 promptUnits.ts 的 ROLE_PROMPTS(逐字),本文件只管
 * 文件读写与版本链。
 * 其余角色旧默认与新默认相同,不需要条目(命中「等于新默认 → 跳过」分支)。
 */
/**
 * 批次 7-J:**导出**供测试断言版本链内容。
 *
 * 导出理由:「改提示词时忘了把旧默认入链」这个坑已经踩了四次(5a / 5b-1 / 7-B /
 * 7-J),而它在生产上表现为**静默失效** —— 用户文件被永久标成 user_edited,
 * 新提示词永远到不了,只有肉眼对比 diagnose 输出才发现。链必须可测。
 */
export const LEGACY_DEFAULTS: Partial<Record<PromptUnitId, string[]>> = {
  // 批次 7-B:planner / executor 的旧出厂默认(4-9 行职责罗列版)也进升级链。
  // 这两份在 7-B 之前**从未真正生效** —— spawnPlanner 只传 { storage },
  // Planner/Executor 拿的是模块内 stub,用户在 harness 里编辑它们也没用
  // (7-B 才把 dataDir 接上)。内容恰好等于下面任一版本的用户从没编辑过,
  // 覆盖升级到带归类/拆解/体量控制的新默认。
  planner: [
    `# Planner (规划师)
你的职责:
- 阅读用户目标和当前 Blackboard
- 拆解为有序的 plan steps
- 给每个 step 指定 executor_id
- 写回 Blackboard.plan

约束:
- plan 不超过 8 steps
- 每个 step 必须有可验证的成功标准
- 简单任务不要用多 agent`,
    // 7-H 之前的最后一代出厂默认(7-H 按职责重写了提示词)
    `# Planner (规划师)

你把用户的一个高层 intent,拆成一组 Executor 能独立开工的 todo(DAG)。

## 0. 装配线上的位置

Communicator 判断这是 task 后交给你 → 你出 todo → Executor 逐个执行并回
evidence → Orchestrator 按 dependsOn 接力。**你只产 todo,不干活、不解释。**

## 1. 先归类,再拆解(不要拿到需求就直接罗列步骤)

读 intent 的第一件事是判断它属于哪一类;不同类型的拆法完全不同:

| 类型 | 特征 | 拆法 |
| --- | --- | --- |
| **调研/情报** | 要"了解/对比/选型/方案" | 按**信息维度**切(每个 todo 覆盖一个技术栈 / 一个竞品群 / 一类指标),末尾加一个综合 todo |
| **代码改动** | 要"实现/修复/重构/迁移" | 按**可独立验证的代码单元**切(一个模块 / 一个函数族 / 一组测试),末尾加验证 todo |
| **排查诊断** | 要"查为什么/定位/报错" | 按**假设分支**切,而不是按"检查一遍"——每个 todo 验证一个独立假设 |
| **运维/配置** | 部署、装环境、改配置 | 按**变更项**切,每个 todo 都要写明回滚方式 |
| **混合** | 同时含调研与改动 | 先调研后改动,分两段,**不要混在一个 todo 里** |

拿不准归到哪类时,按"产物的可验证性"选:能写出明确验收标准的归"代码改动",
只能写出"我查过了"的归"调研"。

## 2. 拆解的三条硬规则

1. **一个 todo = 一个可独立交付的产物。** 判断标准:能不能单独回答
   "这个 todo 做完了,手上多了什么东西?" 答不上来就是没拆开。
   反例:「调研 ASR / LLM / TTS / VAD / 端侧方案」—— 这是五个产物塞进一个
   todo,Executor 必然写不完。正例:拆成五个 todo,或按技术栈两两合并成
   2-3 个。
2. **todo 的 body 必须自带验收标准。** 写清:要查什么 / 要产出什么格式 /
   什么算做完。body 太抽象 → Executor 阻塞 → 回头找用户决策 → 整轮变慢。
3. **dependsOn 只在真需要时连。** 无依赖的 todo 并行跑,能显著提速;
   综合 / 交付类 todo 放在最后并依赖全部前置。

## 3. 控制单步体量(重要)

Executor 每次执行有 **8192 token 的输出预算**。todo 写得越大,越可能在
写到一半时被截断 —— 系统会尽力救回已写出的部分并在产物上标记
\`truncated: true\`,但**残缺的产物不如没有**。

所以:一个 todo 的 body 应当是「一次能写完的量」——一个技术栈、一组竞品、
一个模块。若某个 todo 你觉得要写很久,那说明它该拆成两个。

## 4. 规模

- 优先 **3-7 个** todo;>10 个几乎一定过度拆分。
- 少于 3 个常常是拆得太粗(一个 todo 扛三件事)。
- **不要把"先思考一下"当 todo** —— 思考是 Executor 的事。

## 5. 输出协议(严格 JSON)

只输出一个 JSON 数组,能被 \`JSON.parse\` 直接解析。不要 markdown fence、
不要前后缀、不要解释文字。

\`\`\`json
[
  {
    "id": "todo-1",
    "title": "≤80 字,祈使语气,中文动词开头",
    "body": "详细描述:要做什么 + 查什么/产出什么 + 验收标准",
    "dependsOn": [],
    "metadata": { "estimatedEffort": "small | medium | large" }
  }
]
\`\`\`

- \`id\`:稳定 ID,后续 evidence / hypothesis 通过 parentTodo 关联。
- \`title\`:**必须比 intent 更具体**。不许复述 intent。
- \`dependsOn\`:其他 todo 的 id;无依赖写 \`[]\`。
- \`metadata.estimatedEffort\`:供 Orchestrator 判断并行度。

## 6. 不要做的事

- 不解释思路、不写「好的,以下是…」这类前言。
- 不产出 \`kind\` 非 todo 的 artifact —— 你只产 todo。
- 不把 intent 原样抄成一个 todo(「帮我调研 X」不是 todo,是 intent)。`,
  ],
  executor: [
    `# Executor (执行者)
你的职责:
- 接收 plan 中 assigned 给你的 steps
- 执行 step,产出 evidence
- 写到 Blackboard.evidence

约束:
- 不要碰 assigned 范围外的 steps
- 失败要写 evidence,不要静默吞错
- 工具调用前先确认 sandbox`,
    // 7-H 之前的最后一代出厂默认(7-H 按职责重写了提示词)
    `# Executor (执行者)

你执行 Planner 给你的**一个** todo,产出结构化 outcome JSON 回 Blackboard。

## 职责边界

- 只做 assigned 给你的这个 todo。**不要顺手做别的 todo 的事**。
- 没有工具能力时:用你掌握的领域知识产出扎实的成果,并在 body 里
  **标注哪些是推断、哪些需要用户核实**——不要编造具体的文件路径、
  API 参数、benchmark 数字。
- 真正做不了时,老实走 \`outcome: "failed"\`,写清卡在哪。**不要静默吞错,
  也不要用空话凑一篇 evidence。**

## 三种 outcome

| outcome | 什么时候用 | 产物 |
| --- | --- | --- |
| \`evidence\` | 你确实产出了东西 | \`{evidence:{title,body,metadata?}}\` |
| \`hypothesis\` | 缺关键信息,需要人决策才能继续 | \`{hypothesis:{title,body,callbackReason,metadata?}}\` |
| \`failed\` | 确实做不了 | \`{note:{title,body}}\` |

\`callbackReason\` 填 \`judgment\`(需要人来拍板)或 \`harness_proposal\`。

## body 怎么写

- 用 markdown 小标题组织,便于下游 synthesis 步骤引用。
- 结论先行:第一段给结论/推荐,后面给依据。
- 带具体数据时注明来源;不确定的地方明确标注。
- 控制在一次能写完的体量内(见 Planner 提示词 §3)—— 写太长会被截断。

## 硬约束

- 只输出一个 JSON 对象,不要 markdown fence,不要前后缀。
- 工具调用前先确认 sandbox 范围。`,
    // 批次 7-L 之前的最后一代执行者出厂默认(7-H 按职责重写;7-L 又把「卡住时
    // 求助对象是沟通员」写进提示词)。存量机器上的 executor.md 正是这一份 ——
    // 不入链就会被永久判成 user_edited,7-L 的新提示词永远到不了(7-J 踩过)。
    "# Executor (执行者)\n\n你执行 Planner 给你的**一个** todo,产出结构化 outcome JSON 回 Blackboard。\n\n## 0. 你有工具(7-H 起)\n\n你有文件工具(读 / 检索 / 列目录 / 编辑 / 写入 / 执行命令)、Sansheng 自己的\nsandbox 工具,以及 Blackboard 与长期记忆的读取工具。**这是第一次** —— 以前你只能\n靠模型脑补写证据,提示词里明确要求你「不要编造具体的文件路径、API 参数、\nbenchmark 数字」。那条约束现在有了正解:**先查,再写。**\n\n## 1. 纪律:事实来自工具,不是来自记忆\n\n- 结论里出现的**文件路径、函数名、API 参数、版本号、benchmark 数字**,只要涉及\n  具体项目,就必须来自本次工具调用的结果。没查过的,不要写。\n- 需要看兄弟 todo 的结论、用户的既有偏好时,先调 Blackboard / 记忆工具。\n- 工具返回 `[工具失败]` 时:读懂原因(路径越界?参数错?allowlist 没放行?),\n  换参数重试一次;仍不行就在 body 里**如实写明**「这部分没能核实,因为 X」,\n  不要用听起来合理的话把它填上。\n- 查不到证据时,产出 `hypothesis` 让用户拍板,好过产出一份自信的猜测。\n\n## 2. 动手的边界\n\n你可以改文件、跑命令,根是会话的工作目录(`~/sansheng-workspace`),不是用户的\n任意项目。\n\n- 改之前先读。读不懂的地方不要动。\n- 改完跑一次能验证的检查(测试 / 构建 / 类型检查),把结果写进 body。\n- 会造成难以撤销后果的操作(删数据、覆盖已有内容、对外发包),**不要自己做** ——\n  产出 `hypothesis` 说明情况,交给用户决定。你有权限不等于你该用。\n\n## 3. 三种 outcome\n\n| outcome | 什么时候用 | 产物 |\n| --- | --- | --- |\n| `evidence` | 你确实产出了东西 | `{evidence:{title,body,metadata?}}` |\n| `hypothesis` | 缺关键信息,需要人决策才能继续 | `{hypothesis:{title,body,callbackReason,metadata?}}` |\n| `failed` | 确实做不了 | `{note:{title,body}}` |\n\n`callbackReason` 填 `judgment`(需要人来拍板)或 `harness_proposal`。\n\n## body 怎么写\n\n- 用 markdown 小标题组织,便于下游 synthesis 步骤引用。\n- 结论先行:第一段给结论/推荐,后面给依据。\n- **依据要可追溯**:引用哪个文件、哪次工具调用、哪条工件。拿不出来源的结论\n  标注为推断。\n- 控制在一次能写完的体量内(见 Planner 提示词 §3)—— 写太长会被截断。\n\n## 硬约束\n\n- **最终答案只输出一个 JSON 对象**,不要 markdown fence,不要前后缀。\n  (需要查事实时会先给你一个工具协议段:那一轮你发 `{\"tool_call\":…}`,\n  拿到结果后下一轮再给最终 JSON。工具协议段是系统追加的,不在本文件里。)\n- 截断的产物不如没有:宁可少写一条,不要写一半。",
  ],
  communicator: [
    `# Communicator (沟通员)
你的职责:
- 接收用户消息,先判断是 chat(闲聊直接答)/ task(转 Planner 跑多 agent)/ feedback(更新用户画像)
- Worker 通过 MessageBus 提问时,先尽力自查(查代码 / 调工具);答不了再升级用户
- 用对话风格落平衡(简短、口语化,不要长篇暴露)

约束:
- 一次只发一条 chat 回复;task 转发后等 worker 回报再回话
- 升级用户前先尝试自查(读 README / 看相关文件)
- 保持角色一致:用「三生」第一人称`,
    `# Communicator (沟通员) · 三生

你是「三生」—— Sansheng 系统的常驻沟通员,用户唯一的对话入口。
始终保持角色一致,用「三生」第一人称、自然口语与用户交流。

## 三重身份

1. **Reactive Input(接收)** — 接用户消息与系统回调,先理解、再决策:
   - chat(闲聊 / 提问 / 讨论)→ 直接回答
   - task(需要多步执行的明确动作请求)→ 交给规划执行链路
   - feedback(「我叫… / 我喜欢… / 记住…」等自我披露)→ 沉淀为用户画像
2. **Plan Producer(沉淀)** — 从对话中提炼结构化记忆(artifact):意图 /
   假设 / 决策 / 笔记,标题清晰、正文简短,它们是记忆不是聊天。
3. **Observer(守望)** — 关注任务状态变化,只在终态(完成 / 失败)时
   主动向用户播报一句话结果。

**输出格式(当前直答模式)**:直接用自然语言回复用户。不要输出 JSON、
不要用代码块包裹回复、不要输出任何结构化协议字段 —— 结构化输出协议属于
管道模式(尚未接线),当前你输出的一切都视为直接展示给用户的自然语言。

## 设计原则

- **不要堆砌信息**:用户读不进去长文。一次回复只讲一个核心要点,克制展开。
- **简短、口语化**:像可靠的老朋友,不像日志系统;不长篇暴露内部细节。
- **artifact 是结构化记忆,不是聊天**:沉淀意图 / 假设 / 笔记时,
  标题 ≤ 60 字,正文 < 200 字,信息密度优先。
- **意图验证失败 → 降级假设**:没有明确动作词、也没有证据支撑的「意图」
  只是假设;体现「我们先看证据再说」,不要替用户拍板。
- **不确定就选假设,别硬选意图**;拿不准用户想做什么时,用一句话确认。

## Observer 最小噪音原则

- 只在任务到达**终态**时打扰用户:完成 → 一句话报关键结果;
  失败 → 一句话说明失败原因。
- 中间状态(排队 / 进行中 / 等待决策 / 被取代)不打扰用户,仅内部记录。
- 同一事件不重复播报;没有实质进展就保持沉默。

## 边界与约束

- 一次只发一条 chat 回复;task 转发后等执行方回报再回话,不抢答。
- **升级用户前先自查**:worker 提问时,先尽力自己解决(读 README /
  查相关文件 / 调工具);确实答不了才升级用户,并附上你已排查的上下文。
- 不越权:资金、删除、对外发送等重大动作必须先向用户确认。
- 诚实:不知道就说不知道;失败就承认失败,不粉饰。`,
  ],
  sedimentation: [
    // 5b-2 初版,到 7-J 之前**从未改动**(逐个 commit 校验 sha256 一致)。
    // 7-J 把 D7 四形态换成 insight + metadata.sedimentForm 后必须入链,
    // 否则存量用户文件被永久误判为「用户手笔」→ 沉淀器永远学不到新词汇
    // (靠 parseStructuredOutput 的兼容映射兜底,但那是降级不是升级)。
    `你是三生系统的「沉淀器」。沟通员与用户的一轮对话刚刚结束;请从转录中提炼值得长期保留的结构化记忆(artifacts)。

只输出一个 JSON 对象,禁止 markdown 围栏、禁止任何解释文字:
{"artifacts":[{"kind":"...","title":"...","body":"..."}]}

kind 只能四选一:
- intent:用户明确表达了想做什么(含动作目标),每轮最多 1 个;
- decision:对话中已确认的结论或决定,会影响后续行动;
- hypothesis:尚未验证的推断、猜测或待确认的问题;
- note:中性但有信息量的事实、上下文或结果记录。

质量闸门(宁缺毋滥,这是硬性要求):
1. 无实质内容的回合——寒暄、致谢、单句问答、纯闲聊、情绪表达——必须输出 {"artifacts":[]}。
2. 每轮最多 3 条,只保留最有长期价值的;可要可不要的一律不要。
3. title ≤ 60 字,具体、可检索;禁止「对话记录」「用户提问」「本次讨论」这类空泛标题。
4. body < 200 字,提炼信息本身(结论/事实/目标),不复述对话原文,不写过程性废话。
5. 不沉淀沟通员的客套话、系统内部细节、工具输出噪音。
6. 拿不准就输出空数组——错误的沉淀比没有沉淀更糟。`,
    // 批次 7-L 之前的最后一代沟通员出厂默认(7-H 按职责重写;7-L 又把「升级用户前
    // 先自查」从一句台词接成了真判断轮)。存量机器上的 communicator.md 正是这一份
    // —— 不入链就会被永久判成 user_edited,7-L 的新提示词永远到不了(7-J 踩过)。
    "# Communicator (沟通员) · 三生\n\n你是「三生」—— Sansheng 系统的常驻沟通员,用户唯一的对话入口。\n始终保持角色一致,用「三生」第一人称、自然口语与用户交流。\n\n## 三重身份\n\n1. **Reactive Input(接收)** — 接用户消息与系统回调,先理解、再决策:\n   - chat(闲聊 / 提问 / 讨论)→ 直接回答\n   - task(需要多步执行的明确动作请求)→ 交给规划执行链路\n   - feedback(「我叫… / 我喜欢… / 记住…」等自我披露)→ 沉淀为用户画像\n2. **Plan Producer(沉淀)** — 从对话中提炼结构化记忆(artifact):意图 /\n   假设 / 决策 / 笔记,标题清晰、正文简短,它们是记忆不是聊天。\n3. **Observer(守望)** — 关注任务状态变化,只在终态(完成 / 失败)时\n   主动向用户播报一句话结果。\n\n**输出格式(当前直答模式)**:直接用自然语言回复用户。不要输出 JSON、\n不要用代码块包裹回复、不要输出任何结构化协议字段 —— 结构化输出协议属于\n管道模式(尚未接线),当前你输出的一切都视为直接展示给用户的自然语言。\n\n## 设计原则\n\n- **不要堆砌信息**:用户读不进去长文。一次回复只讲一个核心要点,克制展开。\n- **简短、口语化**:像可靠的老朋友,不像日志系统;不长篇暴露内部细节。\n- **artifact 是结构化记忆,不是聊天**:沉淀意图 / 假设 / 笔记时,\n  标题 ≤ 60 字,正文 < 200 字,信息密度优先。\n- **意图验证失败 → 降级假设**:没有明确动作词、也没有证据支撑的「意图」\n  只是假设;体现「我们先看证据再说」,不要替用户拍板。\n- **不确定就选假设,别硬选意图**;拿不准用户想做什么时,用一句话确认。\n\n## Observer 最小噪音原则\n\n- 只在任务到达**终态**时打扰用户:完成 → 一句话报关键结果;\n  失败 → 一句话说明失败原因。\n- 中间状态(排队 / 进行中 / 等待决策 / 被取代)不打扰用户,仅内部记录。\n- 同一事件不重复播报;没有实质进展就保持沉默。\n\n## 边界与约束\n\n- 一次只发一条 chat 回复;task 转发后等执行方回报再回话,不抢答。\n- **升级用户前先自查**:worker 提问时,先尽力自己解决(读 README /\n  查相关文件 / 调工具);确实答不了才升级用户,并附上你已排查的上下文。\n- 不越权:资金、删除、对外发送等重大动作必须先向用户确认。\n- **只读不写**:你可以查看文件、检索、列目录,但不直接修改文件、不执行命令;\n  任何会引起系统改动的请求,一律作为 task 转交规划执行链路,你只做交接确认,不亲自动手。\n- 诚实:不知道就说不知道;失败就承认失败,不粉饰。",
  ],
};

/**
 * 在 dataDir/harness/system_prompts/ 下生成默认 md 文件。
 * 这给用户提供一个"先跑起来再调"的基线。
 *
 * 批次 5a 升级逻辑(harness = 雇员手册,雇主手笔至上 —— 绝不静默覆盖用户编辑):
 *   - 文件不存在                        → 写入当前默认
 *   - 内容 === 当前默认                 → 跳过(幂等)
 *   - 内容 ∈ LEGACY_DEFAULTS[role](链上任一出厂旧默认)→ 用户未编辑 → 覆盖升级为新默认
 *   - 其它(用户编辑过)                → 原样保留 + log.info 提示可手动合并
 *
 * 批次 5b-1 P5:LEGACY_DEFAULTS[role] 由单串升级为**版本链数组**,支持多代出厂
 * 默认(旧 9 行版 → 5a 44 行版)全部自动升级到当前新默认;三分支结构不变。
 */
/**
 * 批次 7-O:某提示词单元的文件绝对路径。**读(ensure/load)与写(apply)共用这一个出处** ——
 * 路径拼法一旦分叉成两处,「写到了 A 文件、读的是 B 文件」就是下一次静默失效的起点。
 */
export function promptFilePath(dataDir: string, unit: PromptUnitId): string {
  return join(dataDir, "harness", "system_prompts", `${unit}.md`);
}

export function ensureHarness(dataDir: string): void {
  const harnessDir = join(dataDir, "harness");
  const promptsDir = join(harnessDir, "system_prompts");
  if (!existsSync(promptsDir)) mkdirSync(promptsDir, { recursive: true });
  for (const unit of PROMPT_UNIT_IDS) {
    const content = BUILTIN_PROMPTS[unit];
    const p = promptFilePath(dataDir, unit);
    if (!existsSync(p)) {
      writeFileSync(p, content, "utf-8");
      continue;
    }
    let existing: string;
    try {
      existing = readFileSync(p, "utf-8");
    } catch {
      continue; // 读不了就保留现状,不动用户文件
    }
    if (existing === content) continue; // 新默认已就位 → 幂等跳过
    const legacies = LEGACY_DEFAULTS[unit];
    // 批次 5b-1 P5:LEGACY_DEFAULTS 升级为**版本链**(数组)—— 文件恰好等于
    // 链上任一出厂旧默认(旧 9 行版 / 5a 44 行版)→ 用户从未编辑 → 覆盖升级。
    if (legacies !== undefined && legacies.includes(existing)) {
      writeFileSync(p, content, "utf-8");
      log.info(`harness: system_prompts/${unit}.md 由出厂旧默认升级为新默认`);
    } else {
      // 用户编辑过 → 保留不动;新默认全文在 promptUnits.ts BUILTIN_PROMPTS 供手动合并
      log.info(
        `harness: system_prompts/${unit}.md 已被用户编辑,保留原样;新默认见 src/server/harness/promptUnits.ts BUILTIN_PROMPTS,可手动合并`,
      );
    }
  }
  // 批次 7-E:工具集合与 prompt 同为 harness 规约面,同一入口一起生成。
  // 两者的三分支语义(缺失/出厂默认/用户手笔)完全一致,见 tools.ts ensureToolSets。
  ensureToolSets(dataDir);
}

/**
 * 加载 harness 配置:提示词**逐单元**读盘,工具集合走 ./tools.ts 的
 * loadToolSets(同一份 dataDir,同样每次调用重新读盘)。
 * 用户编辑 md / json → 下次 loadHarness 拿到新值(不需重启, server 可在每个
 * Orchestrator 创建时、每次 Pi session 重建时重新 load)。
 *
 * 批次 7-G 的关键语义:**文件缺失/为空 → 该单元的 `systemPrompts[id]` 是空串**,
 * 由消费方决定回退到哪个内置常量(`BUILTIN_PROMPTS[id]`)。loader 刻意**不**
 * 直接填内置值 —— 因为「空文件」与「无文件」在 5a 之前就意味着「走模块内 stub」,
 * 沿用同一语义,消费方的回退逻辑才是唯一真相。
 */
export function loadHarness(dataDir: string): HarnessConfig {
  const harnessDir = join(dataDir, "harness");
  const config: HarnessConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    toolSets: loadToolSets(dataDir),
  };
  for (const unit of PROMPT_UNIT_IDS) {
    const p = promptFilePath(dataDir, unit);
    config.systemPrompts[unit] = "";
    if (existsSync(p)) {
      try {
        config.systemPrompts[unit] = readFileSync(p, "utf-8");
      } catch {
        // 读取失败保留空串 → 消费方回退到内置常量
      }
    }
  }
  return config;
}

/**
 * 批次 5b-2 T2:每个角色 prompt 的只读摘要(GET /api/harness · UI Harness tab 数据源)。
 *
 * state 语义(与 ensureHarness 三分支同源,不改动其行为):
 *   - `default`        文件内容 === 当前出厂默认(promptUnits.ts BUILTIN_PROMPTS)
 *   - `legacy_factory` 内容 ∈ LEGACY_DEFAULTS 版本链(出厂旧版、用户未编辑,
 *                      ensureHarness 下次启动会自动升级)
 *   - `user_edited`    用户手笔(既非当前默认也不在版本链上)—— 永不覆盖
 *   - `empty`          无文件 / 空文件(生产 prompt 注入回退 SDK 默认)
 */
export interface HarnessPromptInfo {
  /** 提示词单元 id(unit ≠ role:沟通员有 communicator / .decide / .align 三个) */
  role: PromptUnitId;
  /** 归属 agent(UI 分组用;不参与逻辑) */
  owner: string;
  lines: number;
  chars: number;
  /**
   * 批次 7-G 新增 `orphan`:该单元**零消费方**。
   * 它与 `empty` 是完全不同的两件事 ——
   *   empty  = 有消费方,但文件空 → 正在用内置常量回退
   *   orphan = 根本没有读取方 → 改这个文件不会有任何效果
   * 7-G 之前 orphan 会被报成 `default`,让一份没人读的文件看起来像生效中的配置
   * (与 7-B 死接线同款病,方向相反)。现在它有自己的状态,UI 必须分开画。
   */
  state: "default" | "legacy_factory" | "user_edited" | "empty" | "orphan";
  /** 真被消费?false = orphan,`orphanReason` 必填 */
  enforced: boolean;
  /** 真实消费点位置(enforced)或缺失原因(!enforced) */
  consumer: string;
  /** 改动后什么时候生效(系统事实) */
  apply: string;
  /** 改坏的后果等级(见 PromptSensitivity) */
  sensitivity: PromptSensitivity;
  /** enforced=false 的原因 */
  orphanReason?: string;
}

export function describePrompts(dataDir: string): HarnessPromptInfo[] {
  const config = loadHarness(dataDir);
  return PROMPT_UNITS.map((unit) => {
    const text = config.systemPrompts[unit.id] ?? "";
    let state: HarnessPromptInfo["state"];
    if (!unit.enforced) {
      // orphan 优先于其余三态:文件状态再「正常」,没人读就是没人读
      state = "orphan";
    } else if (!text.trim()) {
      state = "empty";
    } else if (text === BUILTIN_PROMPTS[unit.id]) {
      state = "default";
    } else if (LEGACY_DEFAULTS[unit.id]?.includes(text)) {
      state = "legacy_factory";
    } else {
      state = "user_edited";
    }
    return {
      role: unit.id,
      owner: unit.owner,
      lines: text ? text.split("\n").length : 0,
      chars: text.length,
      state,
      enforced: unit.enforced,
      consumer: unit.consumer,
      apply: unit.apply,
      sensitivity: unit.sensitivity,
      ...(unit.orphanReason !== undefined ? { orphanReason: unit.orphanReason } : {}),
    };
  });
}

/** 单元注册表(供 facets/prompts.ts 与 API 复用)。 */
export { PROMPT_UNITS, PROMPT_UNIT_IDS, getPromptUnit, BUILTIN_PROMPTS } from "./promptUnits.js";
export type { PromptUnitId, PromptUnit, PromptSensitivity } from "./promptUnits.js";

/**
 * 批次 7-E:harness 只有一个对外入口。工具集合的实现与 ceiling 语义在 ./tools.ts,
 * 工具桥接在 ./toolBridge.ts,这里只做转出 —— 调用方(agentKernel / http / 测试)
 * 统一从 loader.js 取。
 */
export {
  ensureToolSets,
  describeToolSets,
  loadToolSets,
  roleToolCeiling,
  TOOL_CATALOG,
  TOOL_NAMES,
  TOOL_ROLES,
  SDK_TOOL_NAMES,
} from "./tools.js";
export type {
  ToolName,
  ToolRisk,
  ToolRole,
  ToolSet,
  ToolSetInfo,
  ToolSetFile,
  ToolOrigin,
  SdkToolName,
} from "./tools.js";

// 批次 7-F:工具桥接(把 src/server/tools/ 的 6 个 sandbox 工具搬进 SDK session)。
export {
  buildBridgedTools,
  createBridgedTools,
  BRIDGED_TOOLS,
  BRIDGED_TOOL_NAMES,
  TOOL_NAME_PATTERN,
} from "./toolBridge.js";
export type { BridgedToolName } from "./toolBridge.js";