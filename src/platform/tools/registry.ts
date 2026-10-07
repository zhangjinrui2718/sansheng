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
import { authorizeCall, capabilityOfTool, intakeCapabilities, isIntakeCapability } from "../harness/authorize.js";
import { ROLE_SPECS, factoryToolset, type ProjectRole } from "../identity/role.js";
import {
  ALL_TOOLS,
  CAPABILITIES,
  CAPABILITY_TOOLS,
  expandCapabilities,
  isSdkToolName,
  isToolName,
  type Capability,
  type ToolName,
} from "../harness/capability.js";
import { PROJECT_WORK_TOOLS } from "./project.js";
import { BLACKBOARD_TOOLS } from "./blackboard.js";
import { CONTROL_TOOLS } from "./control.js";
import { COLLAB_TOOLS } from "./collab.js";
import { MEMORY_TOOLS } from "./memory.js";
import { KNOWLEDGE_TOOLS } from "./knowledge.js";
import { CLIENT_TOOLS } from "./client.js";
import { REVIEW_TOOLS } from "./review.js";
import { NUDGE_CAPABILITIES } from "../runtime/dispatcher.js";
import { fail, type PlatformTool, type ToolResult, type ToolRunContext } from "./types.js";

/** 已实现的全部平台工具。BC2 / BC7 的工具在各自批次落地后并入这里。 */
export const ALL_PLATFORM_TOOLS: readonly PlatformTool[] = [
  ...PROJECT_WORK_TOOLS,
  ...BLACKBOARD_TOOLS,
  ...CONTROL_TOOLS,
  ...COLLAB_TOOLS,
  ...MEMORY_TOOLS,
  ...KNOWLEDGE_TOOLS,
  ...CLIENT_TOOLS,
  ...REVIEW_TOOLS,
];

/** 工具名 → 工具定义 */
export const TOOL_INDEX: ReadonlyMap<ToolName, PlatformTool> = new Map(
  ALL_PLATFORM_TOOLS.map((t) => [t.name, t]),
);

/**
 * **平台需要自己实现、但目前还没建**的工具名。
 *
 * 排除 SDK 内置那 7 个(read/grep/find/ls/edit/write/bash)—— 它们由 Pi SDK
 * 提供,本来就不该出现在平台的工具注册表里。把它们算成「未建」会让这份清单
 * 永远挂着 7 条消不掉的项,和 capabilitiesWithoutTools 是同一个错。
 */
export function notYetBuiltToolNames(): ToolName[] {
  return ALL_TOOLS.filter((t) => !TOOL_INDEX.has(t) && !isSdkToolName(t));
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

  // ── 2.5 作用域:**接待会话**里只有项目无关的能力 ──
  //
  // 与求解期的 scope 门同源(`authorize.isIntakeCapability`),理由与第 2 步一样:
  // 工具面的存在不等于调用的合法。接待会话的工具面是会话建立时算的,而
  // **项目可能在同一轮里刚被 project_open 建出来** —— 那之后这次会话就是旧形态了,
  // 它手上剩下的项目内工具必须当场失效(宿主随后会 dispose 掉这条会话,
  // 但不能指望「随后」:这一轮里模型还可能继续调工具)。
  if (ctx.project === null && !isIntakeCapability(tool.capability)) {
    return fail(
      "denied",
      `工具「${toolName}」(能力 ${tool.capability})需要项目作用域,` +
        `而这次调用发生在接待会话 —— 接待阶段能用的只有:${intakeCapabilities().join(" / ")}。` +
        `先与甲方把诉求谈清楚,再用 project_open 立项`,
      // 回灌**接待模式下真正可用的工具**,不是「已实现的全部工具」——
      // 8-F 的教训是拒绝必须让模型能据此自纠;列一份它此刻用不了的名字,
      // 等于把它指向另一条死路。
      expandCapabilities(intakeCapabilities()),
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
      ? r.then((v) => ringNudge(v, tool.capability, ctx)).catch((err: unknown) =>
          fail("internal", err instanceof Error ? err.message : String(err)),
        )
      : ringNudge(r, tool.capability, ctx);
  } catch (err) {
    return fail("internal", err instanceof Error ? err.message : String(err));
  }
}

/**
 * **状态迁移的门铃**:一次可能改变流水线状态的调用**成功之后**,让排空器知道
 * 「现在去查一下谁该动」。
 *
 * 它只挂在这一处(工具派发的唯一漏斗),因为散在十几个工具里迟早漏一个 ——
 * 而漏掉的表现只是「这件事要等下一次定时器」,一个只在延迟上显形、极难归因的
 * 偏差。清单与理由见 `runtime/dispatcher.ts` 的 `NUDGE_CAPABILITIES`。
 *
 * 门铃响不响**不影响工具结果**:它只是加速,排空器在库里重新判定。
 */
function ringNudge(
  result: ToolResult,
  capability: Capability,
  ctx: ToolRunContext,
): ToolResult {
  if (result.ok !== true) return result;
  if (ctx.nudge === undefined) return result;
  if (!NUDGE_CAPABILITIES.includes(capability)) return result;
  try {
    ctx.nudge();
  } catch {
    // 门铃失败不该把一次成功的工具调用变成失败 —— 定时器会兜住
  }
  return result;
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
 * **需要平台自己实现、但目前还没实现**的能力。
 *
 * 注意排除两类,否则报出来的「缺口」是假的:
 *   1. 已有平台工具实现的
 *   2. 工具全部由 Pi SDK 提供的(`code.read/write/exec` → read/grep/bash/…)——
 *      这几个**永远不会有平台实现**,不是缺口。把它们算进缺口会让这份清单
 *      一直挂着几条永远消不掉的项,久而久之没人再看它。
 *
 * 剩下的是真缺口:BC7 记忆、面向甲方的 client.*(属执行/传输批次)。
 */
export function capabilitiesWithoutTools(): Capability[] {
  const covered = new Set(ALL_PLATFORM_TOOLS.map((t) => t.capability));
  return CAPABILITIES.filter((c) => {
    if (covered.has(c)) return false;
    const tools = CAPABILITY_TOOLS[c];
    // 工具全是 SDK 内置 → 平台无需实现,不算缺口
    return !tools.every((t) => isSdkToolName(t));
  });
}
