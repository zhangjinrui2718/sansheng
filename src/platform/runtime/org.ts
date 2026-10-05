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
 *
 * ── ⚠️ 这四个 `name` 是**界面里角色中文名的唯一来源**(2026-10-06)────────
 *
 * 在此之前同一个角色在界面上有**三个名字**:harness 页读 `transport/http.ts`
 * 一张私有表(写成 `Worker(执行者)` —— 一个名字里塞进一句解释),成员页读
 * `agents.display_name`(播种值 = 本表),而前端 `lib/vocab.ts` 的兜底表又写成
 * `执行者` / `质检审查员`。用户的原话是「harness 页面和成员页面四个角色的命名
 * 统一一下,就不要有解释了」。
 *
 * 现在:
 *   - 播种(`ensureOrg` / `ensureProjectOrg`)用本表;
 *   - `RoleHarnessView.displayName` 走 `roleDisplayName()`,**也**读本表;
 *   - 前端 `ROLE_LABEL` 的兜底值与本表逐项相同,并由
 *     `tests/web/role-names.test.ts` 做**跨边界对照**(两边不许再漂)。
 *
 * ⚠️ 设计文档(`docs/DESIGN-AGENTS.md`)的角色表用的是**代号读法**(`Worker` /
 * `质检审查员`)—— 那是文档对**角色**的称呼,不是运行期显示名;本表才是运行期的
 * 那一份。改这里不必改文档,反之亦然,但**两处都不许再长出第三份**。
 */
export const ORG: readonly OrgMember[] = [
  { id: "bm", role: "business_manager", spec: null, name: "业务经理" },
  { id: "pm", role: "project_manager", spec: null, name: "项目经理" },
  { id: "wk", role: "worker", spec: "engineering", name: "工程师" },
  { id: "qa", role: "quality_reviewer", spec: null, name: "质检" },
];

/**
 * 角色的**界面显示名**(中文)—— `ORG` 是唯一来源。
 *
 * 查不到时兜底返回 `role`(英文代号)而不是空串:界面上出现 `worker` 是
 * **看得出来的**「这个名字没配」,而空串在屏幕上只是一片空白(与 `vocab.ts`
 * 「未知取值原样透出,不猜」同一条纪律)。
 */
export function roleDisplayName(role: ProjectRole): string {
  return ORG.find((m) => m.role === role)?.name ?? role;
}

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
