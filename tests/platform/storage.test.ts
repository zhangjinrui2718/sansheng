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
  depsSatisfied, isWorkStatus, isTerminalWorkStatus, deleteWork,
  type WorkRow,
} from "../../src/platform/storage/repo/works.js";
import {
  insertArtifact, getArtifact, listArtifacts,
} from "../../src/platform/storage/repo/artifacts.js";
import { dispatch } from "../../src/platform/tools/registry.js";
import type { ToolRunContext } from "../../src/platform/tools/types.js";
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

  it("旧表已被 011 删除(清场已完成)", () => {
    // 这条断言在批次 15 之前是反过来的:「旧表仍在(并存而非替换)」。
    // 并存期是刻意的过渡设计(每完成一个 BC 就删它替代掉的旧模块),而清场
    // 就是那个过渡的终点。现在断言的是终点状态。
    //
    // 保留这条而不是删掉它,是因为「旧表有没有真的清掉」是清场是否完成的
    // 唯一机器可查的证据 —— 删了断言就只剩一句「我删过了」。
    const rows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN
                ('conversations','messages','fragments','agent_states','blackboards',
                 'user_profile','fragments_vec')`)
      .all() as Array<{ name: string }>;
    expect(
      rows.map((r) => r.name),
      "旧系统的表还在 —— 011_drop_legacy.sql 没生效,或它没被读到",
    ).toEqual([]);
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

describe("BC1 · depState 四态(failed 才真正等不到;cancelled 不阻塞但要可见)", () => {
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

  it("**前置 cancelled 不阻塞** —— 但单独一类,必须可见", () => {
    // 这条测试原先是反过来的:断言「cancelled 同样算 failed 类」。
    // 那个断言把 bug 当成了规范 —— 真机事故:项目经理取消「综合对比」并新建同名项,
    // 下游「报告整合」的 dependsOn 指向被取消的那份旧的 → **永不唤醒**(不报错)。
    //
    // 取消的语义是「这块范围不要了」,不是「这条活失败了」。两者混淆的代价是
    // 下游永远等一个不会有人做的活。
    const p = mkProject();
    const a = mkAgent("worker");
    const d = mkWork(p, a), w = mkWork(p, a);
    updateWorkStatus(db, d, "cancelled", T0);
    addDep(db, w, d);
    const s = depState(db, w);
    expect(s.cancelled, "单独一类").toEqual([d]);
    expect(s.failed, "不能混进 failed").toEqual([]);
    expect(depsSatisfied(db, w), "取消不是阻塞,下游该开工").toBe(true);
  });

  it("真机事故回归:cancelled 前置不再永久堵死下游", () => {
    // 精确复现用户数据里的形状:PM 取消了 W,新建了同名 W′,
    // 而下游 D 的 dependsOn 仍指向被取消的 W。
    const p = mkProject();
    const a = mkAgent("worker");
    const cancelled = mkWork(p, a), replacement = mkWork(p, a), downstream = mkWork(p, a);
    updateWorkStatus(db, cancelled, "cancelled", T0);
    addDep(db, downstream, cancelled); // ← 指向旧的那份(现实里就是这么发生的)
    addDep(db, downstream, replacement);
    updateWorkStatus(db, replacement, "done", T0);
    expect(depsSatisfied(db, downstream), "不该再永远等不到").toBe(true);
    // 但下游必须能看见「有一个前置被取消了」
    expect(depState(db, downstream).cancelled).toEqual([cancelled]);
  });

  it("混合各态各归各位", () => {
    const p = mkProject();
    const a = mkAgent("worker");
    const okD = mkWork(p, a), badD = mkWork(p, a), waitD = mkWork(p, a);
    const goneD = mkWork(p, a), w = mkWork(p, a);
    updateWorkStatus(db, okD, "done", T0);
    updateWorkStatus(db, badD, "failed", T0);
    updateWorkStatus(db, waitD, "in_progress", T0);
    updateWorkStatus(db, goneD, "cancelled", T0);
    addDep(db, w, okD); addDep(db, w, badD); addDep(db, w, waitD); addDep(db, w, goneD);
    const s = depState(db, w);
    expect(s.satisfied).toEqual([okD]);
    expect(s.failed).toEqual([badD]);
    expect(s.pending).toEqual([waitD]);
    expect(s.cancelled).toEqual([goneD]);
    expect(s.missing).toEqual([]);
  });

  it("无依赖 → 可以开工", () => {
    const p = mkProject();
    const w = mkWork(p, mkAgent("worker"));
    expect(depsSatisfied(db, w)).toBe(true);
    expect(depState(db, w)).toEqual({
      satisfied: [], cancelled: [], failed: [], pending: [], missing: [],
    });
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

// ── 014 · 工件 → 工作项的产出边(migration 014 + board_write 的 workId)────
//
// 这条边补的是「这条工作项产出了什么」—— 在此之前它只能靠**项目级集合差**算
// (`runtime/execution.ts` 的回合前后差集),那个判据连 author_agent_id 都不读,
// 同项目两回合交叠时会互相认领对方的产出。
//
// 这里钉三件事:
//   ① 写入路径真的能落这条边(而且只能落**同项目**的工作项);
//   ② 不传 = null 是**合法状态**,不是缺参数;
//   ③ 删工作项**不删产出**(SET NULL),而且从 work id 反查得到。

describe("014 · 产出边(board_write 的 workId)", () => {
  function ctxFor(agentId: string, projectId: string): ToolRunContext {
    const row = getAgent(db, agentId)!;
    return {
      db,
      agent: {
        id: row.id,
        role: row.role,
        displayName: row.displayName,
        ...(row.specialization !== null ? { specialization: row.specialization } : {}),
      },
      project: loadProjectForAuthz(db, projectId),
      now: () => T0,
      newId: (prefix) => `${prefix}_${++seq}`,
    };
  }

  const write = (agentId: string, projectId: string, args: Record<string, unknown>) =>
    dispatch("board_write", args, ctxFor(agentId, projectId));

  /** 一个活跃项目 + 一个 worker 成员 + 一条分派给它的工作项 */
  function scene(): { pid: string; wk: string; workId: string } {
    const pid = mkProject("active");
    const wk = mkAgent("worker", "algorithm");
    addMember(db, pid, wk, T0);
    const workId = mkWork(pid, wk);
    return { pid, wk, workId };
  }

  it("带 workId 写入 → 边真的落库,且能从 work id 反查回来", async () => {
    const { pid, wk, workId } = scene();
    const r = await write(wk, pid, { kind: "evidence", title: "证据", body: "现场", workId });
    expect(r.ok, r.ok ? "" : `${r.code}: ${r.message}`).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain(`产出工作项:${workId}`);

    const arts = listArtifacts(db, pid, { workId });
    expect(arts).toHaveLength(1);
    expect(arts[0]!.workId).toBe(workId);
    // 正负样本对照:不过滤时项目里还有别的工件吗?这里只有这一条 ——
    // 所以再加一条**没有**产出工作项的工件,证明过滤真的在筛。
    await write(wk, pid, { kind: "note", title: "随手记", body: "b" });
    expect(listArtifacts(db, pid)).toHaveLength(2);
    expect(listArtifacts(db, pid, { workId })).toHaveLength(1);
    expect(getArtifact(db, arts[0]!.id)!.workId).toBe(workId);
  });

  it("不传 workId = **合法状态**(work_id 为 null,不是填空缺)", async () => {
    const { pid, wk } = scene();
    const r = await write(wk, pid, { kind: "note", title: "立项笔记", body: "b" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = listArtifacts(db, pid)[0]!;
    expect(a.workId).toBeNull();
    expect(r.text).not.toContain("产出工作项");
  });

  it("workId 不存在 → not_found,且**不静默写出工件**", async () => {
    const { pid, wk } = scene();
    const r = await write(wk, pid, { kind: "evidence", title: "证据", body: "b", workId: "wk_ghost" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
    expect(r.message).toContain("wk_ghost");
    expect(listArtifacts(db, pid)).toHaveLength(0);
  });

  it("workId 属于**别的项目** → not_found(库里这条边是合法的,只能在工具层拦)", async () => {
    const { pid, wk } = scene();
    const other = mkProject("active");
    const otherWork = mkWork(other, wk);
    const r = await write(wk, pid, { kind: "evidence", title: "证据", body: "b", workId: otherWork });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
    expect(r.message).toContain(other);
    expect(listArtifacts(db, pid)).toHaveLength(0);
    // 库里确实不拦跨项目引用 —— 所以这条校验是工具层独有的,别删
    expect(() =>
      insertArtifact(db, {
        id: `art_raw_${++seq}`, projectId: pid, conversationId: null, kind: "note",
        status: "open", authorAgentId: wk, title: "t", body: "b", metadataJson: null,
        createdAt: T0, updatedAt: T0, workId: otherWork,
      }),
    ).not.toThrow();
  });

  it("删掉工作项后:工件仍在,work_id 变 null(SET NULL,不是 CASCADE)", async () => {
    const { pid, wk, workId } = scene();
    await write(wk, pid, { kind: "evidence", title: "证据", body: "现场", workId });
    const before = listArtifacts(db, pid, { workId });
    expect(before).toHaveLength(1);

    deleteWork(db, workId);
    const all = listArtifacts(db, pid);
    expect(all, "删工作项把产出一起删了 —— 那是 CASCADE 的形态").toHaveLength(1);
    expect(all[0]!.id).toBe(before[0]!.id);
    expect(all[0]!.body).toBe("现场");
    expect(all[0]!.workId).toBeNull();
    expect(listArtifacts(db, pid, { workId })).toHaveLength(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("workId 过滤不跨项目串(作用域仍然是 projectId,不是 workId)", async () => {
    const { pid, wk, workId } = scene();
    await write(wk, pid, { kind: "evidence", title: "本项目产出", body: "b", workId });
    const other = mkProject("active");
    // 另一项目里一条**没有**产出边的工件
    insertArtifact(db, {
      id: `art_x_${++seq}`, projectId: other, conversationId: null, kind: "evidence",
      status: "open", authorAgentId: wk, title: "别项目产出", body: "b", metadataJson: null,
      createdAt: T0, updatedAt: T0,
    });
    expect(listArtifacts(db, pid, { workId }).map((a) => a.title)).toEqual(["本项目产出"]);
    expect(listArtifacts(db, other, { workId })).toEqual([]);
  });
});

/**
 * 016 · `artifacts.kind` 多了一个 `deliverable`(设计 1 §2.11.5:工件即推动流程)
 *
 * `migrations.test.ts` 的 016 那一组守的是 **schema 级**的东西(闭集、逐字回归、
 * 6 条索引、子表清单、朴素重建的负样本)。这里补的是**启动路径**:
 * 真迁移器(`openPlatformMemoryDb` → `runMigrations`)把库带到 16,
 * 闭集真的通了、014 的产出边还在、中转备份表没留在库里。
 *
 * ⚠️⚠️ **016 单独上线时,读面比写面严 —— 这是 DAG 上的一个先后约束,不是本测试的缺陷。**
 * `repo/artifacts.ts:96` 的 `rowToArtifact` 用 `isArtifactKind`(代码侧的
 * `ARTIFACT_KINDS`)把未定义的 kind **响亮地抛出来**:`deliverable` 一旦落库,
 * `getArtifact` / `listArtifacts` 就会对**整个项目**抛
 * 「artifacts 表里出现未定义 kind「deliverable」」。所以:
 *   - 016(本批次)只负责**让 schema 收得下**;
 *   - `ARTIFACT_KINDS` 与六处同步面(设计 §2.11.5 末)是 **C2**,它才让读面通;
 *   - 两步之间**不能有任何 deliverable 的写者**(今天也没有 —— 见 016 文件头
 *     「写入侧零代码改动」)。C2 落地后本 describe 可以补一条
 *     `getArtifact(...).kind === 'deliverable'` 的用例,那时它才有意义。
 *
 * 基于同一个理由,这里用**裸 SQL** 写入而不是 `insertArtifact(..., { kind: "deliverable" })`:
 * `ArtifactKind` 联合里的 `deliverable` 是 C2 的活,本批次不碰 `identity/role.ts`。
 */
describe("016 · deliverable 工件(真启动路径 + 仓储层)", () => {
  const A_COLS =
    "id,project_id,conversation_id,kind,status,author_agent_id,title,body,metadata_json,created_at,updated_at,work_id";
  const KIND_016 = [
    "decision", "note", "evidence", "hypothesis", "project_brief", "work_brief",
    "meeting_note", "review_finding", "change_record", "client_question", "deliverable",
  ] as const;

  function rawArtifact(id: string, kind: string, projectId: string, authorId: string, workId: string | null): void {
    db.prepare(`INSERT INTO artifacts (${A_COLS}) VALUES (?,?,NULL,?,'open',?,?,?,NULL,1,1,?)`)
      .run(id, projectId, kind, authorId, "标题", "正文", workId);
  }

  it("真迁移器把库带到 16(不是只有手写 SQL 才认这个闭集)", () => {
    const row = db.prepare(`SELECT name FROM schema_version WHERE version = 16`).get() as
      | { name: string }
      | undefined;
    expect(row, "openPlatformMemoryDb 没跑到 016 —— 迁移文件没被迁移器读到").toBeDefined();
    expect(row!.name).toBe("artifacts_deliverable");
    // 016 是重建表:它必须先备份子表再灌回,中转表不能留在**真库**里
    const leftovers = db.prepare(
      `SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE '%\\_backup' ESCAPE '\\'`,
    ).get() as { n: number };
    expect(leftovers.n, "真库上残留了 016 的中转备份表").toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("deliverable 写得进,013/014 的列与产出边跟着一起活着", () => {
    const pid = mkProject("active");
    const wk = mkAgent("worker", "engineering");
    const workId = mkWork(pid, wk);
    const id = `a016_keep_${++seq}`;
    rawArtifact(id, "deliverable", pid, wk, workId);

    // ⚠️ 这里**故意**用裸 SQL 读回,不是 `getArtifact` —— 见本 describe 头:
    // `rowToArtifact` 用 `isArtifactKind`(代码侧的 `ARTIFACT_KINDS`)把未定义的
    // kind **响亮地**抛出来,而那个联合里的 `deliverable` 是 C2 的活。
    // 换句话说:**016 单独上线时,一条 deliverable 行会让 getArtifact /
    // listArtifacts 直接抛错**(读面比写面严)。C2 落地后这条读面才通 ——
    // 那是 DAG 上的下一步,不是本迁移能独自解决的事。
    const got = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as {
      kind: string; title: string; body: string; work_id: string | null; status: string;
    } | undefined;
    expect(got, "这条工件没写进去").toBeDefined();
    expect(got!.kind).toBe("deliverable");
    expect(got!.title).toBe("标题");
    expect(got!.body).toBe("正文");
    expect(got!.status).toBe("open");
    // 016 的重建若照 008 抄列清单,这一列整列就没了(用户真机库 11 条工件里 10 条非空)
    expect(got!.work_id, "014 的产出边丢了 —— 016 重建时漏了 work_id 列").toBe(workId);
    // 014 的按 work_id 过滤读法:用 SQL 证明这条边真的建起来了
    expect(db.prepare(`SELECT id FROM artifacts WHERE work_id = ?`).all(workId)).toEqual([{ id }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("**负样本**:闭集是被放宽,不是被拆掉 —— nonsense 仍被拒,旧 10 个取值仍可用", () => {
    const pid = mkProject("active");
    const wk = mkAgent("worker", "engineering");
    // 正样本:同一支探针在合法取值上不报错(否则下面两条可能是「什么都拒」)
    expect(() => rawArtifact(`a016_ok_${++seq}`, "deliverable", pid, wk, null)).not.toThrow();
    // 负样本两条
    expect(() => rawArtifact(`a016_bad_${++seq}`, "nonsense", pid, wk, null)).toThrow(/CHECK/i);
    expect(() => rawArtifact(`a016_bad2_${++seq}`, "deliverables", pid, wk, null)).toThrow(/CHECK/i);
    for (const k of KIND_016.filter((x) => x !== "deliverable")) {
      expect(() => rawArtifact(`a016_old_${k}_${++seq}`, k, pid, wk, null), `${k} 被误伤`).not.toThrow();
    }
    expect(
      (db.prepare(`SELECT COUNT(*) n FROM artifacts`).get() as { n: number }).n,
      1 + KIND_016.length - 1,
    ).toBe(KIND_016.length);
  });

  it("016 重建之后 6 条索引仍在真库上(启动路径上的 DROP TABLE 没把它们带走)", () => {
    const names = (db.pragma("index_list(artifacts)") as Array<{ name: string }>)
      .map((r) => r.name)
      .filter((n) => !n.startsWith("sqlite_autoindex"))
      .sort();
    expect(
      names,
      "DROP TABLE 会连索引一起丢掉 —— 016 必须把 6 条全部原样重建" +
        "(设计稿 §2.11.5 写的是五条,那是 014 之前的数字)",
    ).toEqual([
      "idx_artifacts_author", "idx_artifacts_kind", "idx_artifacts_project",
      "idx_artifacts_recent", "idx_artifacts_status", "idx_artifacts_work",
    ]);
    // 部分索引的谓词不能丢(丢了不报错,只是悄悄退化成全表扫)
    const sql = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_artifacts_work'`,
    ).get() as { sql: string };
    expect(sql.sql).toMatch(/WHERE\s+work_id\s+IS\s+NOT\s+NULL/i);
  });
});

/**
 * C2 · `deliverable` 进了**代码侧**闭集 —— C1 留下的「写面开、读面关」豁口关掉了
 *
 * C1 的 016 把 schema 的 CHECK 放宽到 11 个取值,而代码侧 `ARTIFACT_KINDS` 还是
 * 10 个;`repo/artifacts.ts` 的 `rowToArtifact` 用 `isArtifactKind` 对未定义 kind
 * **硬抛**,所以那个窗口里**一条** `deliverable` 行会让整个项目的 `getArtifact` /
 * `listArtifacts` 全挂(016 那个 describe 的头注释写明了这件事)。
 *
 * 这一组是豁口关闭之后的**读面**判据 —— 016 的测试当时只能用裸 SQL 读回,因为
 * `insertArtifact(..., { kind: "deliverable" })` 连**编译**都过不去。
 *
 * 正/负样本自检(AGENTS.md §三类静默失败):① 一条真 `deliverable` 行必须读得回;
 * ② 一条**schema 认、代码不认**的 kind 必须仍让读面响亮抛错 —— 用
 * `PRAGMA ignore_check_constraints` 把那种行造出来(这正是 016↔C2 窗口的形态),
 * 证明那条守卫没有因为「两个闭集恰好相等」而退化成永真。
 */
describe("C2 · deliverable 的读写面(设计 1 §2.11.5)", () => {
  const A_COLS =
    "id,project_id,conversation_id,kind,status,author_agent_id,title,body,metadata_json,created_at,updated_at,work_id";

  it("仓储写入口收得下 deliverable,读入口读得回(豁口关了)", () => {
    const pid = mkProject("active");
    const pm = mkAgent("project_manager");
    const rootWork = mkWork(pid, mkAgent("worker", "engineering"));
    const id = `a_c2_${++seq}`;

    // 这一行在 C2 之前**编译不过**(ArtifactKind 联合里没有 deliverable)——
    // 类型层是第一道守卫,这条用例的存在本身就是它活着的证据。
    insertArtifact(db, {
      id, projectId: pid, conversationId: null, kind: "deliverable", status: "open",
      authorAgentId: pm, title: "交付物", body: "整合后的交付", metadataJson: null,
      createdAt: T0 + seq, updatedAt: T0 + seq, workId: rootWork,
    });

    const got = getArtifact(db, id);
    expect(got, "deliverable 行读不回来 —— rowToArtifact 的 isArtifactKind 不认识它").not.toBeNull();
    expect(got!.kind).toBe("deliverable");
    expect(got!.authorAgentId, "交付物由项目经理写(不是 worker 的产出)").toBe(pm);
    expect(got!.workId, "014 的产出边要跟着一起读回来").toBe(rootWork);
    expect(listArtifacts(db, pid).map((a) => a.id), "整项目列表也必须读得动(不是只有单条)").toContain(id);
  });

  it("**负样本自检**:schema 认、代码不认的 kind 仍让读面响亮抛错(守卫没变成永真)", () => {
    const pid = mkProject("active");
    const pm = mkAgent("project_manager");
    const id = `a_c2_probe_${++seq}`;
    const insert = () =>
      db.prepare(`INSERT INTO artifacts (${A_COLS}) VALUES (?,?,NULL,?,?,?,?,?,NULL,1,1,NULL)`)
        .run(id, pid, "nonsense_kind", "open", pm, "标题", "正文");

    // ① 正样本方向:不关 CHECK 就造不出这种行 —— 说明下面的行**只可能**来自
    //    「schema 先开、代码后跟」那个窗口,而不是测试自己写错了 SQL。
    expect(insert, "CHECK 没拦住 nonsense_kind —— 这条探针什么都没证明").toThrow(/CHECK/i);

    // ② 关掉 CHECK 才塞得进去(这正是 016↔C2 窗口的形态)
    db.pragma("ignore_check_constraints = ON");
    insert();
    db.pragma("ignore_check_constraints = OFF");
    // 关回去之后 CHECK 必须仍然有牙(否则「关掉」那一步才是真凶,不是窗口)
    expect(db.prepare(`SELECT COUNT(*) n FROM artifacts WHERE id = ?`).get(id)).toEqual({ n: 1 });
    expect(() => db.prepare(
      `INSERT INTO artifacts (${A_COLS}) VALUES (?,?,NULL,?,?,?,?,?,NULL,1,1,NULL)`,
    ).run(`${id}_x`, pid, "nonsense_kind", "open", pm, "标题", "正文")).toThrow(/CHECK/i);

    // ③ 读面必须抛 —— 这是「代码侧闭集是读面的唯一守卫」的活证据
    expect(() => getArtifact(db, id), "未定义 kind 必须响亮抛错,不许静默透出").toThrow(/未定义 kind/);
    expect(() => listArtifacts(db, pid), "一条坏行会让**整个项目**的列表挂掉 —— 这正是 C1 的硬 DAG 约束").toThrow(/未定义 kind/);
  });
});
