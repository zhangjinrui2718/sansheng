/**
 * 平台运行时 · 组织
 *
 * ── 为什么单独一个模块 ──────────────────────────────────────────
 *
 * 「这个系统里有哪几个人」是**平台级事实**,不是 CLI 的实现细节。CLI 与
 * HTTP 都要用它(建项目时要知道把谁加进成员、跑工作项时要找 worker)。
 * 原先它写在 `cli/run.ts` 里,HTTP 一来就得复制一份 —— 复制的那份迟早会漂。
 */
import type Database from "better-sqlite3";
import { insertAgent, getAgent, listAgents, type AgentRow } from "../storage/repo/agents.js";
import { addMember } from "../storage/repo/projects.js";
import type { ProjectRole, Specialization } from "../identity/role.js";

export interface OrgMember {
  readonly id: string;
  readonly role: ProjectRole;
  readonly spec: Specialization | null;
  readonly name: string;
}

/**
 * 固定组织:四个角色各一人。
 *
 * **一人一角色**是刻意的起点。worker 的 specialization 用枚举
 * (`engineering|algorithm|data`)而不是自由文本 —— 经校准的裁决:枚举是
 * 代码内常量,自由文本是数据;前者要改得走代码评审,后者谁都能改。
 * 想加「前端」时改的是代码,那是**特性不是缺陷**。
 */
export const ORG: readonly OrgMember[] = [
  { id: "bm", role: "business_manager", spec: null, name: "业务经理" },
  { id: "pm", role: "project_manager", spec: null, name: "项目经理" },
  { id: "wk", role: "worker", spec: "engineering", name: "工程师" },
  { id: "qa", role: "quality_reviewer", spec: null, name: "质检" },
];

/**
 * 按需播种组织。**幂等**,但返回本次新建了哪些 —— 幂等不等于静默:
 * 「我什么都没做」和「我建了四个人」是不同的信息。
 */
export function ensureOrg(db: Database.Database, at: number): string[] {
  const created: string[] = [];
  for (const m of ORG) {
    if (getAgent(db, m.id) !== null) continue;
    insertAgent(db, {
      id: m.id,
      role: m.role,
      specialization: m.spec,
      displayName: m.name,
      createdAt: at,
    });
    created.push(`${m.id}(${m.name}/${m.role})`);
  }
  return created;
}

/** 组织是否已就位(HTTP 路由用它决定要不要报「先跑一次 CLI」)。 */
export function orgReady(db: Database.Database): boolean {
  return ORG.every((m) => getAgent(db, m.id) !== null);
}

/**
 * 把一个项目**应有的组织**放进项目成员表。幂等。
 *
 * ── 为什么必须有这一条(这是驱动者循环的前置)─────────────────────
 *
 * `project_open` 原本只把**立项人**(业务经理)加成成员。后果不是「少几个人看」,
 * 是**组织根本动不起来**:
 *
 *   - `buildToolContext` 对非成员返回 `agent_not_assigned` → 项目经理/worker/质检
 *     的会话**建不出来**,驱动者循环第一步就撞墙(实测形态:`projects=1, works=0`)
 *   - `resolveAssignee` 走 `loadProjectRoster` → 项目经理 `work_create` 时
 *     「项目里没有 worker 角色的成员」,**拆解当场失败**
 *
 * 也就是说「立项之后组织自动接手」这件事在此之前**结构上不可能发生** ——
 * 而它不会以报错的形式出现,只会以「什么都没发生」的形式出现。
 *
 * 与 `ensureOrg` 同一条理由:幂等不等于静默,这里返回本次真正加了谁。
 */
export function ensureProjectOrg(
  db: Database.Database,
  projectId: string,
  at: number,
): string[] {
  const added: string[] = [];
  for (const m of ORG) {
    if (getAgent(db, m.id) === null) {
      // 组织还没播种(例如 project_open 直接在空库上跑)——
      // 在这里补种,而不是让项目带着一个不存在的成员。
      insertAgent(db, {
        id: m.id, role: m.role, specialization: m.spec,
        displayName: m.name, createdAt: at,
      });
      added.push(m.id);
    }
    addMember(db, projectId, m.id, at);
  }
  return added;
}

export function findAgentByRole(db: Database.Database, role: ProjectRole): AgentRow | null {
  return listAgents(db).find((a) => a.role === role) ?? null;
}

/** 找可用的 worker。指定 id 时校验它真的是 worker —— 否则会派错人。 */
export function pickWorker(db: Database.Database, wanted?: string): AgentRow | null {
  if (wanted !== undefined) {
    const a = getAgent(db, wanted);
    return a !== null && a.role === "worker" ? a : null;
  }
  return findAgentByRole(db, "worker");
}
