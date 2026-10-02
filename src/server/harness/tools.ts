/**
 * Sansheng Harness · 工具集合(tool sets)
 *
 * 定位:与 `system_prompts/{role}.md` 并列的 harness 规约面 —— **每个 agent 一套
 * 各自的工具集合**,放在 `~/.sansheng/harness/tools/{role}.json`,用户可编辑,
 * 未来 harness 层的持续优化 = 升级这套集合(而不是改散落在各处的硬编码字面量)。
 *
 * ── 为什么拆成「ceiling / collection」两层 ──────────────────────────────
 * 批次 5b-1 P3 有一条已生效的架构裁决(jev A 方案 conf 1.00):**沟通员从机制上
 * 杜绝直接干活**,一切改动类请求走 decide=task → 规划执行链路。原先这条约束由
 * `agentKernel.ts` 里一个硬编码字面量 `tools: ["read","grep","find","ls"]` 承载。
 *
 * 如果「工具集合」只是一张用户可写的名单,用户往 communicator.json 里加一行
 * `"bash"` 就能把那条架构裁决推翻 —— 权限面不能这样。所以:
 *
 *   ceiling(本文件 ROLE_CEILING,代码内)   架构允许的上界。**集合文件突破不了。**
 *   collection(harness/tools/{role}.json)  上界内可自由增减的用户意图。
 *
 * 「升级工具集合」与「解除架构约束」因此是两种不同的动作:前者改文件,后者改
 * ROLE_CEILING(一次显式的代码评审)。这个分离是本模块存在的理由。
 *
 * ── 覆盖范围(2026-10-03 现状,不是「应该有什么」) ──────────────────────
 * 本仓的 LLM 出口只有两类,工具面状况因此是硬事实而非选择:
 *
 *   ① Pi session(kernel/agentKernel.ts:createPiSession → createAgentSession)
 *      —— **有**工具循环,`tools` allowlist 是机制级硬约束
 *      (agent-session.js _refreshToolRegistry 的 isAllowedTool)。
 *   ② completeSimple 单轮补全(ws.ts:191 makeLlmCall → planner / executor;
 *      harnessBoot.ts:132 → harness_manager;sedimentation.ts:236 → 沉淀)
 *      —— **没有**工具循环,送进去的只有 systemPrompt + messages。
 *
 * 所以今天 `enforced: true` 的只有 communicator 一个角色。其余角色的集合文件
 * 会照常生成、可编辑、有 ceiling 兜底,但 `enforced: false` —— **如实标注
 * 「已就位、未接线」,而不是写一份假装生效的名单**。这正是旧 `enabledTools`
 * 字段(`loader.ts` 的 `["fs_read","fs_write","shell","http"]`)的老毛病:那四个
 * 名字在 SDK 的工具闭合联合里根本不存在,却摆在 /api/harness 里像个配置项。
 *
 * ── 接线清单(把某个角色从 enforced:false 翻成 true 需要做的) ──────────
 *   1. 让该角色的 LLM 出口走 Pi session,或给它建一个最小工具循环
 *      (executor/planner 改 `ExecutorLlmCall` / `PlannerLlmCall` 签名是主链路
 *       改动 —— 多轮 + JSON 输出协议要对齐 + abort 语义(C2 注释:llmCall 不可中断)).
 *   2. 在 createAgentSession({ tools }) 处传入 `loadToolSets(dataDir)[role].allowed`。
 *   3. 把 TOOL_ENFORCEMENT[role].enforced 翻成 true,enforceBasis 写成真实位置。
 *   4. 把 FACTORY_SETS[role] 改成期望的出厂集合,并把旧值追加进
 *      LEGACY_TOOL_SETS —— 否则存量用户文件会被误判为「用户编辑过」永不升级
 *      (与 loader.ts 的 LEGACY_DEFAULTS 版本链同一个坑,批次 5a/5b-1/7-B 踩过三次)。
 *
 * ── SDK 事实(node_modules/@earendil-works/pi-coding-agent@0.87.1) ──────
 *   - `ToolName` = "read"|"bash"|"powershell"|"edit"|"write"|"grep"|"find"|"ls"
 *     (闭合联合,core/tools/index.d.ts 的 allToolNames);`createReadOnlyTools`
 *     = read/grep/find/ls,`createCodingTools` = read/bash/edit/write。
 *   - `CreateAgentSessionOptions`: `tools?: string[]`(allowlist)/
 *     `excludeTools?: string[]`(denylist)/ `noTools?: "all"|"builtin"`/
 *     **`customTools?: ToolDefinition[]`** ← 将来能挂 sansheng 自有工具
 *     (blackboard_* / memory_* / bus_send),不必局限在这 8 个内置工具里。
 *   - allowlist 对 builtin / extension-registered / customTools **统一过滤**
 *     (isAllowedTool),且只有名单内工具被激活 → 机制级硬约束,不依赖 prompt 自觉。
 *     这也是本模块把集合当权限面(而不是提示)来写的依据。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RoleKind } from "@shared/types/agents";
import { log } from "../../shared/log.js";
import { BRIDGED_TOOL_NAMES, type BridgedToolName } from "./toolBridge.js";
import { NATIVE_TOOL_NAMES, type NativeToolName } from "./nativeTools.js";

/** Pi SDK 内置的 8 个工具(闭合联合,core/tools/index.d.ts `ToolName`)。 */
export const SDK_TOOL_NAMES = ["read", "grep", "find", "ls", "edit", "write", "bash", "powershell"] as const;
export type SdkToolName = (typeof SDK_TOOL_NAMES)[number];

/**
 * 工具闭合联合 = SDK 内置 8 个 + 批次 7-F 桥接进来的 sansheng sandbox 6 个。
 * 加新工具必须先在 SDK 侧存在、或先在 toolBridge.ts 里桥接 —— 不能凭空扩。
 */
export const TOOL_NAMES = [...SDK_TOOL_NAMES, ...BRIDGED_TOOL_NAMES, ...NATIVE_TOOL_NAMES] as const;
export type ToolName = SdkToolName | BridgedToolName | NativeToolName;

/**
 * 风险分级。**只用于展示与将来做策略,不参与 allow/deny 判定** ——
 * 真正的约束是 ceiling。分级让 /api/harness 与 UI 能说清「为什么这个工具危险」。
 */
export type ToolRisk = "readonly" | "mutating" | "exec";

/** 工具来源。UI 要能区分「Pi SDK 自带」与「sansheng 自己的 sandbox 工具」。 */
export type ToolOrigin = "sdk" | "sansheng";

export const TOOL_CATALOG: Readonly<Record<ToolName, { risk: ToolRisk; origin: ToolOrigin; summary: string }>> = {
  read: { risk: "readonly", origin: "sdk", summary: "读文件内容(沿会话 cwd,支持 offset/limit 分段读)" },
  grep: { risk: "readonly", origin: "sdk", summary: "按正则搜文件内容(沿会话 cwd)" },
  find: { risk: "readonly", origin: "sdk", summary: "按 glob 找文件路径(沿会话 cwd)" },
  ls: { risk: "readonly", origin: "sdk", summary: "列目录(沿会话 cwd)" },
  edit: { risk: "mutating", origin: "sdk", summary: "对已有文件做精确字符串替换" },
  write: { risk: "mutating", origin: "sdk", summary: "新建 / 覆写文件" },
  bash: { risk: "exec", origin: "sdk", summary: "执行 shell 命令(可读可写可联网)" },
  powershell: { risk: "exec", origin: "sdk", summary: "执行 PowerShell 命令(Windows 侧等价物)" },
  // ── 批次 7-F:sansheng 自有 sandbox 工具(LLM 侧 snake_case 名,理由见 toolBridge.ts)──
  canvas_read: {
    risk: "readonly",
    origin: "sansheng",
    summary: "读 ~/.sansheng/ sandbox 允许根(workspace / canvas)内的文件,30 KiB 上限,不跟随 symlink",
  },
  canvas_list: {
    risk: "readonly",
    origin: "sansheng",
    summary: "列 sandbox 允许根内的目录条目(默认隐藏 .dotfile)",
  },
  canvas_stat: {
    risk: "readonly",
    origin: "sansheng",
    summary: "取 sandbox 允许根内路径的 kind / size / mtimeMs",
  },
  canvas_write: {
    risk: "mutating",
    origin: "sansheng",
    summary: "原子写 sandbox 允许根内的文件 —— 不在任何角色的上界内,启用需显式改 ROLE_CEILING",
  },
  net_fetch: {
    risk: "exec",
    origin: "sansheng",
    summary: "对 net.json allowlist 内公网 URL 发 GET/HEAD —— 不在任何角色的上界内",
  },
  net_post: {
    risk: "exec",
    origin: "sansheng",
    summary: "向 allowlist 内公网 URL POST JSON —— 不在任何角色的上界内,且与既有红线「禁止外发邮件」冲突",
  },
  // ── 批次 7-H:原生工具(Blackboard 与记忆,SDK 工具**完全够不着**的系统原语)──
  board_list: {
    risk: "readonly",
    origin: "sansheng",
    summary: "列本会话 Blackboard 工件(todo/evidence/hypothesis/decision),可按 kind/status 过滤 —— 了解「别人已经做了什么」的唯一途径",
  },
  board_read: {
    risk: "readonly",
    origin: "sansheng",
    summary: "按 id 读一条工件的完整正文。写结论前先读同题已有结论,好过凭空再写一份",
  },
  memory_search: {
    risk: "readonly",
    origin: "sansheng",
    summary: "检索长期记忆片段(偏好/事实/项目背景),与 ws.ts 记忆富集走同一个函数同一套默认值",
  },
};

/**
 * 工具集合覆盖的角色 = RoleKind(6 个) + harness_manager(第 7 个真实 class)。
 * harness_manager 不在 `RoleKind` 里(shared/types/agents.ts:97)但确实有实现
 * (agents/harnessManager.ts),工具集合这一面按第 7 个角色收进来,等它的 prompt
 * 进 harness 版本链(5c)时两边自然对齐。
 */
export type ToolRole = RoleKind | "harness_manager";

export const TOOL_ROLES: readonly ToolRole[] = [
  "communicator",
  "planner",
  "executor",
  "harness_manager",
  "critic",
  "memory",
  "reflection",
];

/**
 * 只读上界 = SDK 只读四件 + canvas 只读三件 + **sansheng 原生三件**。
 *
 * 7-H 起加了 board_list / board_read / memory_search:它们是 Blackboard 与记忆
 * 的读取入口,**任何 SDK 工具都够不着**(`read` 读磁盘、`bash` 跑命令)。
 * 7-G 之前系统最实质的空洞就在这里 —— executor 看不到兄弟 todo 的产出、
 * communicator 看不到 blackboard 就无法转述、planner 看不到已有 todo 会重复规划。
 *
 * 仍然**不含**任何写 / 执行 / 网络出口路径:`edit` / `write` / `bash` /
 * `powershell` / `canvas_write` / `net_fetch` / `net_post`。
 */
const READ_ONLY_CEILING: readonly ToolName[] = [
  "read",
  "grep",
  "find",
  "ls",
  "canvas_read",
  "canvas_list",
  "canvas_stat",
  "board_list",
  "board_read",
  "memory_search",
];

/**
 * 执行者上界 = 只读面 + 写与执行。
 *
 * **为什么只有执行者有**:批次 5b-1 P3(jev conf 1.00)那条裁决的对象是**沟通员**
 * —— 「沟通员从机制上杜绝直接干活,一切改动类请求经 decide=task 走规划执行链路」。
 * 裁决同时把「干活」这件事**划给了 task→plan→executor 链路**,但链路终点从来没
 * 被给过动手能力:executor 的出厂提示词里明确写着「没有工具能力时…不要编造
 * 具体的文件路径、API 参数、benchmark 数字」—— 那是对能力缺失的**诚实补偿**,
 * 不是能力本身。7-H 补上这一环,整条链路才闭合。
 *
 * jev 裁决(批次 7-H,needsUser 0.67 < 0.70 闸门,conf 0.56 / margin 0.52)= A2:
 * 给 write + edit + bash。A3(不给 bash)占 0.23,是次优项。
 *
 * 风险与回收:
 *   - SDK 的 edit/write/bash **不经 Sansheng 的 Sandbox**,只沿 `createAgentSession`
 *     的 cwd 走,根是 `settings.cwd`(默认 `~/sansheng-workspace`,与用户项目目录
 *     物理分离);Sandbox 那道防线只作用于 canvas_*。
 *   - **随时可收回**:把 `harness/tools/executor.json` 的 allow 里的 `write` /
 *     `edit` / `bash` 删掉,下一次 plan 生效,不需要改代码、不需要重启。
 *   - 执行者拿不准时的既有出路没变:产出 `hypothesis`(status=waiting_for_decision)
 *     把决定交回用户,而不是硬改。
 */
const EXECUTOR_CEILING: readonly ToolName[] = [...READ_ONLY_CEILING, "edit", "write", "bash"];

/**
 * 每角色的架构上界 —— **集合文件突破不了**。放开某角色 = 改本表(显式代码评审),
 * 不是往 tools/{role}.json 里加一行。
 */
const ROLE_CEILING: Readonly<Record<ToolRole, readonly ToolName[]>> = {
  // 批次 5b-1 P3:沟通员只读不写,写/执行/网络出口永久不在上界内。
  communicator: READ_ONLY_CEILING,
  // 规划员:只需要 Blackboard 读面(避免重复规划)。刻意**不给文件读** ——
  // 它不读代码,拆解靠意图理解;给了反而会去翻无关文件浪费 token。
  planner: ["board_list", "board_read"],
  // 执行者:唯一被允许写与执行的角色(见 EXECUTOR_CEILING 的理由)。
  executor: EXECUTOR_CEILING,
  harness_manager: READ_ONLY_CEILING,
  critic: READ_ONLY_CEILING,
  memory: READ_ONLY_CEILING,
  reflection: READ_ONLY_CEILING,
};

/** 集合文件形态(用户可编辑)。`allow: []` 即「该角色无工具」。 */
export interface ToolSetFile {
  allow: ToolName[];
  deny: ToolName[];
}

/**
 * 出厂集合。**只有 enforced 的角色给非空 allow** —— 给没有工具循环的角色写一份
 * 非空名单 = 换个姿势继续撒谎。空集合 + enforced:false 才是当前事实。
 */
const FACTORY_SETS: Readonly<Record<ToolRole, ToolSetFile>> = {
  // 沟通员:只读面全给。SDK 四件(自查:worker 升级前先读 README / 查文件)+
  // canvas 三件(看 sansheng 自己的允许根)+ 原生三件(转述执行方产出、记用户偏好)。
  // **Observer 身份没有 board_read 就没法履约** —— 它得先看见才能转述。
  communicator: { allow: [...READ_ONLY_CEILING], deny: [] },
  // 规划员:只要 Blackboard 读面。它的工作是拆 DAG,重复规划是它最大的失败模式。
  planner: { allow: ["board_list", "board_read"], deny: [] },
  // 执行者:整个上界。它是系统里唯一该动手的角色。
  executor: { allow: [...EXECUTOR_CEILING], deny: [] },
  // 以下四个角色**仍无工具循环**(走 completeSimple 单轮),集合照常生成但为空 ——
  // 7-H 只给 planner / executor 接了工具循环(见 agents/toolLoop.ts)。
  harness_manager: { allow: [], deny: [] },
  critic: { allow: [], deny: [] },
  memory: { allow: [], deny: [] },
  reflection: { allow: [], deny: [] },
};

/**
 * 出厂旧默认链(字节级 JSON 序列化串,与 serializeToolSetFile 同格式),仅用于
 * ensureToolSets 的「用户是否编辑过」判定。与 loader.ts 的 LEGACY_DEFAULTS 同一个
 * 模式:文件内容命中链上任一历史出厂版本 → 用户没编辑过 → 覆盖升级到当前默认。
 *
 * **改动 FACTORY_SETS 时必须把旧值追加进来**,否则存量用户的文件会被永久误判为
 * 「用户手笔」(prompt 侧 5a / 5b-1 / 7-B 已踩过三次,这里第一次真正用上)。
 */
const LEGACY_TOOL_SETS: Partial<Record<ToolRole, string[]>> = {
  // 7-E 出厂默认 = SDK 只读四件套(与 5b-1 P3 的硬编码名单逐字一致)。
  // 7-F 起 communicator 的出厂集合多了 canvas_read / canvas_list / canvas_stat,
  // 存量用户的这份四工具文件因此被标记为「出厂旧默认」→ 下次启动自动升级。
  communicator: [
    // 7-E 出厂默认:SDK 只读四件
    '{\n  "allow": [\n    "read",\n    "grep",\n    "find",\n    "ls"\n  ],\n  "deny": []\n}\n',
    // 7-F 出厂默认:加 canvas 只读三件
    '{\n  "allow": [\n    "read",\n    "grep",\n    "find",\n    "ls",\n    "canvas_read",\n    "canvas_list",\n    "canvas_stat"\n  ],\n  "deny": []\n}\n',
  ],
  // 7-H 之前 planner / executor 的出厂集合是空的;7-H 起非空 → 追加旧值
  planner: ['{\n  "allow": [],\n  "deny": []\n}\n'],
  executor: ['{\n  "allow": [],\n  "deny": []\n}\n'],
};

/** 该角色当前有没有工具执行点。enforced:false 时集合是「已就位、未接线」。 */
interface Enforcement {
  enforced: boolean;
  /** enforced:true → 真实执行点位置;false → 为什么没有(接线缺什么) */
  basis: string;
}

const TOOL_ENFORCEMENT: Readonly<Record<ToolRole, Enforcement>> = {
  communicator: {
    enforced: true,
    basis: "kernel/agentKernel.ts:createPiSession → createAgentSession({ tools: allowed })",
  },
  planner: {
    enforced: true,
    basis: "agents/planner.ts:plan → toolLoop.runWithTools(在 completeSimple 外包循环,签名不变)",
  },
  executor: {
    enforced: true,
    basis: "agents/executor.ts:execute → toolLoop.runWithTools(同上)",
  },
  harness_manager: {
    enforced: false,
    basis: "无执行点:harnessBoot.ts:132 decideFn → completeSimple 单轮补全,没有工具循环",
  },
  critic: {
    enforced: false,
    basis: "无执行点:critic 无 class 实现(只有 harness 默认 prompt;见 docs/PRODUCT-DESIGN-2026-10-02.md §1 角色表)",
  },
  memory: {
    enforced: false,
    basis: "无执行点:memory 职责由 sedimentation.ts 承担,走 completeSimple 单轮补全",
  },
  reflection: {
    enforced: false,
    basis: "无执行点:reflection 无 class 实现(只有 harness 默认 prompt)",
  },
};

/** 解析后的工具集合 —— `allowed` 才是交给 SDK 的名单。 */
export interface ToolSet {
  role: ToolRole;
  /** 集合文件里写的 allow(去重、已剔除非法工具名) */
  allow: ToolName[];
  /** 集合文件里写的 deny */
  deny: ToolName[];
  /** (allow − deny − ceiling 外) —— 实际交给 SDK 的名单 */
  allowed: ToolName[];
  /** allow 里被 ceiling 挡下的(提权失败,必须对用户可见,绝不静默) */
  blockedByCeiling: ToolName[];
  /** 该角色当前有没有工具执行点。false = 集合已就位但没人应用 */
  enforced: boolean;
  /** 执行点位置(enforced)或缺失原因(!enforced) */
  enforceBasis: string;
  /** factory = 文件内容等于当前出厂默认;user = 用户手笔 */
  source: "factory" | "user";
  /** 解析告警(非法工具名 / 未知字段 / deny 冲突 / ceiling 拒绝) */
  warnings: string[];
}

/** `harness/tools/{role}.json` 的绝对路径(ensureToolSets / 测试共用)。 */
export function toolSetFilePath(dataDir: string, role: ToolRole): string {
  return join(dataDir, "harness", "tools", `${role}.json`);
}

/**
 * 某角色的架构上界(只读,调用方拿到的数组不可改)。
 * 没有 dataDir、拿不到用户集合的调用点(目前只有死代码 AgentRunner)用它兜底 ——
 * 宁可用最严的上界,也不要落进 SDK 的默认工具面(read/bash/edit/write)。
 */
export function roleToolCeiling(role: ToolRole): readonly ToolName[] {
  return ROLE_CEILING[role];
}

/** 集合文件的规范化序列化(ensureToolSets 写出 / 出厂默认字节比对都用它)。 */
function serializeToolSetFile(file: ToolSetFile): string {
  return `${JSON.stringify({ allow: file.allow, deny: file.deny }, null, 2)}\n`;
}

function isToolName(v: string): v is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const KNOWN_FILE_KEYS = new Set(["allow", "deny"]);

function readToolNameArray(
  raw: unknown,
  field: "allow" | "deny",
  role: ToolRole,
  warnings: string[],
): ToolName[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`\`${field}\` 不是数组(实际 ${typeof raw}),已按空处理 —— 权限面 fail-closed`);
    return [];
  }
  const out: ToolName[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      warnings.push(`\`${field}\` 含非字符串项,已忽略`);
      continue;
    }
    if (!isToolName(item)) {
      warnings.push(
        `\`${field}\` 含未知工具名「${item}」—— 不在 SDK 工具闭合联合(read/grep/find/ls/edit/write/bash/powershell)内,已忽略`,
      );
      continue;
    }
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * 集合文件 → 解析结果。所有异常路径都退回出厂集合(**fail-closed**):
 * 权限面上「读不懂配置」绝不能退化成「放行一切」。
 */
function parseToolSetFile(
  role: ToolRole,
  text: string,
  source: "factory" | "user",
): ToolSet {
  const warnings: string[] = [];
  let file: ToolSetFile = FACTORY_SETS[role];
  if (source === "user") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return resolveToolSet(role, FACTORY_SETS[role], "factory", [
        `集合文件 JSON 解析失败(${(err as Error).message}),已回退出厂集合`,
      ]);
    }
    if (!isRecord(parsed)) {
      return resolveToolSet(role, FACTORY_SETS[role], "factory", [
        "集合文件顶层不是 JSON 对象,已回退出厂集合",
      ]);
    }
    for (const key of Object.keys(parsed)) {
      if (!KNOWN_FILE_KEYS.has(key)) {
        warnings.push(`未知字段「${key}」已忽略(本文件只认 allow / deny —— 注意是 allow 不是 allowed)`);
      }
    }
    file = {
      allow: readToolNameArray(parsed["allow"], "allow", role, warnings),
      deny: readToolNameArray(parsed["deny"], "deny", role, warnings),
    };
  }
  return resolveToolSet(role, file, source, warnings);
}

/** allow/deny/ceiling 三方求交,产出真正交给 SDK 的 `allowed`。 */
function resolveToolSet(
  role: ToolRole,
  file: ToolSetFile,
  source: "factory" | "user",
  warnings: string[],
): ToolSet {
  const deny = new Set(file.deny);
  const ceiling = ROLE_CEILING[role];
  const allowed: ToolName[] = [];
  const blockedByCeiling: ToolName[] = [];
  for (const tool of file.allow) {
    if (deny.has(tool)) {
      warnings.push(`allow 与 deny 同时包含「${tool}」—— deny 胜出,该工具已移除`);
      continue;
    }
    if (!ceiling.includes(tool)) {
      blockedByCeiling.push(tool);
      warnings.push(
        `「${tool}」超出 ${role} 的架构上界(${ceiling.join("/") || "无"}),已拒绝 —— 放开上界是改 ROLE_CEILING 的代码动作,不是改集合文件`,
      );
      continue;
    }
    allowed.push(tool);
  }
  const enforcement = TOOL_ENFORCEMENT[role];
  return {
    role,
    allow: file.allow,
    deny: file.deny,
    allowed,
    blockedByCeiling,
    enforced: enforcement.enforced,
    enforceBasis: enforcement.basis,
    source,
    warnings,
  };
}

/**
 * 读取全部角色的工具集合。语义与 loadHarness 对称:每次调用重新读盘,
 * 用户改完 tools/{role}.json 下一次调用即生效(不需重启)。
 *
 * 单个文件缺失 / 不可读 → 该角色退回出厂集合 + 一条 warning,其余角色不受影响。
 */
export function loadToolSets(dataDir: string): Record<ToolRole, ToolSet> {
  const out = {} as Record<ToolRole, ToolSet>;
  for (const role of TOOL_ROLES) {
    const p = toolSetFilePath(dataDir, role);
    if (!existsSync(p)) {
      out[role] = parseToolSetFile(role, "", "factory");
      continue;
    }
    let text: string;
    try {
      text = readFileSync(p, "utf-8");
    } catch (err) {
      out[role] = parseToolSetFile(role, "", "factory");
      out[role].warnings.push(`集合文件不可读(${(err as Error).message}),已回退出厂集合`);
      continue;
    }
    if (text === serializeToolSetFile(FACTORY_SETS[role])) {
      out[role] = parseToolSetFile(role, text, "factory");
      continue;
    }
    out[role] = parseToolSetFile(role, text, "user");
  }
  return out;
}

/**
 * 首次启动时生成 `harness/tools/{role}.json`。三分支语义与 ensureHarness 同源
 * (harness = 雇员手册,雇主手笔至上 —— 绝不静默覆盖用户编辑):
 *   - 文件不存在                             → 写入当前出厂默认
 *   - 内容 === 当前出厂默认                   → 跳过(幂等)
 *   - 内容 ∈ LEGACY_TOOL_SETS 版本链          → 用户未编辑 → 覆盖升级
 *   - 其它(用户编辑过)                       → 原样保留 + log.info
 */
export function ensureToolSets(dataDir: string): void {
  const dir = join(dataDir, "harness", "tools");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  for (const role of TOOL_ROLES) {
    const content = serializeToolSetFile(FACTORY_SETS[role]);
    const p = toolSetFilePath(dataDir, role);
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
    if (existing === content) continue; // 出厂默认已就位 → 幂等跳过
    if (LEGACY_TOOL_SETS[role]?.includes(existing)) {
      writeFileSync(p, content, "utf-8");
      log.info(`harness: tools/${role}.json 由出厂旧默认升级为新默认`);
      continue;
    }
    log.info(
      `harness: tools/${role}.json 已被用户编辑,保留原样;新出厂默认见 src/server/harness/tools.ts FACTORY_SETS,可手动合并`,
    );
  }
}

/**
 * 工具集合摘要(GET /api/harness · UI Harness tab 数据源),与 describePrompts
 * 同一形态。`source`:factory = 等于当前出厂默认(可安全覆盖升级),user = 用户手笔。
 */
export type ToolSetInfo = ToolSet;

export function describeToolSets(dataDir: string): ToolSetInfo[] {
  const sets = loadToolSets(dataDir);
  return TOOL_ROLES.map((role) => sets[role]);
}
