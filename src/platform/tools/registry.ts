/**
 * 工具注册表 + 派发器
 *
 * ── 派发器是整个授权模型真正生效的地方 ────────────────────────────
 *
 * 前面所有层(solveToolset 算出工具面、ROLE_SPECS 定义上界)都只是**声明**。
 * 真正拦住一次非法调用的,是这里的 `dispatch()`:
 *
 *   1. 工具存在吗             → 不存在 / 未实现:结构化错误 + 可用名单
 *   2. 角色的 ceiling 给了吗   → 没给:denied(与求解期同源判定)
 *   3. 调用期门(kind/target)  → authorizeCall():第三道门
 *   4. 执行 tool.run(),异常兜底
 *
 * 为什么第 2 步在求解期算过之后还要再做一次:**工具面的存在不等于调用的合法**
 * —— 会话可能是在旧配置下建立的,而配置之后被改过。声明与执行分离时,
 * 执行侧必须能独立判定,否则「改了配置但旧会话还开着」就是个越权窗口。
 */
import type Database from "better-sqlite3";
import { authorizeCall, capabilityOfTool } from "../harness/authorize.js";
import { ROLE_SPECS, factoryToolset, type ProjectRole } from "../identity/role.js";
import {
  ALL_TOOLS,
  CAPABILITIES,
  isToolName,
  type Capability,
  type ToolName,
} from "../harness/capability.js";
import { PROJECT_WORK_TOOLS } from "./project.js";
import { BLACKBOARD_TOOLS } from "./blackboard.js";
import { CONTROL_TOOLS } from "./control.js";
import { fail, type PlatformTool, type ToolResult, type ToolRunContext } from "./types.js";

/** 已实现的全部平台工具。BC2 / BC7 的工具在各自批次落地后并入这里。 */
export const ALL_PLATFORM_TOOLS: readonly PlatformTool[] = [
  ...PROJECT_WORK_TOOLS,
  ...BLACKBOARD_TOOLS,
  ...CONTROL_TOOLS,
];

/** 工具名 → 工具定义 */
export const TOOL_INDEX: ReadonlyMap<ToolName, PlatformTool> = new Map(
  ALL_PLATFORM_TOOLS.map((t) => [t.name, t]),
);

/** 工具表里有、但当前批次还没建实现的工具名 */
export function notYetBuiltToolNames(): ToolName[] {
  return ALL_TOOLS.filter((t) => !TOOL_INDEX.has(t));
}

/**
 * 注册期自检:**工具声明的 capability 必须与工具名反查出来的一致**。
 *
 * 这是 7-E 那个坑的机器防线:当时 `enabledTools` 里写着四个在 SDK 闭合联合里
 * 根本不存在的名字,却摆在 /api/harness 里像个配置项。声明与能力脱节 =
 * 用户在 UI 上看到的不是真的。
 */
export function checkRegistryConsistency(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const tool of ALL_PLATFORM_TOOLS) {
    if (seen.has(tool.name)) problems.push(`工具名重复注册:${tool.name}`);
    seen.add(tool.name);

    const derived = capabilityOfTool(tool.name);
    if (derived === undefined) {
      problems.push(`${tool.name} 在 CAPABILITY_TOOLS 里没有对应能力(声明为 ${tool.capability})`);
    } else if (derived !== tool.capability) {
      problems.push(`${tool.name} 声明 capability=${tool.capability},但反查得到 ${derived}`);
    }
  }
  return problems;
}

/**
 * 派发一次工具调用。
 *
 * **永不抛异常** —— 任何路径都返回 ToolResult。工具实现里漏掉的异常在这里兜底:
 * 一次未捕获的异常会让整轮对话崩掉,而模型的下一步动作本可以是「读错误信息
 * 然后换个参数重试」。
 */
export function dispatch(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  ctx: ToolRunContext,
): Promise<ToolResult> | ToolResult {
  // ── 1. 工具存在吗 ──
  if (!isToolName(toolName)) {
    return fail(
      "invalid_args",
      `未知工具「${toolName}」—— 工具名来自闭合集,拼写错误不会静默生效`,
      implementedToolNames(),
    );
  }
  const tool = TOOL_INDEX.get(toolName);
  if (tool === undefined) {
    return fail(
      "not_found",
      `工具「${toolName}」在工具表里,但当前批次还没建实现`,
      implementedToolNames(),
    );
  }

  // ── 2. 角色的 ceiling 给了吗 ──
  const spec = ROLE_SPECS[ctx.agent.role];
  if (!spec.ceiling.includes(tool.capability)) {
    return fail(
      "denied",
      `角色 ${ctx.agent.role} 的架构上界不含「${tool.capability}」—— ` +
        `放开上界是改 ROLE_SPECS 的代码动作,不是改集合文件`,
      implementedToolNames(),
    );
  }

  // ── 3. 调用期门(kind / target)──
  const verdict = authorizeCall(tool.capability, args, {
    agent: ctx.agent,
    project: ctx.project,
  });
  if (!verdict.ok) {
    // 值不存在 = 参数错(模型记错了);存在但无权 = 权限错(模型越权)。
    // 两者的下一步动作不同,错误码也要不同。
    return fail(
      verdict.denial.invalidValue === true ? "invalid_args" : "denied",
      verdict.denial.reason,
      verdict.denial.alternatives,
    );
  }

  // ── 4. 执行。异常在这里兜底,不许穿透 ──
  try {
    const r = tool.run(args, ctx);
    return r instanceof Promise
      ? r.catch((err: unknown) =>
          fail("internal", err instanceof Error ? err.message : String(err)),
        )
      : r;
  } catch (err) {
    return fail("internal", err instanceof Error ? err.message : String(err));
  }
}

function implementedToolNames(): string[] {
  return [...TOOL_INDEX.keys()].sort();
}

/** 按能力列出该能力下已实现的工具(给 GUI 展示用)。 */
export function toolsForCapability(cap: Capability): readonly PlatformTool[] {
  return ALL_PLATFORM_TOOLS.filter((t) => t.capability === cap);
}

/**
 * 某角色出厂工具集里,**已经实现**与**还没建**的两组。
 *
 * 为什么要区分:设计 1 §7.3 那条纪律说得很清楚 —— 不写假实现、不假装配置在
 * 生效。GUI 上标出「这个工具已就位」还是「还没建」,比让它看起来能用要诚实得多。
 */
export function toolBuildStatusForRole(role: ProjectRole): {
  implemented: ToolName[];
  notYetBuilt: ToolName[];
} {
  const all = factoryToolset(role);
  const implemented: ToolName[] = [];
  const notYetBuilt: ToolName[] = [];
  for (const t of all) (TOOL_INDEX.has(t) ? implemented : notYetBuilt).push(t);
  return { implemented, notYetBuilt };
}

/** 供测试与诊断:一次拿到注册表全貌 */
export function registrySnapshot(): {
  totalInTable: number;
  implemented: number;
  notYetBuilt: ToolName[];
  problems: string[];
} {
  return {
    totalInTable: ALL_TOOLS.length,
    implemented: ALL_PLATFORM_TOOLS.length,
    notYetBuilt: notYetBuiltToolNames(),
    problems: checkRegistryConsistency(),
  };
}

/**
 * 未被任何工具实现覆盖的能力。
 *
 * BC2(协作)与 BC7(记忆)的工具尚未落地,所以现在必然有若干条在这里 ——
 * **这是如实反映进度,不是缺陷**。GUI 应据此标注「已就位/未实现」。
 */
export function capabilitiesWithoutTools(): Capability[] {
  const covered = new Set(ALL_PLATFORM_TOOLS.map((t) => t.capability));
  return CAPABILITIES.filter((c) => !covered.has(c));
}
