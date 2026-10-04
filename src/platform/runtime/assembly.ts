/**
 * 平台运行时 · 上下文组装(ADR-001 §2 Q3)
 *
 * ── 为什么单独一个模块 ──────────────────────────────────────────
 *
 * 工具需要 `db / agent / project / now / newId / memory / client` 七项。这是
 * **装配职责**,不该散落在每个调用点 —— 散开之后「谁给 projectId」就会有多种
 * 写法,而 scope 门的正确性完全依赖它。
 *
 * ── 为什么 projectId 必须显式传 ─────────────────────────────────
 *
 * 明确不做「当前项目」的隐式全局。一个 agent 可能同时在多个项目里(设计 1
 * §4.3 的 scope 门正是为此存在),隐式全局会让「这个工具调用属于哪个项目」
 * 变得不可判定 —— 而那是授权、留痕、审计三件事的共同前提。
 */
import type Database from "better-sqlite3";
import { getAgent } from "../storage/repo/agents.js";
import { loadProjectForAuthz } from "../storage/repo/projects.js";
import { loadProjectRoster } from "../storage/repo/projects.js";
import { ROLE_SPECS, isProjectRole, type ProjectRole } from "../identity/role.js";
import { solveToolset, type Agent, type Project, type ToolSetFile } from "../harness/authorize.js";
import type { Capability, ToolName } from "../harness/capability.js";
import type { MemoryPort } from "../memory/port.js";
import type { ClientChannel } from "../client/port.js";
import type { ToolRunContext } from "../tools/types.js";

/** 进程级依赖。会话工厂持有一份,每次工具调用按 agent + project 组装。 */
export interface RuntimeDeps {
  readonly db: Database.Database;
  readonly memory?: MemoryPort;
  readonly client?: ClientChannel;
  /** 时钟注入(测试可控) */
  readonly now?: () => number;
  /** id 生成注入(测试可复现) */
  readonly newId?: (prefix: string) => string;
  /** 用户可编辑的工具集合文件内容(缺省 = 出厂行为) */
  readonly toolSetFor?: (role: ProjectRole) => ToolSetFile | undefined;
  /**
   * 状态迁移的门铃(排空器的触发点之一)。**不携带状态**,只说「去查一下」。
   *
   * 它由工具派发器在**可能改变流水线状态**的调用成功之后敲一次
   * (清单见 `runtime/dispatcher.ts` 的 `NUDGE_CAPABILITIES`);宿主收到之后
   * 让排空器重新查库。缺省时没有门铃 —— 定时器兜底,功能不受影响,只是慢一点。
   */
  readonly onStateChange?: () => void;
}

export type AssemblyFailure =
  | { readonly ok: false; readonly reason: "no_such_agent"; readonly detail: string }
  | { readonly ok: false; readonly reason: "no_such_project"; readonly detail: string }
  | { readonly ok: false; readonly reason: "agent_not_assigned"; readonly detail: string }
  | { readonly ok: false; readonly reason: "role_unknown"; readonly detail: string };

export type AssemblyResult =
  | {
      readonly ok: true;
      readonly ctx: ToolRunContext;
      /** `null` = 接待会话(第一个项目之前)。见 `projectId` 的说明。 */
      readonly project: Project | null;
    }
  | AssemblyFailure;

/**
 * 把库里的 agent 行转成领域 `Agent`。
 *
 * **仓储层会在遇到未定义角色时抛错**(那是它的边界校验),而装配层要把那个抛错
 * 转成**结构化失败** —— 否则一次数据损坏会以异常形式穿透整个会话建立路径,
 * 而调用方本可以如实报「这个 agent 的角色不认识」。
 */
type LoadAgentResult =
  | { readonly kind: "ok"; readonly agent: Agent }
  | { readonly kind: "missing" }
  | { readonly kind: "role_unknown"; readonly rawRole: string };

function loadAgent(db: Database.Database, agentId: string): LoadAgentResult {
  let row;
  try {
    row = getAgent(db, agentId);
  } catch (err) {
    // 仓储的闭合集校验失败 —— 把原始角色尽量捞出来放进错误信息
    const m = err instanceof Error ? err.message.match(/「([^」]*)」/) : null;
    return { kind: "role_unknown", rawRole: m?.[1] ?? "(未知)" };
  }
  if (row === null) return { kind: "missing" };
  if (!isProjectRole(row.role)) return { kind: "role_unknown", rawRole: row.role };
  return {
    kind: "ok",
    agent: {
      id: row.id,
      role: row.role,
      displayName: row.displayName,
      ...(row.specialization !== null ? { specialization: row.specialization } : {}),
    },
  };
}

/**
 * 组装一次工具调用所需的上下文。
 *
 * ── `projectId === null` = 接待模式(第一个项目之前)────────────────
 *
 * 那条 `project_id IS NULL` 的接待会话还没有任何项目可校验,所以:
 *   - **只校验 agent 存在**(以及它的角色能认出来);
 *   - 跳过项目校验与成员校验(没有项目,也没有花名册);
 *   - 返回的 ctx 里 `project` 为 `null`。
 *
 * 为什么这样是安全的:接待模式下能拿到的工具面由 `solveToolset(agent, null)` 决定,
 * 只有 `project.open` / `memory.read` / `memory.write`(见 harness/authorize.ts 的
 * `INTAKE_CAPABILITIES`);「成员校验」防的是「不属于该项目的 agent 拿到该项目的
 * 工具面」,而接待模式根本没有项目可拿。
 *
 * **失败一律显式返回原因,不做兜底**:
 *   - agent 不存在 / 角色未知 → no_such_agent / role_unknown
 *   - 项目不存在 → no_such_project
 *   - **agent 不在项目里 → agent_not_assigned** —— 这一条是关键:
 *     不校验的话,一个不属于该项目的 agent 能拿到该项目的 ctx,于是
 *     `solveToolset` 的 scope 门形同虚设(它只看 project.status)。
 */
export function buildToolContext(
  deps: RuntimeDeps,
  agentId: string,
  projectId: string | null,
): AssemblyResult {
  const loaded = loadAgent(deps.db, agentId);
  if (loaded.kind === "missing") {
    return { ok: false, reason: "no_such_agent", detail: `找不到 agent ${agentId}` };
  }
  if (loaded.kind === "role_unknown") {
    return {
      ok: false,
      reason: "role_unknown",
      detail: `agent ${agentId} 的角色「${loaded.rawRole}」未定义 —— ROLE_SPECS 里没有它,授权无从判定`,
    };
  }
  const agent = loaded.agent;

  const base = {
    db: deps.db,
    agent,
    now: deps.now ?? (() => Date.now()),
    newId: deps.newId ?? defaultNewId,
    ...(deps.memory !== undefined ? { memory: deps.memory } : {}),
    ...(deps.client !== undefined ? { client: deps.client } : {}),
    ...(deps.onStateChange !== undefined ? { nudge: deps.onStateChange } : {}),
  } satisfies Omit<ToolRunContext, "project">;

  if (projectId === null) {
    return { ok: true, ctx: { ...base, project: null }, project: null };
  }

  const project = loadProjectForAuthz(deps.db, projectId);
  if (project === null) {
    return { ok: false, reason: "no_such_project", detail: `找不到项目 ${projectId}` };
  }

  const assigned = project.assignments.some(
    (a) => a.agentId === agentId && a.removedAt === undefined,
  );
  if (!assigned) {
    return {
      ok: false,
      reason: "agent_not_assigned",
      detail: `agent ${agentId} 不是项目 ${projectId} 的活跃成员 —— 未参与就没有该项目的工具面`,
    };
  }

  return { ok: true, ctx: { ...base, project }, project };
}

/** 默认 id 生成。nanoid 的替代 —— 避免为一次 id 引入依赖,且格式可控。 */
function defaultNewId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

// ── 会话级装配 ──────────────────────────────────────────────────

export interface AgentSessionPlan {
  readonly agent: Agent;
  /** `null` = 接待会话(第一个项目之前) */
  readonly project: Project | null;
  /** 该会话可用的工具名(已过三重门控) */
  readonly tools: readonly ToolName[];
  /** 该会话的能力面(报告用) */
  readonly capabilities: readonly Capability[];
  readonly blockedByCeiling: readonly string[];
  readonly blockedByScope: readonly string[];
  readonly unknownTools: readonly string[];
  /** 该角色装载的提示词单元 id */
  readonly promptUnits: readonly string[];
  /** 项目花名册(工具解析 {role,spec} 时用)。接待模式下为空 —— 还没有项目 */
  readonly roster: ReadonlyArray<{ id: string; role: string; displayName: string }>;
}

export type PlanResult =
  | { readonly ok: true; readonly plan: AgentSessionPlan }
  | AssemblyFailure;

/**
 * 规划一个 agent 在某个项目里的会话:算工具面、取提示词单元、取花名册。
 *
 * **这是「接线」的核心一步** —— `solveToolset` 在这里第一次被真实调用。
 * 它与 `buildToolContext` 分开:规划是会话建立时做一次,ctx 组装是每次调用做。
 *
 * `projectId === null` = 接待会话:工具面由 `solveToolset(agent, null)` 决定,
 * 花名册为空。技能上它与项目会话走**同一条**代码路径 —— 差别只在 project 是 null。
 */
export function planAgentSession(
  deps: RuntimeDeps,
  agentId: string,
  projectId: string | null,
): PlanResult {
  const assembled = buildToolContext(deps, agentId, projectId);
  if (!assembled.ok) return assembled;

  const { ctx, project } = assembled;
  const solved = solveToolset(ctx.agent, project, deps.toolSetFor?.(ctx.agent.role));

  return {
    ok: true,
    plan: {
      agent: ctx.agent,
      project,
      tools: solved.tools,
      capabilities: solved.capabilities,
      blockedByCeiling: solved.blockedByCeiling.map((d) => d.subject),
      blockedByScope: solved.blockedByScope.map((d) => d.subject),
      unknownTools: solved.unknownTools.map((d) => d.subject),
      promptUnits: ROLE_SPECS[ctx.agent.role].promptUnits,
      roster:
        projectId === null
          ? []
          : loadProjectRoster(deps.db, projectId).map((m) => ({
              id: m.id,
              role: m.role,
              displayName: m.displayName,
            })),
    },
  };
}
