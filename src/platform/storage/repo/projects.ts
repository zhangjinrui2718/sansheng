/**
 * BC1 ProjectManagement · projects / project_assignments 仓储
 *
 * `Project` 在这里落成数据,并被 `harness/authorize.ts` 的 `solveToolset` 消费 ——
 * 授权求解需要一个真实的项目(状态 + 参与关系),这也是本批次把 BC1 的表
 * 与 BC0 一起建的原因。
 */
import type Database from "better-sqlite3";
import type { Project, ProjectAssignment, ProjectStatus } from "../../harness/authorize.js";

export interface ProjectRow {
  id: string;
  name: string;
  client: string;
  goal: string;
  status: ProjectStatus;
  createdAt: number;
  closedAt: number | null;
}

const PROJECT_STATUSES: readonly ProjectStatus[] = [
  "draft",
  "active",
  "paused",
  "done",
  "abandoned",
];

export function isProjectStatus(v: unknown): v is ProjectStatus {
  return typeof v === "string" && (PROJECT_STATUSES as readonly string[]).includes(v);
}

interface RawProject {
  id: string;
  name: string;
  client: string;
  goal: string;
  status: string;
  created_at: number;
  closed_at: number | null;
}

function rowToProject(raw: RawProject): ProjectRow {
  if (!isProjectStatus(raw.status)) {
    throw new Error(`projects 表里出现未定义状态「${raw.status}」(id=${raw.id})`);
  }
  return {
    id: raw.id,
    name: raw.name,
    client: raw.client,
    goal: raw.goal,
    status: raw.status,
    createdAt: raw.created_at,
    closedAt: raw.closed_at,
  };
}

// ── projects ────────────────────────────────────────────────────

export function insertProject(
  db: Database.Database,
  row: Omit<ProjectRow, "closedAt"> & { closedAt?: number | null },
): void {
  db.prepare(
    `INSERT INTO projects (id, name, client, goal, status, created_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.name, row.client, row.goal, row.status, row.createdAt, row.closedAt ?? null);
}

export function getProjectRow(db: Database.Database, id: string): ProjectRow | null {
  const raw = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as RawProject | undefined;
  return raw ? rowToProject(raw) : null;
}

export function listProjects(db: Database.Database, status?: ProjectStatus): ProjectRow[] {
  const rows = (
    status === undefined
      ? db.prepare(`SELECT * FROM projects ORDER BY created_at DESC`).all()
      : db.prepare(`SELECT * FROM projects WHERE status = ? ORDER BY created_at DESC`).all(status)
  ) as RawProject[];
  return rows.map(rowToProject);
}

/**
 * 改非终态字段(status 限 active|paused)。终态走 `closeProject` ——
 * 设计 1 §6.3 把 `done|abandoned` 划为不可逆,单独一个动词让它在调用点显眼。
 */
export function updateProject(
  db: Database.Database,
  id: string,
  fields: { name?: string; goal?: string; status?: "active" | "paused" },
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.name !== undefined) { sets.push("name = ?"); vals.push(fields.name); }
  if (fields.goal !== undefined) { sets.push("goal = ?"); vals.push(fields.goal); }
  if (fields.status !== undefined) { sets.push("status = ?"); vals.push(fields.status); }
  if (sets.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

/** 关项目(终态,不可逆)。已经是终态时抛错 —— 静默幂等会让「关错了」查不出来。 */
export function closeProject(
  db: Database.Database,
  id: string,
  outcome: "done" | "abandoned",
  closedAt: number,
): void {
  const cur = getProjectRow(db, id);
  if (!cur) throw new Error(`项目不存在:${id}`);
  if (cur.status === "done" || cur.status === "abandoned") {
    throw new Error(`项目 ${id} 已是终态(${cur.status}),不能重复关闭`);
  }
  db.prepare(`UPDATE projects SET status = ?, closed_at = ? WHERE id = ?`).run(
    outcome,
    closedAt,
    id,
  );
}

// ── project_assignments ─────────────────────────────────────────

export function addMember(db: Database.Database, projectId: string, agentId: string, at: number): void {
  // 曾经移出过再加入 → 复用同一行(主键是 project_id+agent_id),清掉 removed_at
  db.prepare(
    `INSERT INTO project_assignments (project_id, agent_id, added_at, removed_at)
     VALUES (?, ?, ?, NULL)
     ON CONFLICT(project_id, agent_id) DO UPDATE SET added_at = excluded.added_at, removed_at = NULL`,
  ).run(projectId, agentId, at);
}

/** 软删除:保留「谁什么时候参与过」的痕迹(审计面的一部分)。 */
export function removeMember(
  db: Database.Database,
  projectId: string,
  agentId: string,
  at: number,
): void {
  db.prepare(
    `UPDATE project_assignments SET removed_at = ?
     WHERE project_id = ? AND agent_id = ? AND removed_at IS NULL`,
  ).run(at, projectId, agentId);
}

export function listAssignments(db: Database.Database, projectId: string): ProjectAssignment[] {
  const rows = db
    .prepare(
      `SELECT agent_id, removed_at FROM project_assignments
       WHERE project_id = ? ORDER BY added_at`,
    )
    .all(projectId) as Array<{ agent_id: string; removed_at: number | null }>;
  return rows.map((r) => ({
    agentId: r.agent_id,
    ...(r.removed_at !== null ? { removedAt: r.removed_at } : {}),
  }));
}

export interface ProjectMemberRow {
  id: string;
  role: string;
  specialization: string | null;
  displayName: string;
}

/**
 * 项目的**活跃成员**花名册(带角色与细分)。
 *
 * 工具解析 `{role, spec?}` → agent_id 时要用它。放在这里而不是 tools 层,
 * 是因为它纯粹是「参与关系 × agents 表」的 join —— 属于查询,不属于业务。
 */
export function loadProjectRoster(db: Database.Database, projectId: string): ProjectMemberRow[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.role, a.specialization, a.display_name
       FROM project_assignments pa
       JOIN agents a ON a.id = pa.agent_id
       WHERE pa.project_id = ? AND pa.removed_at IS NULL
       ORDER BY a.role, a.specialization, a.display_name`,
    )
    .all(projectId) as Array<{ id: string; role: string; specialization: string | null; display_name: string }>;
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    specialization: r.specialization,
    displayName: r.display_name,
  }));
}

/**
 * 拼出授权求解器要的 `Project`(状态 + 参与关系),一次查询完成。
 *
 * 这是 platform 与 authorize 的接缝:求解器只认这个形状,不认仓储。
 */
export function loadProjectForAuthz(db: Database.Database, id: string): Project | null {
  const row = getProjectRow(db, id);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    assignments: listAssignments(db, id),
  };
}
