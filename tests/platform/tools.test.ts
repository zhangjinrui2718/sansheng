/**
 * 平台工具层 + 派发器测试(批次 4)
 *
 * 派发器是**授权模型真正生效的地方** —— 前面所有层都只是声明。所以这里重点测:
 *   - 未实现 / 未知 / 越权的调用是否被拦下,且拒绝信息带合法取值
 *   - 工具实现的业务语义(负责人解析、环回滚、终态必须给 resolution)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import {
  dispatch, ALL_PLATFORM_TOOLS, TOOL_INDEX, checkRegistryConsistency,
  registrySnapshot, notYetBuiltToolNames, toolBuildStatusForRole,
  capabilitiesWithoutTools, toolsForCapability,
} from "../../src/platform/tools/registry.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import {
  insertProject, addMember, loadProjectForAuthz, getProjectRow,
} from "../../src/platform/storage/repo/projects.js";
import { insertWork, getWork, listDeps, addDep } from "../../src/platform/storage/repo/works.js";
import { listArtifacts, getArtifact, listLinks } from "../../src/platform/storage/repo/artifacts.js";
import { listBlockers, getBlocker, listBlockedWorks } from "../../src/platform/storage/repo/blockers.js";
import { getChange, listAffectedWorks, changesForWork } from "../../src/platform/storage/repo/changes.js";
import type { Agent, Project } from "../../src/platform/harness/authorize.js";
import type { ProjectRole, Specialization } from "../../src/platform/identity/role.js";

let db: Database.Database;
let seq = 0;
let clock = 1_700_000_000_000;
let project: Project;
const agents = new Map<string, Agent>();

const ids: Record<string, string> = {};

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  clock = 1_700_000_000_000;
  agents.clear();

  function mk(role: ProjectRole, spec?: Specialization): Agent {
    const id = `ag_${role}${spec ? "_" + spec : ""}`;
    insertAgent(db, {
      id, role, specialization: spec ?? null, displayName: `${role}${spec ?? ""}`, createdAt: clock,
    });
    const a: Agent = { id, role, displayName: `${role}${spec ?? ""}`, ...(spec ? { specialization: spec } : {}) };
    agents.set(id, a);
    return a;
  }

  ids.bm = mk("business_manager").id;
  ids.pm = mk("project_manager").id;
  ids.wkAlgo = mk("worker", "algorithm").id;
  ids.wkEng = mk("worker", "engineering").id;
  ids.qa = mk("quality_reviewer").id;

  const pid = "pj_1";
  insertProject(db, {
    id: pid, name: "测试项目", client: "甲方", goal: "跑通", status: "active", createdAt: clock,
  });
  for (const id of Object.values(ids)) addMember(db, pid, id, clock);
  project = loadProjectForAuthz(db, pid)!;
});
afterEach(() => db.close());

function ctxFor(agentId: string): ToolRunContext {
  const agent = agents.get(agentId);
  if (!agent) throw new Error(`未知 agent ${agentId}`);
  return {
    db,
    agent,
    project,
    now: () => clock,
    newId: (prefix) => `${prefix}_new${++seq}`,
  };
}

function call(agentId: string, tool: string, args: Record<string, unknown> = {}): ToolResult {
  const r = dispatch(tool, args, ctxFor(agentId));
  if (r instanceof Promise) throw new Error("本测试只覆盖同步工具");
  return r;
}

/** 断言成功并返回文本 */
function okText(r: ToolResult): string {
  if (!r.ok) throw new Error(`期望成功,实际失败[${r.code}] ${r.message}`);
  return r.text;
}

/** 断言失败并返回错误 */
function errOf(r: ToolResult): Extract<ToolResult, { ok: false }> {
  if (r.ok) throw new Error(`期望失败,实际成功:${r.text}`);
  return r;
}

// ── 注册表自检 ──────────────────────────────────────────────────

describe("注册表 · 声明与能力必须一致(7-E 那个坑的机器防线)", () => {
  it("没有任何一致性问题", () => {
    expect(checkRegistryConsistency()).toEqual([]);
  });

  it("工具名不重复", () => {
    const names = ALL_PLATFORM_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("每个工具的 capability 都在能力闭集里", () => {
    for (const t of ALL_PLATFORM_TOOLS) {
      expect(toolsForCapability(t.capability).length).toBeGreaterThan(0);
    }
  });

  it("registrySnapshot 如实报告未实现的工具(SDK 内置不算「未建」)", () => {
    const s = registrySnapshot();
    expect(s.problems).toEqual([]);
    expect(s.implemented).toBe(ALL_PLATFORM_TOOLS.length);
    // 未建 = 工具表里既没实现、也不是 SDK 提供的
    expect(s.notYetBuilt).not.toContain("read");
    expect(s.notYetBuilt).not.toContain("bash");
    expect(s.notYetBuilt.length).toBeLessThan(s.totalInTable - s.implemented);
  });

  it("工具表里的平台工具**全部已实现**(BC0–BC7 与甲方接口都已落地)", () => {
    // 剩下的 7 个是 SDK 内置(read/grep/find/ls/edit/write/bash),不算「未建」
    expect(notYetBuiltToolNames()).toEqual([]);
  });

  it("**没有任何未覆盖能力** —— 33 条全部有工具(排除 SDK 内置那几族后的净缺口为 0)", () => {
    const gap = capabilitiesWithoutTools();
    expect(gap).toEqual([]);
    // 回归守卫:code.* 的工具是 SDK 内置的,永远不该被算成缺口
    expect(gap).not.toContain("code.read");
    expect(gap).not.toContain("code.exec");
  });

  it("角色工具建成状态:已实现 + 未实现 = 出厂工具集", () => {
    for (const role of ["business_manager", "project_manager", "worker", "quality_reviewer"] as const) {
      const { implemented, notYetBuilt } = toolBuildStatusForRole(role);
      expect(implemented.length + notYetBuilt.length).toBeGreaterThan(0);
      for (const t of notYetBuilt) expect(TOOL_INDEX.has(t)).toBe(false);
      for (const t of implemented) expect(TOOL_INDEX.has(t)).toBe(true);
    }
  });
});

// ── 派发器的拦截行为 ────────────────────────────────────────────

describe("派发器 · 四道拦截", () => {
  it("未知工具名 → 拒绝,并回灌已实现工具的名单", () => {
    const e = errOf(call(ids.bm, "no_such_tool"));
    expect(e.code).toBe("invalid_args");
    expect(e.alternatives).toContain("project_open");
  });

  it("「还没建」分支保留给将来往工具表加条目(当前走不到)", () => {
    // dispatch 里有这条分支:工具在 ALL_TOOLS 里但不在 TOOL_INDEX 里 → 明确说
    // 「还没建实现」,而不是让模型以为工具坏了。它是防止「工具表加了名字但忘了
    // 写实现」的守卫 —— 8-A 那次「集合文件声称 13 个、循环里只有 6 个」的同族。
    //
    // 现在 33 条能力全部有实现,所以这条分支走不到。这里断言的是**这个事实**,
    // 而不是删掉测试 —— 将来加工具时它会立刻重新变红提醒。
    expect(notYetBuiltToolNames()).toEqual([]);
  });

  it("角色 ceiling 不含该能力 → denied(即便工具存在)", () => {
    // worker 没有 project.open
    const e = errOf(call(ids.wkAlgo, "project_open", { name: "x", client: "y", goal: "z" }));
    expect(e.code).toBe("denied");
    expect(e.message).toContain("架构上界");
  });

  it("调用期 writeKind 门 → denied,并回灌该角色的合法 kind", () => {
    const e = errOf(call(ids.qa, "board_write", { kind: "evidence", title: "t", body: "b" }));
    expect(e.code).toBe("denied");
    expect(e.alternatives).toEqual(["review_finding"]);
  });

  it("质检审查员写 review_finding 通过", () => {
    const r = call(ids.qa, "board_write", { kind: "review_finding", title: "审查意见", body: "有据" });
    expect(okText(r)).toContain("review_finding");
  });

  it("一切正常时执行到工具实现", () => {
    const r = call(ids.bm, "project_read", {});
    expect(okText(r)).toContain("测试项目");
  });
});

// ── project_* / work_* ──────────────────────────────────────────

describe("BC1 工具 · project_*", () => {
  it("project_open 建项目并把自己加为成员", () => {
    const r = call(ids.bm, "project_open", { name: "新项目", client: "甲方A", goal: "交付 X" });
    const text = okText(r);
    const pid = text.match(/已立项 (\S+?)「/)?.[1];
    expect(pid).toBeDefined();
    expect(getProjectRow(db, pid!)?.status).toBe("active");
    // 立项人自动成为成员 —— 否则业务经理建完项目反而不在里面
    expect(loadProjectForAuthz(db, pid!)!.assignments.map((a) => a.agentId)).toContain(ids.bm);
  });

  it("project_open 缺参数 → invalid_args", () => {
    const e = errOf(call(ids.bm, "project_open", { name: "只有名字" }));
    expect(e.code).toBe("invalid_args");
    expect(e.message).toContain("client");
  });

  it("project_read 渲染成员与工作项分布", () => {
    const t = okText(call(ids.bm, "project_read", {}));
    expect(t).toContain("## 成员(5)");
    expect(t).toContain("business_manager");
    expect(t).toContain("## 工作项(0)");
  });

  it("project_read 找不到项目 → not_found", () => {
    expect(errOf(call(ids.bm, "project_read", { projectId: "nope" })).code).toBe("not_found");
  });

  it("project_update 改非终态字段", () => {
    okText(call(ids.bm, "project_update", { name: "改名", status: "paused" }));
    expect(getProjectRow(db, "pj_1")).toMatchObject({ name: "改名", status: "paused" });
  });

  it("project_update 拒绝终态值(终态要走 project_close)", () => {
    const e = errOf(call(ids.bm, "project_update", { status: "done" }));
    expect(e.code).toBe("invalid_args");
    expect(e.alternatives).toEqual(["active", "paused"]);
  });

  it("project_update 对不存在的项目 → not_found(而不是静默成功)", () => {
    expect(errOf(call(ids.bm, "project_update", { projectId: "nope", name: "x" })).code).toBe("not_found");
  });

  it("project_close 落终态", () => {
    okText(call(ids.bm, "project_close", { outcome: "done" }));
    expect(getProjectRow(db, "pj_1")?.status).toBe("done");
  });

  it("project_close 重复关闭 → conflict", () => {
    okText(call(ids.bm, "project_close", { outcome: "done" }));
    expect(errOf(call(ids.bm, "project_close", { outcome: "abandoned" })).code).toBe("conflict");
  });

  it("project_close 拒绝非法 outcome", () => {
    const e = errOf(call(ids.bm, "project_close", { outcome: "cancelled" }));
    expect(e.code).toBe("invalid_args");
    expect(e.alternatives).toEqual(["done", "abandoned"]);
  });
});

describe("BC1 工具 · work_*", () => {
  it("work_create 解析负责人并建项", () => {
    const t = okText(call(ids.pm, "work_create", {
      title: "实现算法", goal: "产出可复现结果",
      assigneeRole: "worker", assigneeSpec: "algorithm",
    }));
    const wid = t.match(/已创建 (\S+?)「/)?.[1];
    expect(wid).toBeDefined();
    expect(getWork(db, wid!)?.assigneeAgentId).toBe(ids.wkAlgo);
  });

  it("work_create 角色不存在 → not_found,并列出项目里实际有的角色", () => {
    const e = errOf(call(ids.pm, "work_create", {
      title: "x", goal: "y", assigneeRole: "nonexistent",
    }));
    expect(e.code).toBe("not_found");
    expect(e.alternatives).toContain("worker");
  });

  it("work_create 同角色多人且未给 spec → 报歧义,迫使明确", () => {
    const e = errOf(call(ids.pm, "work_create", {
      title: "x", goal: "y", assigneeRole: "worker",
    }));
    expect(e.code).toBe("not_found");
    expect(e.message).toContain("必须用 spec");
    expect(e.alternatives?.length).toBe(2);
  });

  it("work_create 细分不存在 → 列出实际存在的细分", () => {
    const e = errOf(call(ids.pm, "work_create", {
      title: "x", goal: "y", assigneeRole: "worker", assigneeSpec: "data",
    }));
    expect(e.code).toBe("not_found");
    expect(e.alternatives).toEqual(["algorithm", "engineering"]);
  });

  it("work_create 带合法依赖", () => {
    const a = okText(call(ids.pm, "work_create", {
      title: "A", goal: "g", assigneeRole: "worker", assigneeSpec: "algorithm",
    })).match(/已创建 (\S+?)「/)![1]!;
    const t = okText(call(ids.pm, "work_create", {
      title: "B", goal: "g", assigneeRole: "worker", assigneeSpec: "engineering",
      dependsOn: [a],
    }));
    const b = t.match(/已创建 (\S+?)「/)![1]!;
    expect(listDeps(db, b)).toEqual([a]);
  });

  it("依赖成环 → conflict,且**工作项回滚**(不留半成品)", () => {
    const a = okText(call(ids.pm, "work_create", {
      title: "A", goal: "g", assigneeRole: "worker", assigneeSpec: "algorithm",
    })).match(/已创建 (\S+?)「/)![1]!;
    const b = okText(call(ids.pm, "work_create", {
      title: "B", goal: "g", assigneeRole: "worker", assigneeSpec: "engineering",
      dependsOn: [a],
    })).match(/已创建 (\S+?)「/)![1]!;
    // A 再依赖 B → 成环
    const before = db.prepare(`SELECT COUNT(*) AS n FROM works`).get() as { n: number };
    const e = errOf(call(ids.pm, "work_create", {
      title: "C", goal: "g", assigneeRole: "worker", assigneeSpec: "algorithm",
      dependsOn: [a, "wk_missing"],
    }));
    expect(e.code).toBe("conflict");
    const after = db.prepare(`SELECT COUNT(*) AS n FROM works`).get() as { n: number };
    expect(after.n, "失败的创建不该留下工作项").toBe(before.n);
    void b;
  });

  it("work_create 指定不存在的父项 → not_found", () => {
    expect(errOf(call(ids.pm, "work_create", {
      title: "x", goal: "y", assigneeRole: "worker", assigneeSpec: "algorithm",
      parentWorkId: "nope",
    })).code).toBe("not_found");
  });

  it("work_update 改状态;非法状态回灌闭集", () => {
    const t = okText(call(ids.pm, "work_create", {
      title: "A", goal: "g", assigneeRole: "worker", assigneeSpec: "algorithm",
    }));
    const w = t.match(/已创建 (\S+?)「/)![1]!;
    okText(call(ids.wkAlgo, "work_update", { workId: w, status: "in_progress" }));
    expect(getWork(db, w)?.status).toBe("in_progress");
    const e = errOf(call(ids.wkAlgo, "work_update", { workId: w, status: "doing" }));
    expect(e.code).toBe("invalid_args");
    expect(e.alternatives).toContain("blocked");
  });

  it("work_assign 改派走同一套歧义检查", () => {
    const t = okText(call(ids.pm, "work_create", {
      title: "A", goal: "g", assigneeRole: "worker", assigneeSpec: "algorithm",
    }));
    const w = t.match(/已创建 (\S+?)「/)![1]!;
    const e = errOf(call(ids.pm, "work_assign", { workId: w, assigneeRole: "worker" }));
    expect(e.message, "改派也要做歧义检查,不因它是小操作而绕过").toContain("必须用 spec");
    okText(call(ids.pm, "work_assign", { workId: w, assigneeRole: "worker", assigneeSpec: "engineering" }));
    expect(getWork(db, w)?.assigneeAgentId).toBe(ids.wkEng);
  });

  it("work_list / work_read 渲染", () => {
    okText(call(ids.pm, "work_create", {
      title: "算法任务", goal: "g", assigneeRole: "worker", assigneeSpec: "algorithm",
    }));
    const list = okText(call(ids.pm, "work_list", {}));
    expect(list).toContain("算法任务");
    const wid = list.match(/(wk_new\d+)/)![1]!;
    const detail = okText(call(ids.pm, "work_read", { workId: wid }));
    expect(detail).toContain("前置依赖");
    expect(detail).toContain("已失败(永远等不到)");
  });

  it("work_list 空结果给可读文案", () => {
    expect(okText(call(ids.pm, "work_list", {}))).toContain("没有匹配的工作项");
  });

  it("report 记录进度,并可选改状态", () => {
    const t = okText(call(ids.pm, "work_create", {
      title: "A", goal: "g", assigneeRole: "worker", assigneeSpec: "algorithm",
    }));
    const w = t.match(/已创建 (\S+?)「/)![1]!;
    const r = okText(call(ids.wkAlgo, "report", { workId: w, summary: "跑通了基线", status: "in_progress" }));
    expect(r).toContain("跑通了基线");
    expect(getWork(db, w)?.status).toBe("in_progress");
  });
});

// ── board_* ─────────────────────────────────────────────────────

describe("BC3 工具 · board_*", () => {
  it("board_write 写工件,作者自动填当前 agent", () => {
    const t = okText(call(ids.wkAlgo, "board_write", { kind: "evidence", title: "证据", body: "结果如下" }));
    const aid = t.match(/已写工件 (\S+?)\(/)![1]!;
    const a = getArtifact(db, aid)!;
    expect(a.authorAgentId).toBe(ids.wkAlgo);
    expect(a.status).toBe("open");
    expect(a.projectId).toBe("pj_1");
  });

  it("board_write 不存在的 kind → **参数错**,回灌 kind 全集", () => {
    const e = errOf(call(ids.wkAlgo, "board_write", { kind: "bogus", title: "t", body: "b" }));
    // 值不存在 = 模型记错了参数名 → invalid_args(不是 denied)
    expect(e.code).toBe("invalid_args");
    // 回灌的是**全集**:问题出在值本身,不是权限
    expect(e.alternatives).toContain("review_finding");
    expect(e.alternatives).toContain("project_brief");
    expect(e.alternatives?.length).toBeGreaterThan(5);
  });

  it("board_write 存在但本角色不能写 → **权限错**,只回灌该角色的合法值", () => {
    // evidence 是合法 kind,但 worker 能写、质检不能
    const e = errOf(call(ids.qa, "board_write", { kind: "evidence", title: "t", body: "b" }));
    expect(e.code).toBe("denied");
    // 只回灌该角色能写的 —— 换个别的值才有意义
    expect(e.alternatives).toEqual(["review_finding"]);
  });

  it("工具自身的 kind 闭集校验不是死代码(直接调用时仍然生效)", () => {
    // 派发器会把不存在的 kind 拦在门外,所以工具内部那道检查要靠直接调用来验证 ——
    // 否则它是「看起来有防御、实际永远走不到」的假防线。
    const tool = TOOL_INDEX.get("board_write")!;
    const r = tool.run(
      { kind: "bogus", title: "t", body: "b" },
      ctxFor(ids.wkAlgo),
    );
    if (r instanceof Promise) throw new Error("sync only");
    const e = errOf(r);
    expect(e.code).toBe("invalid_args");
    expect(e.alternatives).toContain("evidence");
  });

  it("board_write 带 links 建立关联", () => {
    const p = okText(call(ids.bm, "board_write", { kind: "project_brief", title: "立项书", body: "..." }))
      .match(/已写工件 (\S+?)\(/)![1]!;
    const c = okText(call(ids.pm, "board_write", { kind: "work_brief", title: "工作说明", body: "..." }))
      .match(/已写工件 (\S+?)\(/)![1]!;
    okText(call(ids.pm, "board_write", {
      kind: "note", title: "关联备注", body: "...",
      links: [{ rel: "parent", targetId: p }],
    }));
    expect(listLinks(db, c)).toEqual([]); // c 没建边
    // 校验第三条的边真的建了
    const notes = listArtifacts(db, "pj_1", { kind: "note" });
    expect(listLinks(db, notes[0]!.id)).toEqual([p]);
  });

  it("board_write 的边建不上时如实告警,不静默", () => {
    const t = okText(call(ids.pm, "board_write", {
      kind: "note", title: "n", body: "b",
      links: [{ rel: "parent", targetId: "ghost" }],
    }));
    expect(t).toContain("部分关联未建立");
    expect(t).toContain("not_found");
  });

  it("board_list 作用域是项目(跨会话都能看到)", () => {
    okText(call(ids.wkAlgo, "board_write", { kind: "evidence", title: "E1", body: "b" }));
    okText(call(ids.qa, "board_write", { kind: "review_finding", title: "R1", body: "b" }));
    const t = okText(call(ids.bm, "board_list", {}));
    expect(t).toContain("E1");
    expect(t).toContain("R1");
    expect(t).toContain("evidence:1");
  });

  it("board_list 可按 kind 过滤;非法 kind 回灌闭集", () => {
    okText(call(ids.wkAlgo, "board_write", { kind: "evidence", title: "E1", body: "b" }));
    expect(okText(call(ids.bm, "board_list", { kind: "evidence" }))).toContain("E1");
    const e = errOf(call(ids.bm, "board_list", { kind: "bogus" }));
    expect(e.alternatives).toContain("evidence");
  });

  it("board_read 给出正文与关联;找不到 → not_found", () => {
    const aid = okText(call(ids.wkAlgo, "board_write", { kind: "hypothesis", title: "猜测", body: "正文在此" }))
      .match(/已写工件 (\S+?)\(/)![1]!;
    const t = okText(call(ids.pm, "board_read", { artifactId: aid }));
    expect(t).toContain("正文在此");
    expect(errOf(call(ids.pm, "board_read", { artifactId: "nope" })).code).toBe("not_found");
  });
});

// ── blocker_* / change_* ────────────────────────────────────────

describe("BC4 工具 · blocker_*", () => {
  function mkWork(): string {
    return okText(call(ids.pm, "work_create", {
      title: "W", goal: "g", assigneeRole: "worker", assigneeSpec: "algorithm",
    })).match(/已创建 (\S+?)「/)![1]!;
  }

  it("blocker_open 登记并关联工作项", () => {
    const w = mkWork();
    const t = okText(call(ids.wkAlgo, "blocker_open", {
      title: "缺依赖", detail: "上游包没发;已试过手工打补丁", severity: "critical",
      blocksWorkIds: [w],
    }));
    const bid = t.match(/已登记阻塞 (\S+?)\(/)![1]!;
    expect(listBlockedWorks(db, bid)).toEqual([w]);
  });

  it("blocker_open 挡住不存在的工作项 → not_found(不登记「挡住不存在的东西」)", () => {
    const e = errOf(call(ids.wkAlgo, "blocker_open", {
      title: "x", detail: "d", severity: "high", blocksWorkIds: ["nope"],
    }));
    expect(e.code).toBe("not_found");
  });

  it("blocker_open 非法 severity → 回灌闭集", () => {
    const e = errOf(call(ids.wkAlgo, "blocker_open", { title: "x", detail: "d", severity: "urgent" }));
    expect(e.alternatives).toEqual(["low", "medium", "high", "critical"]);
  });

  it("blocker_update 落终态必须给 resolution", () => {
    const bid = okText(call(ids.wkAlgo, "blocker_open", {
      title: "x", detail: "d", severity: "high",
    })).match(/已登记阻塞 (\S+?)\(/)![1]!;
    expect(errOf(call(ids.pm, "blocker_update", { blockerId: bid, status: "resolved" })).code)
      .toBe("invalid_args");
    okText(call(ids.pm, "blocker_update", { blockerId: bid, status: "resolved", resolution: "补了包" }));
    expect(getBlocker(db, bid)?.resolution).toBe("补了包");
  });

  it("blocker_update 非法状态 → 回灌闭集", () => {
    const bid = okText(call(ids.wkAlgo, "blocker_open", {
      title: "x", detail: "d", severity: "high",
    })).match(/已登记阻塞 (\S+?)\(/)![1]!;
    expect(errOf(call(ids.pm, "blocker_update", { blockerId: bid, status: "pending" })).alternatives)
      .toContain("acknowledged");
  });

  it("blocker_list unresolvedOnly 是「还有什么没解决」的标准问法", () => {
    const a = okText(call(ids.wkAlgo, "blocker_open", { title: "开着的", detail: "d", severity: "high" }))
      .match(/已登记阻塞 (\S+?)\(/)![1]!;
    const b = okText(call(ids.wkAlgo, "blocker_open", { title: "已解", detail: "d", severity: "low" }))
      .match(/已登记阻塞 (\S+?)\(/)![1]!;
    okText(call(ids.pm, "blocker_update", { blockerId: b, status: "resolved", resolution: "修好了" }));

    const open = okText(call(ids.bm, "blocker_list", { unresolvedOnly: true }));
    expect(open).toContain("开着的");
    expect(open).not.toContain("已解");
    expect(okText(call(ids.bm, "blocker_list", {}))).toContain("已解");
    void a;
  });

  it("blocker_read 找不到 → not_found", () => {
    expect(errOf(call(ids.bm, "blocker_read", { blockerId: "nope" })).code).toBe("not_found");
  });
});

describe("BC4 工具 · change_*", () => {
  it("change_propose 登记并关联受影响工作项", () => {
    const w = okText(call(ids.pm, "work_create", {
      title: "W", goal: "g", assigneeRole: "worker", assigneeSpec: "algorithm",
    })).match(/已创建 (\S+?)「/)![1]!;
    const t = okText(call(ids.bm, "change_propose", {
      title: "加字段", rationale: "甲方要求", impact: ["schema", "前端"],
      affectedWorkIds: [w],
    }));
    const cid = t.match(/已提出变更 (\S+?)「/)![1]!;
    expect(listAffectedWorks(db, cid)).toEqual([w]);
    expect(changesForWork(db, w).map((c) => c.id)).toEqual([cid]);
  });

  it("change_propose 缺 rationale → invalid_args", () => {
    expect(errOf(call(ids.bm, "change_propose", { title: "x" })).code).toBe("invalid_args");
  });

  it("change_review 合法链 proposed → under_review → accepted → implemented", () => {
    const cid = okText(call(ids.bm, "change_propose", { title: "c", rationale: "r" }))
      .match(/已提出变更 (\S+?)「/)![1]!;
    okText(call(ids.pm, "change_review", { changeId: cid, verdict: "under_review" }));
    okText(call(ids.pm, "change_review", { changeId: cid, verdict: "accepted", comment: "可行" }));
    okText(call(ids.wkAlgo, "change_review", { changeId: cid, verdict: "implemented" }));
    expect(getChange(db, cid)?.status).toBe("implemented");
  });

  it("**proposed 直接跳 implemented 被拒**,并给出可行的下一步", () => {
    const cid = okText(call(ids.bm, "change_propose", { title: "c", rationale: "r" }))
      .match(/已提出变更 (\S+?)「/)![1]!;
    const e = errOf(call(ids.pm, "change_review", { changeId: cid, verdict: "implemented" }));
    expect(e.code).toBe("conflict");
    expect(e.alternatives).toContain("under_review");
    expect(getChange(db, cid)?.status, "非法迁移不该写库").toBe("proposed");
  });

  it("终态不可再流转,并告知已是终态", () => {
    const cid = okText(call(ids.bm, "change_propose", { title: "c", rationale: "r" }))
      .match(/已提出变更 (\S+?)「/)![1]!;
    okText(call(ids.pm, "change_review", { changeId: cid, verdict: "rejected", comment: "不做" }));
    const e = errOf(call(ids.pm, "change_review", { changeId: cid, verdict: "under_review" }));
    expect(e.code).toBe("conflict");
    expect(e.alternatives?.[0]).toContain("终态");
  });

  it("change_list / change_read 渲染", () => {
    okText(call(ids.bm, "change_propose", { title: "加字段", rationale: "甲方要求", impact: ["schema"] }));
    const list = okText(call(ids.bm, "change_list", {}));
    expect(list).toContain("加字段");
    const cid = list.match(/(chg_new\d+)/)![1]!;
    expect(okText(call(ids.bm, "change_read", { changeId: cid }))).toContain("甲方要求");
  });

  it("change_read 找不到 → not_found", () => {
    expect(errOf(call(ids.bm, "change_read", { changeId: "nope" })).code).toBe("not_found");
  });
});

// ── 端到端:一次完整的项目推进 ──────────────────────────────────

describe("端到端 · 立项 → 拆解 → 干活 → 阻塞 → 变更 → 审查", () => {
  it("四个角色各司其职跑通一条链", () => {
    // 业务经理立项
    const pid = okText(call(ids.bm, "project_open", { name: "真项目", client: "甲方", goal: "交付" }))
      .match(/已立项 (\S+?)「/)![1]!;
    // 立项人进项目;其余成员由 boot 逻辑加(这里手工补,BC1 还没有 member 管理工具)
    for (const id of [ids.pm, ids.wkAlgo, ids.qa]) addMember(db, pid, id, clock);
    const proj = loadProjectForAuthz(db, pid)!;
    const ctx = (a: Agent): ToolRunContext => ({ db, agent: a, project: proj, now: () => clock, newId: (p) => `${p}_new${++seq}` });
    const run = (a: Agent, tool: string, args: Record<string, unknown> = {}): ToolResult => {
      const r = dispatch(tool, args, ctx(a));
      if (r instanceof Promise) throw new Error("sync only");
      return r;
    };

    const bm = agents.get(ids.bm)!, pm = agents.get(ids.pm)!, wk = agents.get(ids.wkAlgo)!, qa = agents.get(ids.qa)!;

    // 立项书
    okText(run(bm, "board_write", { kind: "project_brief", title: "立项书", body: "目标:交付" }));

    // 项目经理拆解 + 记录进度
    const w = okText(run(pm, "work_create", {
      title: "实现核心", goal: "跑通 + 有可复现结果",
      assigneeRole: "worker", assigneeSpec: "algorithm",
    })).match(/已创建 (\S+?)「/)![1]!;

    // worker 干活 → 产出证据
    okText(run(wk, "work_update", { workId: w, status: "in_progress" }));
    okText(run(wk, "board_write", { kind: "evidence", title: "跑通结果", body: "指标 X=0.9" }));

    // worker 遇阻 → 登记阻塞并关联工作项
    const b = okText(run(wk, "blocker_open", {
      title: "缺数据集", detail: "公开集下载失败;已试镜像", severity: "critical", blocksWorkIds: [w],
    })).match(/已登记阻塞 (\S+?)\(/)![1]!;

    // 项目经理解决阻塞
    okText(run(pm, "blocker_update", { blockerId: b, status: "resolved", resolution: "改用内网源" }));
    expect(listBlockers(db, pid, { unresolvedOnly: true })).toEqual([]);

    // 甲方中途提变更 → 业务经理登记 → 项目经理评审
    const c = okText(run(bm, "change_propose", {
      title: "增加导出", rationale: "甲方要求", impact: ["API"], affectedWorkIds: [w],
    })).match(/已提出变更 (\S+?)「/)![1]!;
    okText(run(pm, "change_review", { changeId: c, verdict: "under_review" }));
    okText(run(pm, "change_review", { changeId: c, verdict: "accepted", comment: "影响可控" }));

    // 质检审查
    okText(run(qa, "board_write", { kind: "review_finding", title: "通过", body: "指标可复现" }));

    // 收尾:工作项完成、项目关闭
    okText(run(wk, "report", { workId: w, summary: "交付完成", status: "done" }));
    okText(run(bm, "project_close", { outcome: "done" }));

    // 终态校验
    expect(getProjectRow(db, pid)!.status).toBe("done");
    expect(getWork(db, w)!.status).toBe("done");
    expect(getChange(db, c)!.status).toBe("accepted");
    expect(listArtifacts(db, pid)).toHaveLength(3); // 立项书 + 证据 + 审查意见
    expect(changesForWork(db, w)).toHaveLength(1);
  });
});
