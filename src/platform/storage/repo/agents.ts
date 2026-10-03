/**
 * BC0 Identity · agents 仓储
 *
 * 角色是「全局的人」:创建后不随项目变化,`clientFacing` 这类属性**不入库**
 * (它是 `ROLE_SPECS` 的代码内常量,入库就有了被篡改的路径)。
 *
 * 仓储函数一律以 `db` 为第一参数、不自己持有连接 —— 沿用旧侧 repo 的形态,
 * 这样测试可以直接给内存库,也不需要为「谁是单例」做决定。
 */
import type Database from "better-sqlite3";
import {
  isProjectRole,
  isSpecialization,
  type ProjectRole,
  type Specialization,
} from "../../identity/role.js";

export interface AgentRow {
  id: string;
  role: ProjectRole;
  specialization: Specialization | null;
  displayName: string;
  createdAt: number;
}

/** 数据库原始行(列名为 snake_case) */
interface RawAgent {
  id: string;
  role: string;
  specialization: string | null;
  display_name: string;
  created_at: number;
}

/**
 * 行 → 领域对象。**在边界处校验闭合集** —— 不让一个没见过的 role 字符串
 * 冒充 `ProjectRole` 流进授权求解器(那里是 `ROLE_SPECS[role]` 直接索引,
 * 拿到未知值会静默取到 undefined)。
 */
function rowToAgent(raw: RawAgent): AgentRow {
  if (!isProjectRole(raw.role)) {
    throw new Error(`agents 表里出现未定义角色「${raw.role}」(id=${raw.id})`);
  }
  let spec: Specialization | null = null;
  if (raw.specialization !== null) {
    if (!isSpecialization(raw.specialization)) {
      throw new Error(`agents 表里出现未定义 specialization「${raw.specialization}」(id=${raw.id})`);
    }
    spec = raw.specialization;
  }
  return {
    id: raw.id,
    role: raw.role,
    specialization: spec,
    displayName: raw.display_name,
    createdAt: raw.created_at,
  };
}

export function insertAgent(db: Database.Database, row: AgentRow): void {
  db.prepare(
    `INSERT INTO agents (id, role, specialization, display_name, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(row.id, row.role, row.specialization, row.displayName, row.createdAt);
}

export function getAgent(db: Database.Database, id: string): AgentRow | null {
  const raw = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as RawAgent | undefined;
  return raw ? rowToAgent(raw) : null;
}

export function listAgents(db: Database.Database): AgentRow[] {
  const rows = db.prepare(`SELECT * FROM agents ORDER BY role, display_name`).all() as RawAgent[];
  return rows.map(rowToAgent);
}

export function listAgentsByRole(db: Database.Database, role: ProjectRole): AgentRow[] {
  const rows = db
    .prepare(`SELECT * FROM agents WHERE role = ? ORDER BY specialization, display_name`)
    .all(role) as RawAgent[];
  return rows.map(rowToAgent);
}

/**
 * 按角色 + 细分找人。设计 1 §3.3 的「角色解析」落到这里 ——
 * 工具收 `{role, spec?}`,解析到具体 agent_id。
 *
 * 返回**候选列表**而不是单个结果:歧义(同角色多人且未给 spec)必须由调用方
 * 显式处理并回报给模型,不许隐式挑一个。设计 1 §3.3 明确否决了隐式兜底。
 */
export function findAgents(
  db: Database.Database,
  role: ProjectRole,
  specialization?: Specialization,
): AgentRow[] {
  if (specialization === undefined) return listAgentsByRole(db, role);
  const rows = db
    .prepare(`SELECT * FROM agents WHERE role = ? AND specialization = ? ORDER BY display_name`)
    .all(role, specialization) as RawAgent[];
  return rows.map(rowToAgent);
}

export function deleteAgent(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
}
