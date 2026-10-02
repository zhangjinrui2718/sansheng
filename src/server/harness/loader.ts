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
const LEGACY_DEFAULTS: Partial<Record<PromptUnitId, string[]>> = {
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
export function ensureHarness(dataDir: string): void {
  const harnessDir = join(dataDir, "harness");
  const promptsDir = join(harnessDir, "system_prompts");
  if (!existsSync(promptsDir)) mkdirSync(promptsDir, { recursive: true });
  for (const unit of PROMPT_UNIT_IDS) {
    const content = BUILTIN_PROMPTS[unit];
    const p = join(promptsDir, `${unit}.md`);
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
    const p = join(harnessDir, "system_prompts", `${unit}.md`);
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