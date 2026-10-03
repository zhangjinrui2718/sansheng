/**
 * 角色 → agent 解析(设计 1 §3.3)
 *
 * 工具参数用 `{role, spec?}` 表达(agent 想的是「交给算法负责人」,不是
 * 「交给 agent_7f3a」),但存储的外键是 `agent_id`。中间这次解析**必须显式
 * 处理三种失败**,不做隐式兜底:
 *
 *   该项目里没有该角色的 agent   → no_such_role
 *   该角色有多个 agent 且未给 spec → ambiguous(迫使模型明确)
 *   给了 spec 但没有匹配          → no_such_spec
 *
 * 为什么不做「随便挑一个同角色的」:那会让「交接给了谁」不可预测,与 7-L
 * 「落库路径唯一」的纪律冲突 —— 事后查不出这件事到底交给了谁。
 */
import type Database from "better-sqlite3";
import { loadProjectRoster, type ProjectMemberRow } from "../storage/repo/projects.js";
import { isProjectRole, SPECIALIZATIONS, type ProjectRole, type Specialization } from "../identity/role.js";
import type { ResolveResult } from "./types.js";

/**
 * 在项目内按角色(+可选细分)解析出唯一的 agent。
 *
 * **自己查花名册**而不是让调用方传:每个工具都要解析,传参会让每个工具都
 * 先做一次相同的查询,而忘了传就是一个静默的错误来源。
 */
export function resolveAssignee(
  db: Database.Database,
  projectId: string,
  role: unknown,
  spec?: unknown,
): ResolveResult {
  const roster = loadProjectRoster(db, projectId);

  if (!isProjectRole(role)) {
    return {
      ok: false,
      reason: "no_such_role",
      message: `未知角色「${String(role)}」`,
      alternatives: distinctRoles(roster),
    };
  }
  const roleTyped: ProjectRole = role;

  const inProject = roster.filter((a) => a.role === roleTyped);
  if (inProject.length === 0) {
    return {
      ok: false,
      reason: "no_such_role",
      message: `项目 ${projectId} 里没有 ${roleTyped} 角色的成员`,
      alternatives: distinctRoles(roster),
    };
  }

  // 给了 spec:按细分过滤
  if (spec !== undefined) {
    if (typeof spec !== "string" || !(SPECIALIZATIONS as readonly string[]).includes(spec)) {
      return {
        ok: false,
        reason: "no_such_spec",
        message: `未知细分「${String(spec)}」`,
        alternatives: [...SPECIALIZATIONS],
      };
    }
    const wanted: Specialization = spec as Specialization;
    const matched = inProject.filter((a) => a.specialization === wanted);
    if (matched.length === 0) {
      return {
        ok: false,
        reason: "no_such_spec",
        message: `${roleTyped} 里没有细分「${wanted}」的成员`,
        alternatives: distinctSpecs(inProject),
      };
    }
    if (matched.length > 1) {
      return {
        ok: false,
        reason: "ambiguous",
        message: `${roleTyped}/${wanted} 有多名成员,无法确定交给谁`,
        alternatives: matched.map((a) => a.id).sort(),
      };
    }
    return { ok: true, agentId: matched[0]!.id };
  }

  // 未给 spec:该角色唯一才能自动确定
  if (inProject.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      message: `${roleTyped} 有多名成员(${inProject.length} 名),必须用 spec 指明交给谁`,
      alternatives: inProject
        .map((a) => (a.specialization !== null ? `${a.id}←spec=${a.specialization}` : a.id))
        .sort(),
    };
  }
  return { ok: true, agentId: inProject[0]!.id };
}

function distinctRoles(roster: readonly ProjectMemberRow[]): string[] {
  return [...new Set(roster.map((a) => a.role))].sort();
}

function distinctSpecs(roster: readonly ProjectMemberRow[]): string[] {
  return [
    ...new Set(
      roster
        .map((a) => a.specialization)
        .filter((s): s is string => s !== null),
    ),
  ].sort();
}
