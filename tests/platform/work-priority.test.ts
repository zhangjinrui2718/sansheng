/**
 * 工作项显式优先级(migration 032)· 测试
 *
 * ── 这一批钉住的判据 ──────────────────────────────────────────────
 *
 *   ① **缺省 3 =「没判断过」的表达**(migration DEFAULT,不回填存量);
 *   ② **取值域在 TS,不进 CHECK**:`clampWorkPriority` 收进 0–9、非整数取
 *      最近的整数;写口(`insertWork` / `setWorkPriority`)再 clamp 一次;
 *      读侧(`rowToWork`)对非有限数**抛错**,不给「当作 3」的兜底;
 *   ③ **drain 排序是三段**:待办种类优先级 → 工作项优先级(数字小先派)→
 *      key 字典序(同优先级内的**现有次序**,刻意保留);
 *   ④ WorkView 把 priority 原样透出,换算只发生在排空器那一处。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitWorkspace } from "../../src/platform/workspace/git.js";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject, addMember, loadProjectForAuthz } from "../../src/platform/storage/repo/projects.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { insertAsk } from "../../src/platform/storage/repo/asks.js";
import {
  insertWork, getWork, listWorks, setWorkPriority, clampWorkPriority,
  DEFAULT_WORK_PRIORITY, WORK_PRIORITY_MIN, WORK_PRIORITY_MAX,
} from "../../src/platform/storage/repo/works.js";
import { collectTodos } from "../../src/platform/runtime/dispatcher.js";
import { dispatch } from "../../src/platform/tools/registry.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";
import { toWorkView } from "../../src/platform/transport/views.js";
import type { Agent, Project } from "../../src/platform/harness/authorize.js";
import type { ProjectRole } from "../../src/platform/identity/role.js";

let db: Database.Database;
let seq = 0;
const T0 = 1_700_000_000_000;

// ── 工具层夹具(与 tools.test.ts 同形)────────────────────────────
let workRoot: string;
const agents = new Map<string, Agent>();
let project: Project;
let clock = T0;

beforeEach(() => {
  workRoot = mkdtempSync(join(tmpdir(), "sansheng-work-priority-"));
  db = openPlatformMemoryDb();
  seq = 0;
  clock = T0;
  agents.clear();

  function mk(role: ProjectRole, spec?: "engineering" | "algorithm" | "data"): Agent {
    const id = `ag_${role}${spec ? "_" + spec : ""}`;
    insertAgent(db, { id, role, specialization: spec ?? null, displayName: id, createdAt: T0 });
    const a: Agent = { id, role, displayName: id, ...(spec ? { specialization: spec } : {}) };
    agents.set(id, a);
    return a;
  }
  mk("business_manager");
  mk("project_manager");
  // research_worker 不自建:`ensureProjectOrg` 播种的 `wk`(research_worker/
  // engineering)就是项目里唯一一名 —— resolveAssignee 对单成员角色免 spec。

  insertProject(db, {
    id: "pj_1", name: "优先级测试项目", client: "甲方", goal: "要事第一", status: "active", createdAt: T0,
  });
  for (const id of agents.keys()) addMember(db, "pj_1", id, T0);
  ensureProjectOrg(db, "pj_1", T0);
  project = loadProjectForAuthz(db, "pj_1")!;
});

afterEach(() => {
  db.close();
  rmSync(workRoot, { recursive: true, force: true });
});

function mkWork(over: {
  id: string; title?: string; priority?: number; status?: "open" | "in_progress" | "done";
  assignee?: string;
}): string {
  insertWork(db, { confirmedAt: 1,
    id: over.id, projectId: "pj_1", parentWorkId: null,
    title: over.title ?? over.id, goal: "做完",
    status: over.status ?? "open",
    ...(over.priority !== undefined ? { priority: over.priority } : {}),
    assigneeAgentId: over.assignee ?? "wk",
    createdAt: T0, updatedAt: T0,
  });
  return over.id;
}

function ctxFor(agentId: string, over: Partial<ToolRunContext> = {}): ToolRunContext {
  const agent = agents.get(agentId);
  if (!agent) throw new Error(`未知 agent ${agentId}`);
  return {
    db,
    agent,
    project,
    now: () => clock,
    newId: (prefix) => `${prefix}_new${++seq}`,
    workspace: createGitWorkspace(),
    workspaceRoot: workRoot,
    ...over,
  };
}

function call(agentId: string, tool: string, args: Record<string, unknown> = {}): ToolResult {
  const r = dispatch(tool, args, ctxFor(agentId));
  if (r instanceof Promise) throw new Error("本测试只覆盖同步工具");
  return r;
}

function okText(r: ToolResult): string {
  if (!r.ok) throw new Error(`期望成功,实际失败[${r.code}] ${r.message}`);
  return r.text;
}

// ══ repo 层 ════════════════════════════════════════════════════

describe("repo 层 · 缺省与 clamp", () => {
  it("缺省优先级 = 3(insertWork 不给 priority;migration DEFAULT 对裸 SQL 同样生效)", () => {
    const id = mkWork({ id: "wk_default" });
    expect(getWork(db, id)?.priority).toBe(3);
    // 裸 SQL 不带 priority 列 → 落 DEFAULT 3:这一半钉的是 migration 本身
    db.prepare(
      `INSERT INTO works (id, project_id, title, goal, status, assignee_agent_id, created_at, updated_at)
       VALUES ('wk_raw', 'pj_1', '裸插入', '做完', 'open', 'wk', ?, ?)`,
    ).run(T0, T0);
    expect(getWork(db, "wk_raw")?.priority).toBe(DEFAULT_WORK_PRIORITY);
  });

  it("clampWorkPriority:越界收进 [0,9],非整数取最近的整数", () => {
    expect(WORK_PRIORITY_MIN).toBe(0);
    expect(WORK_PRIORITY_MAX).toBe(9);
    expect(clampWorkPriority(-1)).toBe(0);
    expect(clampWorkPriority(10)).toBe(9);
    expect(clampWorkPriority(99)).toBe(9);
    expect(clampWorkPriority(2.4)).toBe(2);
    expect(clampWorkPriority(2.6)).toBe(3);
    expect(clampWorkPriority(5)).toBe(5);
  });

  it("insertWork 显式 priority 落库;越界值在写口再 clamp 一次", () => {
    const a = mkWork({ id: "wk_p0", priority: 0 });
    expect(getWork(db, a)?.priority).toBe(0);
    const b = mkWork({ id: "wk_p15", priority: 15 });
    expect(getWork(db, b)?.priority).toBe(9);
    const c = mkWork({ id: "wk_pneg", priority: -3 });
    expect(getWork(db, c)?.priority).toBe(0);
    // listWorks 读回:每一行都带 priority
    const rows = listWorks(db, "pj_1");
    const byId = new Map(rows.map((w) => [w.id, w.priority]));
    expect(byId.get("wk_p0")).toBe(0);
    expect(byId.get("wk_p15")).toBe(9);
    expect(byId.get("wk_pneg")).toBe(0);
  });

  it("setWorkPriority:改写并更新 updated_at;同值幂等;unknown → not_found", () => {
    const id = mkWork({ id: "wk_sp", priority: 5 });
    const changed = setWorkPriority(db, id, 0, T0 + 1000);
    expect(changed).toEqual({ ok: true, from: 5, to: 0, changed: true });
    const row = getWork(db, id)!;
    expect(row.priority).toBe(0);
    expect(row.updatedAt).toBe(T0 + 1000);

    const same = setWorkPriority(db, id, 0, T0 + 2000);
    expect(same).toEqual({ ok: true, from: 0, to: 0, changed: false });
    expect(getWork(db, id)!.updatedAt).toBe(T0 + 1000); // 幂等空操作不碰 updated_at

    const missing = setWorkPriority(db, "wk_none", 3, T0);
    expect(missing.ok).toBe(false);
  });

  it("读侧 fail-loud:priority 被绕过写口改成非数 → rowToWork 抛错,不当成 3", () => {
    const id = mkWork({ id: "wk_bad" });
    // SQLite 的 INTEGER affinity 收不下 'high' —— 原样存 TEXT(模拟有人绕过写口改库)
    db.prepare(`UPDATE works SET priority = 'high' WHERE id = ?`).run(id);
    expect(() => getWork(db, id)).toThrow(/priority/);
  });
});

// ══ 工具层 ════════════════════════════════════════════════════

describe("工具层 · work_create / work_update 的 priority", () => {
  it("work_create 缺省 = 3,显式 0 落 0,越界收进边界", () => {
    okText(call("ag_project_manager", "work_create", {
      title: "缺省档", goal: "做完", assigneeRole: "research_worker",
    }));
    okText(call("ag_project_manager", "work_create", {
      title: "最紧急", goal: "做完", assigneeRole: "research_worker", priority: 0,
    }));
    okText(call("ag_project_manager", "work_create", {
      title: "越界高档", goal: "做完", assigneeRole: "research_worker", priority: 42,
    }));
    okText(call("ag_project_manager", "work_create", {
      title: "越界低档", goal: "做完", assigneeRole: "research_worker", priority: -7,
    }));
    const byTitle = new Map(listWorks(db, "pj_1").map((w) => [w.title, w.priority]));
    expect(byTitle.get("缺省档")).toBe(3);
    expect(byTitle.get("最紧急")).toBe(0);
    expect(byTitle.get("越界高档")).toBe(9);
    expect(byTitle.get("越界低档")).toBe(0);
  });

  it("work_create 提供了但不是有限数 → invalid_args(不静默当「没提供」)", () => {
    const r = call("ag_project_manager", "work_create", {
      title: "档位写错", goal: "做完", assigneeRole: "research_worker", priority: "high",
    });
    if (r.ok) throw new Error("期望失败,实际成功");
    expect(r.code).toBe("invalid_args");
    expect(r.message).toContain("priority");
    // 8-F:拒绝要回灌合法取值
    expect(r.alternatives?.some((a) => a.includes("0–9"))).toBe(true);
    // 一个字节都不写
    expect(listWorks(db, "pj_1")).toHaveLength(0);
  });

  it("work_update 只给 priority 也算合法改动;同值幂等", () => {
    const r = call("ag_project_manager", "work_create", {
      title: "要事有变", goal: "做完", assigneeRole: "research_worker",
    });
    const workId = (r as Extract<ToolResult, { ok: true }>).text.match(/(wk_\w+)/)?.[1];
    if (workId === undefined) throw new Error(`创建失败:${r.ok ? r.text : r.message}`);

    const up = okText(call("ag_project_manager", "work_update", { workId, priority: 0 }));
    expect(up).toContain("优先级:3 → 0");
    expect(getWork(db, workId)?.priority).toBe(0);

    const again = okText(call("ag_project_manager", "work_update", { workId, priority: 0 }));
    expect(again).toContain("没有变化");

    // 都不给 → invalid_args(判据随 priority 扩成了三个字段)
    const empty = call("ag_project_manager", "work_update", { workId });
    if (empty.ok) throw new Error("期望失败,实际成功");
    expect(empty.code).toBe("invalid_args");
    expect(empty.message).toContain("priority");
  });

  it("WorkView 原样透出 priority(换算只发生在排空器那一处)", () => {
    const id = mkWork({ id: "wk_view", priority: 1 });
    const row = getWork(db, id)!;
    const view = toWorkView(db, row, (agentId) => agents.get(agentId)?.displayName ?? agentId);
    expect(view.priority).toBe(1);
  });
});

// ══ drain 排序 ════════════════════════════════════════════════

describe("drain 排序 · 三段:种类 → 工作项优先级 → key 字典序", () => {
  /** runnable 里 execute_work 待办的 target(= 工作项 id)顺序 */
  function executeOrder(projectId = "pj_1"): string[] {
    return collectTodos({ db, projectId, now: T0 })
      .runnable.filter((t) => t.kind === "execute_work")
      .map((t) => t.target);
  }

  it("同优先级内保持现有次序(key 字典序)", () => {
    mkWork({ id: "wk_a", priority: 3 });
    mkWork({ id: "wk_b", priority: 3 });
    expect(executeOrder()).toEqual(["wk_a", "wk_b"]);
  });

  it("优先级小的先跑,同优先级内回到 key 字典序", () => {
    mkWork({ id: "wk_low", priority: 9 });
    mkWork({ id: "wk_high", priority: 0 });
    mkWork({ id: "wk_mid", priority: 5 });
    expect(executeOrder()).toEqual(["wk_high", "wk_mid", "wk_low"]);
  });

  it("同优先级内 key 字典序与「创建顺序」不同时,现有次序不变", () => {
    // 故意让「后创建的」排在 key 字典序前面 —— 现有次序是 key 序,不是创建序
    mkWork({ id: "wk_z", priority: 4 });
    mkWork({ id: "wk_a2", priority: 4 });
    expect(executeOrder()).toEqual(["wk_a2", "wk_z"]);
  });

  it("待办种类优先级仍然第一:answer_ask(种类 0)压过 priority=0 的 execute_work", () => {
    mkWork({ id: "wk_urgent", priority: 0 });
    insertAsk(db, {
      id: "ak_1", projectId: "pj_1", fromAgentId: "bm", toAgentId: "pm",
      question: "范围要不要收?", hypothesis: "默认按原范围走", createdAt: T0,
    });
    const board = collectTodos({ db, projectId: "pj_1", now: T0 });
    expect(board.runnable[0]?.kind).toBe("answer_ask");
    // 工作项优先级只在 execute_work 内部生效
    const kinds = board.runnable.map((t) => t.kind);
    expect(kinds.indexOf("answer_ask")).toBeLessThan(kinds.indexOf("execute_work"));
  });
});
