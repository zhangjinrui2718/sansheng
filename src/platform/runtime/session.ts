/**
 * 平台运行时 · 会话工厂(ADR-001 §2 Q1)
 *
 * ── 这是「接线」的落点 ──────────────────────────────────────────
 *
 * 在此之前,`ROLE_SPECS` / `solveToolset` / `dispatch` 都只是**声明** ——
 * 建好但没通电。这个模块把它们接到真实的 Pi session 上:
 *
 *   1. 规划:planAgentSession → 三重门控算出工具面
 *   2. 分道:splitToolset   → SDK 内置进 allowlist,平台工具进 customTools
 *   3. 包壳:toSdkTools     → 平台工具 → SDK ToolDefinition(无逻辑薄壳)
 *   4. 建会话:createAgentSession({ tools, customTools, cwd, agentDir, model })
 *
 * ── 为什么会话建在平台侧而不是改旧 AgentKernel ────────────────────
 *
 * ADR-001 §2 Q1 的决策,用户已确认。理由是**爆炸半径**:改旧 kernel 意味着
 * 新授权模型的第一次真实运行直接发生在旧系统核心链路上 —— 一旦出问题,
 * 分不清是新模型错了还是接线错了,而且旧系统立刻不可用。
 *
 * 代价是过渡期有两套会话创建点。可接受:它们服务两套互不相干的工具与角色
 * 体系,旧的那套会在阶段 8 整体删除。
 *
 * ── DI seam ────────────────────────────────────────────────────
 *
 * `createSession` 可注入。生产走真的 `createAgentSession`;测试注入一个假的,
 * 就能断言「到底把什么交给了 SDK」而**不需要 provider / API key / 网络**。
 * 这是本项目吃过亏的地方(5 个 E2E blocker 至今只有 fakeLlmCall 验证)。
 */
import { createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

/**
 * SDK 自己的签名就是 `model?: Model<any>`(`CreateAgentSessionOptions` 原文)——
 * 因为 `Model` 的泛型参数 `constraint Api` 在跨 provider 场景下无法收窄。
 *
 * 这里照抄 SDK 的形状,不自己发明一个更窄的类型。注意这是**类型参数**,
 * 不是类型断言 —— 项目禁止的是后者(那条检查仍为 0)。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<any>;
import {
  buildToolContext, planAgentSession,
  type AgentSessionPlan, type RuntimeDeps,
} from "./assembly.js";
import { splitToolset, toSdkTools } from "./sdkAdapter.js";
import { dispatch } from "../tools/registry.js";

/** `createAgentSession` 的最小结构类型 —— 只声明我们用到的字段,便于注入假货。 */
export interface CreateSessionFn {
  (opts: {
    cwd?: string;
    agentDir?: string;
    model?: AnyModel;
    tools?: string[];
    customTools?: ReturnType<typeof toSdkTools>;
  }): Promise<{ session: AgentSession }>;
}

export interface PlatformSessionOptions {
  /** 会话工作目录(代码工具的根) */
  readonly cwd: string;
  /** Pi 全局配置目录 */
  readonly agentDir: string;
  /** 已解析的模型 */
  readonly model?: AnyModel;
  /** 测试 seam:替换真实 SDK 调用 */
  readonly createSession?: CreateSessionFn;
}

export type PlatformSessionFailure =
  | { readonly ok: false; readonly reason: "assembly"; readonly detail: string }
  | { readonly ok: false; readonly reason: "unplaceable_tools"; readonly detail: string; readonly tools: readonly string[] };

export type PlatformSessionResult =
  | {
      readonly ok: true;
      readonly session: AgentSession;
      /** 规划结果 —— 诊断/审计要它(算出了什么、挡下了什么) */
      readonly plan: AgentSessionPlan;
      /** 实际交给 SDK 的两条通道(测试与诊断断言这个) */
      readonly wiring: {
        readonly allowlist: readonly string[];
        readonly customToolNames: readonly string[];
      };
    }
  | PlatformSessionFailure;

/**
 * 为一个 agent 在某项目里建立会话。
 *
 * **失败一律显式返回**,不抛异常 —— 会话建立是启动路径,异常会以栈回溯的形式
 * 出现,而调用方本可以给出一句可读的原因。
 */
export async function createPlatformSession(
  deps: RuntimeDeps,
  agentId: string,
  projectId: string,
  opts: PlatformSessionOptions,
): Promise<PlatformSessionResult> {
  // 1. 规划
  const planned = planAgentSession(deps, agentId, projectId);
  if (!planned.ok) {
    return { ok: false, reason: "assembly", detail: `${planned.reason}: ${planned.detail}` };
  }
  const plan = planned.plan;

  // 2. 分道
  const split = splitToolset(plan.tools);
  if (split.unplaceable.length > 0) {
    // 这一条必须硬失败:工具面声称有、但两条通道都放不进去 = 8-A 的形态。
    // 放行的话模型会看到不存在的工具,然后编造。
    return {
      ok: false,
      reason: "unplaceable_tools",
      detail:
        `这些工具在求解结果里,但既不是 SDK 内置、也不在平台注册表:` +
        `${split.unplaceable.join(", ")} —— 交不出去的工具等于声称有而实际没有`,
      tools: split.unplaceable,
    };
  }

  // 3. 包壳。上下文由 dispatchOne 每次调用现取(见上),
  //    所以这一层壳里没有任何逻辑 —— 它只搬元数据。
  const customTools = toSdkTools(split.platformTools, (tool, args) => {
    const c = buildToolContext(deps, agentId, projectId);
    if (!c.ok) {
      // 逐调用重新校验 —— 项目可能在会话中途被关闭,或把该 agent 移出
      return {
        ok: false as const,
        code: "denied" as const,
        message: `工具调用被拒:${c.detail}`,
      };
    }
    return dispatch(tool.name, args, c.ctx);
  });

  // 4. 建会话
  const create = opts.createSession ?? createAgentSession;
  const created = await create({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    // 两条通道各归各位:内置进 allowlist,平台工具进 customTools。
    // **必须同时给**:只给 tools 会让平台工具缺席,只给 customTools 会让
    // SDK 内置被关掉(给了 allowlist 就只启用名单内的)。
    tools: [...split.builtinAllowlist],
    customTools,
  });

  return {
    ok: true,
    session: created.session,
    plan,
    wiring: {
      allowlist: [...split.builtinAllowlist],
      customToolNames: customTools.map((t) => t.name),
    },
  };
}
