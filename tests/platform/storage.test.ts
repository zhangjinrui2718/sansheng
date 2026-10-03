/**
 * 平台存储层 · migration 007 + BC0/BC1 仓储
 *
 * 测的重点不是 CRUD 能不能跑通,而是**约束是不是真的在生效**:
 *   - 闭合集 CHECK(role / status / specialization)
 *   - 外键 REFERENCES(SQLite 默认 OFF,忘了开 pragma 就全形同虚设)
 *   - 「只有 worker 有 specialization」的触发器
 *   - **DAG 环检测** —— 旧代码在这里踩过「DAG 通配 bug」,死循环的表现是
 *     「计划永远跑不完」,事后极难归因
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb, openPlatformDb } from "../../src/platform/storage/index.js";
import {
  insertAgent, getAgent, listAgents, listAgentsByRole, findAgents, deleteAgent,
} from "../../src/platform/storage/repo/agents.js";
import {
  insertProject, getProjectRow, listProjects, updateProject, closeProject,
  addMember, removeMember, listAssignments, loadProjectForAuthz, isProjectStatus,
} from "../../src/platform/storage/repo/projects.js";
import {
  insertWork, getWork, listWorks, updateWorkStatus, assignWork,
  addDep, removeDep, listDeps, listDependents, createsCycle, depState,
  depsSatisfied, isWorkStatus, isTerminalWorkStatus,
  type WorkRow,
} from "../../src/platform/storage/repo/works.js";
import { solveToolset } from "../../src/platform/harness/authorize.js";
import type { ProjectRole, Specialization } from "../../src/platform/identity/role.js";

let db: Database.Database;

beforeEach(() => {
  db = openPlatformMemoryDb();
});
afterEach(() => {
  db.close();
});

// ── fixtures ─────────────────────────────────────────────────────

let seq = 0;
const T0 = 1_700_000_000_000;

function mkAgent(role: ProjectRole, specialization?: Specialization): string {
  const id = `ag${++seq}`;
  insertAgent(db, {
    id, role,
    specialization: specialization ?? null,
    displayName: `${role}-${seq}`,
    createdAt: T0 + seq,
  });
  return id;
}

function mkProject(status: "draft" | "active" | "paused" = "active"): string {
  const id = `pj${++seq}`;
  insertProject(db, {
    id, name: `项目${seq}`, client: "甲方", goal: "目标",
    status, createdAt: T0 + seq,
  });
  return id;
}

function mkWork(
  projectId: string,
  assigneeAgentId: string,
  over: Partial<WorkRow> = {},
): string {
  const id = `wk${++seq}`;
  insertWork(db, {
    id, projectId, parentWorkId: null, title: `工作${seq}`, goal: "做点什么",
    status: "open", assigneeAgentId, createdAt: T0 + seq, updatedAt: T0 + seq,
    ...over,
  });
  return id;
}

// ── migration ───────────────────────────────────────────────────

describe("migration 007 · 表就位", () => {
  it("五张平台表都建好了", () => {
    const rows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN
                ('agents','projects','project_assignments','works','work_deps')`)
      .all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name).sort()).toEqual([
      "agents", "project_assignments", "projects", "work_deps", "works",
    ]);
  });

  it("版本 7 记进了 schema_version", () => {
    const row = db.prepare(`SELECT name FROM schema_version WHERE version = 7`).get() as
      | { name: string }
      | undefined;
    expect(row?.name).toBe("platform_core");
  });

  it("旧表仍在(并存而非替换)", () => {
    const rows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN
                ('conversations','messages','fragments','agent_states','blackboards')`)
      .all() as Array<{ name: string }>;
    expect(rows.length, "007 不该删掉任何旧表 —— 那是最后阶段的事").toBe(5);
  });

  it("外键是开着的(SQLite 默认 OFF,忘了开 pragma 则 REFERENCES 全形同虚设)", () => {
    const [row] = db.pragma("foreign_keys") as Array<{ foreign_keys: number }>;
    expect(row?.foreign_keys).toBe(1);
  });

  it("重复打开同一个库是幂等的(集合判定,002 vec 缺失只 skip 不炸)", () => {
    // 第二次跑迁移不该抛错
    expect(() => openPlatformDb(":memory:")).not.toThrow();
  });
});

// ── BC0 agents ──────────────────────────────────────────────────

describe("BC0 · agents", () => {
  it("插入与读取", () => {
    const id = mkAgent("worker", "algorithm");
    const a = getAgent(db, id);
    expect(a).toMatchObject({ id, role: "worker", specialization: "algorithm" });
  });

  it("非法 role 被 CHECK 拒绝", () => {
    expect(() =>
      db.prepare(
        `INSERT INTO agents (id, role, specialization, display_name, created_at)
         VALUES ('x','ceo',NULL,'x',1)`,
      ).run(),
    ).toThrow(/CHECK/i);
  });

  it("非法 specialization 被 CHECK 拒绝", () => {
    expect(() =>
      db.prepare(
        `INSERT INTO agents (id, role, specialization, display_name, created_at)
         VALUES ('x','worker','frontend','x',1)`,
      ).run(),
    ).toThrow(/CHECK/i);
  });

  it("非 worker 带 specialization 被触发器拒绝", () => {
    expect(() =>
      db.prepare(
        `INSERT INTO agents (id, role, specialization, display_name, created_at)
         VALUES ('x','project_manager','data','x',1)`,
      ).run(),
    ).toThrow(/specialization 只对 worker 有意义/);
  });

  it("listAgentsByRole / findAgents 按角色与细分过滤", () => {
    const algo = mkAgent("worker", "algorithm");
    const eng = mkAgent("worker", "engineering");
    mkAgent("project_manager");

    expect(listAgentsByRole(db, "worker").map((a) => a.id).sort()).toEqual([algo, eng].sort());
    expect(findAgents(db, "worker", "algorithm").map((a) => a.id)).toEqual([algo]);
    expect(findAgents(db, "worker", "data")).toEqual([]);
    // 不给 spec → 全部候选(歧义由调用方处理,不隐式挑一个)
    expect(findAgents(db, "worker").length).toBe(2);
  });

  it("行 → 领域对象的边界校验:数据库里出现未知 role 会抛错而不是静默放行", () => {
    // 绕过 CHECK 直接改(模拟旧数据/外部写入)
    const id = mkAgent("worker");
    db.pragma("ignore_check_constraints = ON");
    db.prepare(`UPDATE agents SET role = 'ceo' WHERE id = ?`).run(id);
    db.pragma("ignore_check_constraints = OFF");
    expect(() => getAgent(db, id)).toThrow(/未定义角色/);
  });

  it("deleteAgent 生效", () => {
    const id = mkAgent("quality_reviewer");
    deleteAgent(db, id);
    expect(getAgent(db, id)).toBeNull();
  });

  it("listAgents 覆盖全部角色", () => {
    mkAgent("business_manager");
    mkAgent("project_manager");
    mkAgent("worker", "data");
    mkAgent("quality_reviewer");
    expect(listAgents(db)).toHaveLength(4);
  });
});

// ── BC1 projects ────────────────────────────────────────────────

describe("BC1 · projects", () => {
  it("插入与读取", () => {
    const id = mkProject();
    expect(getProjectRow(db, id)).toMatchObject({ id, status: "active", closedAt: null });
  });

  it("非法 status 被 CHECK 拒绝", () => {
    expect(() =>
      db.prepare(
        `INSERT INTO projects (id,name,client,goal,status,created_at)
         VALUES ('x','n','c','g','archived',1)`,
      ).run(),
    ).toThrow(/CHECK/i);
  });

  it("isProjectStatus 与 schema 的闭合集一致", () => {
    for (const s of ["draft", "active", "paused", "done", "abandoned"]) {
      expect(isProjectStatus(s)).toBe(true);
    }
    expect(isProjectStatus("archived")).toBe(false);
  });

  it("updateProject 只能改非终态字段", () => {
    const id = mkProject();
    updateProject(db, id, { name: "改名", goal: "新目标", status: "paused" });
    expect(getProjectRow(db, id)).toMatchObject({ name: "改名", goal: "新目标", status: "paused" });
  });

  it("closeProject 落终态并记 closed_at", () => {
    const id = mkProject();
    closeProject(db, id, "done", T0 + 999);
    expect(getProjectRow(db, id)).toMatchObject({ status: "done", closedAt: T0 + 999 });
  });

  it("重复关闭报错(静默幂等会让「关错了」查不出来)", () => {
    const id = mkProject();
    closeProject(db, id, "done", T0);
    expect(() => closeProject(db, id, "abandoned", T0 + 1)).toThrow(/已是终态/);
  });

  it("关闭不存在的项目报错", () => {
    expect(() => closeProject(db, "nope", "done", T0)).toThrow(/不存在/);
  });

  it("listProjects 可按状态过滤", () => {
    const a = mkProject("active");
    mkProject("draft");
    expect(listProjects(db, "active").map((p) => p.id)).toEqual([a]);
    expect(listProjects(db)).toHaveLength(2);
  });
});

// ── BC1 assignments ─────────────────────────────────────────────

describe("BC1 · project_assignments", () => {
  it("加入与列出", () => {
    const p = mkProject();
    const a = mkAgent("worker", "engineering");
    addMember(db, p, a, T0);
    expect(listAssignments(db, p)).toEqual([{ agentId: a }]);
  });

  it("外键挡住不存在的项目/agent", () => {
    const p = mkProject();
    expect(() => addMember(db, p, "ghost", T0)).toThrow(/FOREIGN KEY/i);
    expect(() => addMember(db, "ghost-project", mkAgent("worker"), T0)).toThrow(/FOREIGN KEY/i);
  });

  it("移出是软删除:removedAt 落值,行还在", () => {
    const p = mkProject();
    const a = mkAgent("worker");
    addMember(db, p, a, T0);
    removeMember(db, p, a, T0 + 5);
    const list = listAssignments(db, p);
    expect(list).toHaveLength(1);
    expect(list[0]!.removedAt).toBe(T0 + 5);
  });

  it("移出后重新加入 → removedAt 清空(历史痕迹不留成「已移出」状态)", () => {
    const p = mkProject();
    const a = mkAgent("worker");
    addMember(db, p, a, T0);
    removeMember(db, p, a, T0 + 5);
    addMember(db, p, a, T0 + 10);
    expect(listAssignments(db, p)[0]!.removedAt).toBeUndefined();
  });

  it("级联:删项目带走它的成员关系", () => {
    const p = mkProject();
    const a = mkAgent("worker");
    addMember(db, p, a, T0);
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(p);
    expect(listAssignments(db, p)).toEqual([]);
  });
});

// ── BC1 works ───────────────────────────────────────────────────

describe("BC1 · works", () => {
  it("插入与读取", () => {
    const p = mkProject();
    const a = mkAgent("worker", "algorithm");
    const w = mkWork(p, a);
    expect(getWork(db, w)).toMatchObject({ projectId: p, assigneeAgentId: a, status: "open" });
  });

  it("assignee 必填(schema 层面拒绝无主工作)", () => {
    const p = mkProject();
    expect(() =>
      db.prepare(
        `INSERT INTO works (id,project_id,parent_work_id,title,goal,status,assignee_agent_id,created_at,updated_at)
         VALUES ('x',?,'','t','g','open',NULL,1,1)`,
      ).run(p),
    ).toThrow(/NOT NULL/i);
  });

  it("非法 status 被 CHECK 拒绝", () => {
    const p = mkProject();
    const a = mkAgent("worker");
    expect(() =>
      db.prepare(
        `INSERT INTO works (id,project_id,parent_work_id,title,goal,status,assignee_agent_id,created_at,updated_at)
         VALUES ('x',?,NULL,'t','g','doing',?,1,1)`,
      ).run(p, a),
    ).toThrow(/CHECK/i);
  });

  it("assignee 必须指向真实 agent(外键)", () => {
    const p = mkProject();
    expect(() => mkWork(p, "ghost")).toThrow(/FOREIGN KEY/i);
  });

  it("listWorks 支持按状态 / 负责人 / 父项 / 顶层过滤", () => {
    const p = mkProject();
    const a1 = mkAgent("worker", "algorithm");
    const a2 = mkAgent("worker", "engineering");
    const root = mkWork(p, a1);
    const child = mkWork(p, a2, { parentWorkId: root });
    mkWork(p, a1, { status: "in_progress" });

    expect(listWorks(db, p)).toHaveLength(3);
    expect(listWorks(db, p, { rootsOnly: true })).toHaveLength(2);
    expect(listWorks(db, p, { parentWorkId: root })).toEqual([expect.objectContaining({ id: child })]);
    expect(listWorks(db, p, { assigneeAgentId: a2 })).toHaveLength(1);
    expect(listWorks(db, p, { status: "in_progress" })).toHaveLength(1);
  });

  it("updateWorkStatus / assignWork", () => {
    const p = mkProject();
    const a1 = mkAgent("worker", "algorithm");
    const a2 = mkAgent("worker", "data");
    const w = mkWork(p, a1);
    updateWorkStatus(db, w, "in_progress", T0 + 100);
    assignWork(db, w, a2, T0 + 101);
    expect(getWork(db, w)).toMatchObject({
      status: "in_progress", assigneeAgentId: a2, updatedAt: T0 + 101,
    });
  });

  it("isTerminalWorkStatus 只认三个终态", () => {
    expect(isTerminalWorkStatus("done")).toBe(true);
    expect(isTerminalWorkStatus("failed")).toBe(true);
    expect(isTerminalWorkStatus("cancelled")).toBe(true);
    for (const s of ["open", "in_progress", "blocked"] as const) {
      expect(isTerminalWorkStatus(s)).toBe(false);
    }
  });

  it("isWorkStatus 闭集", () => {
    for (const s of ["open", "in_progress", "blocked", "done", "failed", "cancelled"]) {
      expect(isWorkStatus(s)).toBe(true);
    }
    expect(isWorkStatus("doing")).toBe(false);
  });
});

// ── BC1 work_deps:环检测 ────────────────────────────────────────

describe("BC1 · work_deps 环检测(旧代码在这里踩过 DAG 通配 bug)", () => {
  it("正常依赖可加,listDeps / listDependents 双向可查", () => {
    const p = mkProject();
    const a = mkAgent("worker");
    const w1 = mkWork(p, a);
    const w2 = mkWork(p, a);
    expect(addDep(db, w2, w1)).toEqual({ ok: true });
    expect(listDeps(db, w2)).toEqual([w1]);
    expect(listDependents(db, w1)).toEqual([w2]);
  });

  it("自环被拒", () => {
    const p = mkProject();
    const w = mkWork(p, mkAgent("worker"));
    expect(addDep(db, w, w)).toEqual({ ok: false, reason: "self" });
    expect(createsCycle(db, w, w)).toBe(true);
  });

  it("两跳环 A→B→A 被拒", () => {
    const p = mkProject();
    const a = mkAgent("worker");
    const w1 = mkWork(p, a);
    const w2 = mkWork(p, a);
    expect(addDep(db, w2, w1)).toEqual({ ok: true }); // w2 依赖 w1
    // 再加 w1 依赖 w2 → 成环
    expect(addDep(db, w1, w2)).toEqual({ ok: false, reason: "cycle" });
    expect(listDeps(db, w1)).toEqual([]); // 没写进去
  });

  it("多跳环 A→B→C→A 被拒", () => {
    const p = mkProject();
    const a = mkAgent("worker");
    const w1 = mkWork(p, a), w2 = mkWork(p, a), w3 = mkWork(p, a);
    expect(addDep(db, w2, w1).ok).toBe(true);
    expect(addDep(db, w3, w2).ok).toBe(true);
    expect(addDep(db, w1, w3)).toEqual({ ok: false, reason: "cycle" });
  });

  it("菱形依赖不算环(A→B, A→C, B→D, C→D 合法)", () => {
    const p = mkProject();
    const a = mkAgent("worker");
    const A = mkWork(p, a), B = mkWork(p, a), C = mkWork(p, a), D = mkWork(p, a);
    expect(addDep(db, B, A).ok).toBe(true);
    expect(addDep(db, C, A).ok).toBe(true);
    expect(addDep(db, D, B).ok).toBe(true);
    expect(addDep(db, D, C).ok).toBe(true);
    expect(createsCycle(db, D, A)).toBe(false);
  });

  it("重复边被拒,但不算环", () => {
    const p = mkProject();
    const a = mkAgent("worker");
    const w1 = mkWork(p, a), w2 = mkWork(p, a);
    addDep(db, w2, w1);
    expect(addDep(db, w2, w1)).toEqual({ ok: false, reason: "duplicate" });
  });

  it("指向不存在的工作项被拒", () => {
    const p = mkProject();
    const w = mkWork(p, mkAgent("worker"));
    expect(addDep(db, w, "ghost")).toEqual({ ok: false, reason: "not_found" });
  });

  it("自环由 schema 的 CHECK 再兜一道", () => {
    const p = mkProject();
    const w = mkWork(p, mkAgent("worker"));
    expect(() =>
      db.prepare(`INSERT INTO work_deps (work_id, depends_on_work_id) VALUES (?, ?)`).run(w, w),
    ).toThrow(/CHECK/i);
  });

  it("删工作项级联带走依赖边", () => {
    const p = mkProject();
    const a = mkAgent("worker");
    const w1 = mkWork(p, a), w2 = mkWork(p, a);
    addDep(db, w2, w1);
    db.prepare(`DELETE FROM works WHERE id = ?`).run(w1);
    expect(listDeps(db, w2)).toEqual([]);
  });

  it("removeDep 生效", () => {
    const p = mkProject();
    const a = mkAgent("worker");
    const w1 = mkWork(p, a), w2 = mkWork(p, a);
    addDep(db, w2, w1);
    removeDep(db, w2, w1);
    expect(listDeps(db, w2)).toEqual([]);
  });
});

// ── depState:三态 ───────────────────────────────────────────────

describe("BC1 · depState 三态(failed 的前置永远等不到)", () => {
  it("前置 done → satisfied", () => {
    const p = mkProject();
    const a = mkAgent("worker");
    const d = mkWork(p, a), w = mkWork(p, a);
    updateWorkStatus(db, d, "done", T0);
    addDep(db, w, d);
    expect(depState(db, w).satisfied).toEqual([d]);
    expect(depsSatisfied(db, w)).toBe(true);
  });

  it("前置仍在跑 → pending,不能开工", () => {
    const p = mkProject();
    const a = mkAgent("worker");
    const d = mkWork(p, a), w = mkWork(p, a);
    updateWorkStatus(db, d, "in_progress", T0);
    addDep(db, w, d);
    expect(depState(db, w).pending).toEqual([d]);
    expect(depsSatisfied(db, w)).toBe(false);
  });

  it("前置 failed → failed,调用方应级联失败而不是等", () => {
    const p = mkProject();
    const a = mkAgent("worker");
    const d = mkWork(p, a), w = mkWork(p, a);
    updateWorkStatus(db, d, "failed", T0);
    addDep(db, w, d);
    const s = depState(db, w);
    expect(s.failed).toEqual([d]);
    expect(s.pending).toEqual([]);
    expect(depsSatisfied(db, w), "failed 不该被当成放行").toBe(false);
  });

  it("前置 cancelled 同样算 failed 类", () => {
    const p = mkProject();
    const a = mkAgent("worker");
    const d = mkWork(p, a), w = mkWork(p, a);
    updateWorkStatus(db, d, "cancelled", T0);
    addDep(db, w, d);
    expect(depState(db, w).failed).toEqual([d]);
  });

  it("混合三态各归各位", () => {
    const p = mkProject();
    const a = mkAgent("worker");
    const okD = mkWork(p, a), badD = mkWork(p, a), waitD = mkWork(p, a), w = mkWork(p, a);
    updateWorkStatus(db, okD, "done", T0);
    updateWorkStatus(db, badD, "failed", T0);
    updateWorkStatus(db, waitD, "in_progress", T0);
    addDep(db, w, okD); addDep(db, w, badD); addDep(db, w, waitD);
    const s = depState(db, w);
    expect(s.satisfied).toEqual([okD]);
    expect(s.failed).toEqual([badD]);
    expect(s.pending).toEqual([waitD]);
    expect(s.missing).toEqual([]);
  });

  it("无依赖 → 可以开工", () => {
    const p = mkProject();
    const w = mkWork(p, mkAgent("worker"));
    expect(depsSatisfied(db, w)).toBe(true);
    expect(depState(db, w)).toEqual({ satisfied: [], failed: [], pending: [], missing: [] });
  });
});

// ── 接缝:存储 → 授权求解 ────────────────────────────────────────

describe("接缝 · loadProjectForAuthz 喂给 solveToolset", () => {
  it("真实数据(而非测试 fixture)驱动的授权求解", () => {
    const p = mkProject("active");
    const bm = mkAgent("business_manager");
    const pm = mkAgent("project_manager");
    const wk = mkAgent("worker", "algorithm");
    addMember(db, p, bm, T0);
    addMember(db, p, pm, T0);
    addMember(db, p, wk, T0);

    const proj = loadProjectForAuthz(db, p);
    expect(proj).not.toBeNull();

    const r = solveToolset(getAgent(db, wk)!, proj!);
    expect(r.tools.length).toBeGreaterThan(0);
    expect(r.tools).not.toContain("tell_client");
    expect(r.blockedByScope).toEqual([]);
  });

  it("项目被关掉后,项目内能力被 scope 门挡下", () => {
    const p = mkProject("active");
    const wk = mkAgent("worker", "algorithm");
    addMember(db, p, wk, T0);
    closeProject(db, p, "done", T0 + 1);

    const proj = loadProjectForAuthz(db, p)!;
    const r = solveToolset(getAgent(db, wk)!, proj);
    expect(r.blockedByScope.length).toBeGreaterThan(0);
    // 记忆与代码工具是项目无关的,仍可用
    expect(r.tools).toContain("memory_search");
    expect(r.tools).toContain("bash");
  });

  it("被移出项目的成员不再是参与方 → 不是通信合法目标", () => {
    const p = mkProject("active");
    const wk = mkAgent("worker");
    const qa = mkAgent("quality_reviewer");
    addMember(db, p, wk, T0);
    addMember(db, p, qa, T0);
    removeMember(db, p, qa, T0 + 1);

    const proj = loadProjectForAuthz(db, p)!;
    const active = proj.assignments.filter((a) => a.removedAt === undefined).map((a) => a.agentId);
    expect(active).toEqual([wk]);
    expect(active).not.toContain(qa);
  });

  it("项目不存在 → null(调用方显式处理)", () => {
    expect(loadProjectForAuthz(db, "nope")).toBeNull();
  });
});
