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

/** Pi SDK 内置的 8 个工具(闭合联合,core/tools/index.d.ts `ToolName`)。 */
export const SDK_TOOL_NAMES = ["read", "grep", "find", "ls", "edit", "write", "bash", "powershell"] as const;
export type SdkToolName = (typeof SDK_TOOL_NAMES)[number];

/**
 * 工具闭合联合 = SDK 内置 8 个 + 批次 7-F 桥接进来的 sansheng sandbox 6 个。
 * 加新工具必须先在 SDK 侧存在、或先在 toolBridge.ts 里桥接 —— 不能凭空扩。
 */
export const TOOL_NAMES = [...SDK_TOOL_NAMES, ...BRIDGED_TOOL_NAMES] as const;
export type ToolName = SdkToolName | BridgedToolName;

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
 * 只读上界。= SDK createReadOnlyTools 的 4 个 + 批次 7-F 桥接进来的 3 个
 * canvas 只读工具。
 *
 * **为什么 canvas_* 只读侧进上界、而 canvas_write / net_* 不进**:
 * - 进的三個(`canvas_read/canvas_list/canvas_stat`)经 `Sandbox` 强制,根被
 *   钉死在 `~/.sansheng/workspace` 与 `~/.sansheng/canvas`,30 KiB 上限、不跟随
 *   symlink —— 与内置只读工具同性质(只读),只是换了一个根,给沟通员/执行者
 *   一双看 sansheng 自己的眼睛。
 * - 不进的三个:`canvas_write` 是唯一的写入口;`net_fetch` / `net_post` 是**网络
 *   出口**。v1 原则是「上界里不含任何能改变状态或对外发包的路径」—— 保持
 *   5b-1 P3(沟通员只读不写)与 redLines(禁止外发邮件)的原有强度。
 *   三个工具都已桥接、已测试、可被点名;放开只需改本表,不是改集合文件。
 */
const READ_ONLY_CEILING: readonly ToolName[] = [
  "read",
  "grep",
  "find",
  "ls",
  "canvas_read",
  "canvas_list",
  "canvas_stat",
];

/**
 * 每角色的架构上界 —— **集合文件突破不了**。放开某角色 = 改本表(显式代码评审),
 * 不是往 tools/{role}.json 里加一行。
 *
 * v1 全部取只读:v0 没有任何角色被允许在用户磁盘上写入 / 执行 / 联网。Executor
 * 的默认 prompt 里那句「工具调用前先确认 sandbox 范围」目前是悬空的(它没有工具),
 * 保持只读上界意味着即便接线,写与执行仍然需要一次显式的架构决策。
 */
const ROLE_CEILING: Readonly<Record<ToolRole, readonly ToolName[]>> = {
  // 批次 5b-1 P3(jev conf 1.00):沟通员只读不写,写/执行类工具永久不在上界内。
  communicator: READ_ONLY_CEILING,
  planner: READ_ONLY_CEILING,
  executor: READ_ONLY_CEILING,
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
  // 沟通员:只读面全部保留 —— SDK 四个(自查能力:worker 升级前先自己读 README /
  // 查文件)+ 7-F 桥接的 canvas 三个(看 sansheng 自己的允许根)。写与执行被
  // ceiling 挡下。
  //
  // ⚠️ 7-F 起这是**行为变更**:出厂集合比 5b-1 P3 的硬编码名单多了 3 个工具。
  // 三者都是只读 + sandbox 钉根,没有权限放宽;但存量用户的
  // harness/tools/communicator.json 仍是 7-E 写下的四工具版本 —— 按
  // LEGACY_TOOL_SETS 的版本链语义,那个文件已被标记为「出厂旧默认」,下次
  // 启动会自动升级为含 canvas_* 的新默认(用户手笔则永不覆盖)。
  communicator: { allow: [...READ_ONLY_CEILING], deny: [] },
  planner: { allow: [], deny: [] },
  executor: { allow: [], deny: [] },
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
  communicator: ['{\n  "allow": [\n    "read",\n    "grep",\n    "find",\n    "ls"\n  ],\n  "deny": []\n}\n'],
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
    enforced: false,
    basis: "无执行点:走 llmCall → ws.ts:191 completeSimple 单轮补全,不经 Pi session,没有工具循环",
  },
  executor: {
    enforced: false,
    basis: "无执行点:executor.ts:182 走 llmCall → completeSimple 单轮补全,没有工具循环",
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
