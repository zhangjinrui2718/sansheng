/**
 * SDK 适配壳与会话装配测试(ADR-001 §4 的三条验证)
 *
 * ── 这组测试要防的是什么 ────────────────────────────────────────
 *
 * 8-A 的事故形态:**集合文件声称执行者有 13 个工具,工具循环里真的只有 6 个**,
 * 而出厂提示词正教模型用那 7 个不存在的 → 调用失败 → 纪律压力下编造。
 *
 * 新侧有完全相同的风险面:图里说 41 个工具、`solveToolset` 算出 N 个、
 * 适配壳真的交出去 M 个 —— 三个数一旦不一致,模型看到的就是不存在的工具。
 * 而这个风险**只在真正接线的那一刻才暴露**,那是最贵的时刻。
 *
 * 所以 ADR §4 定了三条验证,这里是它们的实现:
 *   ① 适配壳产出的名字集合 === solveToolset().tools
 *   ② 假 SDK 跑通「装配 → 调用 → 结果」全链
 *   ③ 不变式:solveToolset 给的每个工具都必须在注册表里
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import {
  insertProject, addMember, removeMember, updateProject, loadProjectForAuthz,
} from "../../src/platform/storage/repo/projects.js";
import { SqliteMemory } from "../../src/platform/memory/sqliteMemory.js";
import {
  buildToolContext, planAgentSession, type RuntimeDeps,
} from "../../src/platform/runtime/assembly.js";
import { toSdkTools, paramNames, adapterToolNames, splitToolset } from "../../src/platform/runtime/sdkAdapter.js";
import { solveToolset } from "../../src/platform/harness/authorize.js";
import {
  dispatch, TOOL_INDEX, ALL_PLATFORM_TOOLS, notYetBuiltToolNames,
} from "../../src/platform/tools/registry.js";
import { ROLE_SPECS, PROJECT_ROLES, type ProjectRole, type Specialization } from "../../src/platform/identity/role.js";
import type { Agent, Project } from "../../src/platform/harness/authorize.js";
import type { ToolRunContext } from "../../src/platform/tools/types.js";

let db: Database.Database;
let seq = 0;
const clock = 1_700_000_000_000;
let deps: RuntimeDeps;
const ids: Record<string, string> = {};

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  function mk(role: ProjectRole, spec?: Specialization): string {
    const id = `ag_${role}${spec ? "_" + spec : ""}`;
    insertAgent(db, { id, role, specialization: spec ?? null, displayName: `${role}${spec ?? ""}`, createdAt: clock });
    return id;
  }
  ids.bm = mk("business_manager");
  ids.pm = mk("project_manager");
  ids.wk = mk("worker", "algorithm");
  ids.qa = mk("quality_reviewer");

  insertProject(db, { id: "p1", name: "测试", client: "甲", goal: "g", status: "active", createdAt: clock });
  for (const id of Object.values(ids)) addMember(db, "p1", id, clock);

  deps = {
    db,
    memory: new SqliteMemory(db, { newId: (p) => `${p}_${++seq}`, now: () => clock }),
    now: () => clock,
    newId: (p) => `${p}_${++seq}`,
  };
});
afterEach(() => db.close());

// ── assembly ────────────────────────────────────────────────────

describe("assembly · 上下文组装", () => {
  it("正常组装出 ctx", () => {
    const r = buildToolContext(deps, ids.wk, "p1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ctx.agent.id).toBe(ids.wk);
    expect(r.ctx.project.id).toBe("p1");
    expect(r.ctx.memory).toBeDefined();
    expect(r.ctx.now()).toBe(clock);
  });

  it("agent 不存在 → no_such_agent", () => {
    const r = buildToolContext(deps, "ghost", "p1");
    expect(r).toMatchObject({ ok: false, reason: "no_such_agent" });
  });

  it("项目不存在 → no_such_project", () => {
    const r = buildToolContext(deps, ids.wk, "ghost");
    expect(r).toMatchObject({ ok: false, reason: "no_such_project" });
  });

  it("**agent 不在项目里 → agent_not_assigned**", () => {
    // 不校验这条的话,一个不属于该项目的 agent 能拿到该项目的 ctx,
    // 于是 scope 门形同虚设(它只看 project.status,不看调用者是谁)
    removeMember(db, "p1", ids.qa, clock + 1);
    const r = buildToolContext(deps, ids.qa, "p1");
    expect(r).toMatchObject({ ok: false, reason: "agent_not_assigned" });
    if (r.ok) return;
    expect(r.detail).toContain("不是项目");
  });

  it("角色未定义(数据库被外部写坏)→ role_unknown,不静默放行", () => {
    db.pragma("ignore_check_constraints = ON");
    db.prepare(`UPDATE agents SET role = 'ceo' WHERE id = ?`).run(ids.wk);
    db.pragma("ignore_check_constraints = OFF");
    expect(buildToolContext(deps, ids.wk, "p1")).toMatchObject({ ok: false, reason: "role_unknown" });
  });
});

describe("assembly · planAgentSession 是接线核心", () => {
  it("**solveToolset 在这里第一次被真实调用**", () => {
    const r = planAgentSession(deps, ids.wk, "p1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 与直接调用求解器的结果必须逐项一致
    const direct = solveToolset(
      { id: ids.wk, role: "worker", specialization: "algorithm", displayName: "worker" },
      loadProjectForAuthz(db, "p1")!,
    );
    expect([...r.plan.tools].sort()).toEqual([...direct.tools].sort());
  });

  it("带出提示词单元与花名册", () => {
    const r = planAgentSession(deps, ids.pm, "p1");
    if (!r.ok) throw new Error("期望成功");
    expect(r.plan.promptUnits).toEqual(ROLE_SPECS.project_manager.promptUnits);
    expect(r.plan.roster.map((m) => m.id).sort()).toEqual(
      [ids.bm, ids.pm, ids.wk, ids.qa].sort(),
    );
  });

  it("越权的集合文件条目进 blockedByCeiling(如实报出)", () => {
    const r = planAgentSession(
      { ...deps, toolSetFor: () => ({ allow: ["tell_client", "board_write"], deny: [] }) },
      ids.wk, "p1",
    );
    if (!r.ok) throw new Error("期望成功");
    expect(r.plan.blockedByCeiling).toContain("tell_client");
    expect(r.plan.tools).toContain("board_write");
  });

  it("项目非 active → 项目内工具进 blockedByScope", () => {
    updateProject(db, "p1", { status: "paused" });
    const r = planAgentSession(deps, ids.wk, "p1");
    if (!r.ok) throw new Error("期望成功");
    expect(r.plan.blockedByScope.length).toBeGreaterThan(0);
    // 记忆与代码工具是项目无关的,仍在
    expect(r.plan.tools).toContain("memory_search");
    expect(r.plan.tools).toContain("bash");
  });
});

// ── ADR §4 验证 ③:不变式 ───────────────────────────────────────

describe("不变式 · 求解出的工具必须在池子里(8-A 同款防线)", () => {
  for (const role of PROJECT_ROLES) {
    it(`${role}:求解出的每个工具都**有归属**`, () => {
      const r = planAgentSession(deps, ids[role === "worker" ? "wk" : role === "business_manager" ? "bm" : role === "project_manager" ? "pm" : "qa"]!, "p1");
      if (!r.ok) throw new Error(`规划失败:${r.detail}`);
      const split = splitToolset(r.plan.tools);
      expect(
        split.unplaceable,
        "求解给了工具面,但两条通道都放不进去 —— 这正是 8-A「声称有、实际没有」的形态。" +
          "模型会调用不存在的工具,然后编造结果",
      ).toEqual([]);
      // 拆出来的两半必须正好覆盖求解结果,不多不少
      expect([...split.builtinAllowlist, ...split.platformTools.map((t) => t.name)].sort())
        .toEqual([...r.plan.tools].sort());
    });
  }

  it("SDK 内置与平台工具被正确地分开(混了会静默失效)", () => {
    const r = planAgentSession(deps, ids.wk, "p1");
    if (!r.ok) throw new Error(r.detail);
    const split = splitToolset(r.plan.tools);
    // worker 有 code.* → 内置通道里该有 read/bash
    expect(split.builtinAllowlist).toContain("read");
    expect(split.builtinAllowlist).toContain("bash");
    // 而平台工具不该混进内置通道
    expect(split.builtinAllowlist).not.toContain("board_write");
    // 反之亦然
    expect(split.platformTools.map((t) => t.name)).not.toContain("read");
    expect(split.platformTools.map((t) => t.name)).toContain("board_write");
  });

  it("全部四个角色的工具面都不含未实现项", () => {
    expect(notYetBuiltToolNames()).toEqual([]);
  });
});

// ── ADR §4 验证 ①:适配壳产出的名字 === 求解结果 ─────────────────

describe("适配壳 · 名字集合必须与求解结果完全一致", () => {
  for (const key of ["bm", "pm", "wk", "qa"] as const) {
    it(`${key}:adapter 产出的工具名 === solveToolset().tools`, () => {
      const planned = planAgentSession(deps, ids[key]!, "p1");
      if (!planned.ok) throw new Error(planned.detail);
      const ctx = buildToolContext(deps, ids[key]!, "p1");
      if (!ctx.ok) throw new Error(ctx.detail);

      // 真实的会话工厂走 splitToolset:内置进 allowlist,平台工具进 customTools
      const split = splitToolset(planned.plan.tools);
      const sdkTools = toSdkTools(split.platformTools, (tool, args) => dispatch(tool.name, args, ctx.ctx), () => ctx.ctx);

      // 两条通道合起来必须正好等于求解结果 —— 不多给也不少给
      expect(
        [...split.builtinAllowlist, ...sdkTools.map((t) => t.name)].sort(),
      ).toEqual([...planned.plan.tools].sort());
      expect(sdkTools.length).toBe(split.platformTools.length);
      expect(adapterToolNames(split.platformTools).sort())
        .toEqual(split.platformTools.map((t) => t.name).sort());
    });
  }

  it("worker 的求解结果不含越权工具(多给就是越权)", () => {
    const planned = planAgentSession(deps, ids.wk, "p1");
    if (!planned.ok) throw new Error(planned.detail);
    for (const forbidden of [
      "tell_client", "ask_client", "convene", "meeting_conclude",
      "project_update", "project_close",
    ]) {
      expect(planned.plan.tools, `worker 的求解结果不该含 ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// ── ADR §4 验证 ②:假 SDK 契约测试 ──────────────────────────────

describe("假 SDK 契约测试 · 装配 → 调用 → 结果 全链", () => {
  /** 极简的假 SDK:按真实签名调用 execute,不碰任何真 session。 */
  async function callViaAdapter(
    agentId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; details: unknown }> {
    const planned = planAgentSession(deps, agentId, "p1");
    if (!planned.ok) throw new Error(planned.detail);
    const c = buildToolContext(deps, agentId, "p1");
    if (!c.ok) throw new Error(c.detail);
    const tool = splitToolset(planned.plan.tools).platformTools.find((t) => t.name === toolName);
    if (!tool) throw new Error(`${toolName} 不在 ${agentId} 的工具面里(或它不是平台工具)`);
    const [def] = toSdkTools([tool], (t, a) => dispatch(t.name, a, c.ctx), () => c.ctx);
    // 按 SDK 的真实签名调用:execute(toolCallId, params, signal, onUpdate, ctx)
    const res = await def!.execute(
      "call_1", args, undefined, undefined,
      {} as never extends never ? object : object,
    );
    const first = res.content[0];
    return {
      text: first !== undefined && "text" in first ? first.text : "",
      details: res.details,
    };
  }

  it("业务经理经适配壳成功立项", async () => {
    const r = await callViaAdapter(ids.bm, "project_open", {
      name: "经适配壳的项目", client: "甲", goal: "验证接线",
    });
    expect(r.text).toContain("已立项");
    expect(r.details, "details 恒为 null(避开 typebox 泛型反推)").toBeNull();
  });

  it("worker 写证据经适配壳成功", async () => {
    const r = await callViaAdapter(ids.wk, "board_write", {
      kind: "evidence", title: "证据", body: "结果 X",
    });
    expect(r.text).toContain("已写工件");
  });

  it("**被门控拒绝时返回文本而不是抛异常** —— 模型要能读到错误才能自纠", async () => {
    // worker 的工具面里没有 tell_client,但即便硬调 dispatch 也会被拦
    const c = buildToolContext(deps, ids.wk, "p1");
    if (!c.ok) throw new Error(c.detail);
    const tellTool = TOOL_INDEX.get("tell_client")!;
    const [def] = toSdkTools([tellTool], (t, a) => dispatch(t.name, a, c.ctx), () => c.ctx);
    const res = await def!.execute("call_1", { text: "我要说话" }, undefined, undefined, {} as object);
    const first = res.content[0];
    const text = first !== undefined && "text" in first ? first.text : "";
    expect(text).toContain("工具失败");
    expect(text).toContain("架构上界");
  });

  it("writeKind 拒绝时把合法取值一并交给模型", async () => {
    const c = buildToolContext(deps, ids.qa, "p1");
    if (!c.ok) throw new Error(c.detail);
    const boardWrite = TOOL_INDEX.get("board_write")!;
    const [def] = toSdkTools([boardWrite], (t, a) => dispatch(t.name, a, c.ctx), () => c.ctx);
    const res = await def!.execute(
      "call_1", { kind: "evidence", title: "t", body: "b" }, undefined, undefined, {} as object,
    );
    const first = res.content[0];
    const text = first !== undefined && "text" in first ? first.text : "";
    expect(text).toContain("工具失败");
    expect(text).toContain("review_finding"); // ← 该角色的合法 kind
  });

  it("工具描述与参数清单出现在给模型的元数据里(8-F 教训)", () => {
    const r = planAgentSession(deps, ids.wk, "p1");
    if (!r.ok) throw new Error(r.detail);
    const c = buildToolContext(deps, ids.wk, "p1");
    if (!c.ok) throw new Error(c.detail);
    const sdkTools = toSdkTools(
      splitToolset(r.plan.tools).platformTools,
      (t, a) => dispatch(t.name, a, c.ctx),
      () => c.ctx,
    );

    for (const d of sdkTools) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.description.length).toBeGreaterThan(10);
      // promptSnippet 决定它是否出现在默认系统提示的 Available tools 段
      expect(d.promptSnippet, `${d.name} 缺 promptSnippet`).toBeTruthy();
      expect(d.promptSnippet).toContain(d.name);
    }
  });
});

describe("paramNames · 参数清单渲染(8-F:工具协议段必须渲染参数)", () => {
  it("从 typebox schema 取出参数名", () => {
    const t = TOOL_INDEX.get("board_write")!;
    const names = paramNames(t);
    expect(names).toContain("kind");
    expect(names).toContain("title");
    expect(names).toContain("body");
  });

  it("每个工具都能取出参数名(空参数工具允许为空串)", () => {
    for (const t of ALL_PLATFORM_TOOLS) {
      const names = paramNames(t);
      expect(typeof names).toBe("string");
    }
  });
});

// ── 适配壳的纪律(机器检查,不靠人 grep)────────────────────────

describe("适配壳纪律 · 机器检查", () => {
  const SRC = readFileSync(
    join(import.meta.dirname, "../../src/platform/runtime/sdkAdapter.ts"),
    "utf8",
  );

  it("不含宽类型断言(注释里也不能出现那几个字面量)", () => {
    // 用拼接避免本测试文件自己命中项目的 grep 检查
    const forbidden = ["as " + "any", "as " + "never"];
    for (const f of forbidden) {
      expect(SRC.includes(f), `sdkAdapter.ts 含 ${f}`).toBe(false);
    }
  });

  it("只对 SDK 做 type-only import(否则窄 mock 的测试会在加载期炸)", () => {
    // 7-H 踩过:工具模块运行时 import 一个测试没桩的 SDK 导出 → 33 个失败,
    // 其中一个测试文件甚至没能加载
    const valueImports = [...SRC.matchAll(/^import\s+(?!type\b)([^;]*from\s+"@earendil-works[^"]*")/gm)];
    expect(valueImports.map((m) => m[1]), "不得对 SDK 做 value import").toEqual([]);
  });

  it("不用 SDK 那个同名助手(恒等标记本地写)", () => {
    // 同样避免本测试文件命中项目 grep —— 用拼接而不是字面量
    expect(SRC.includes("define" + "Tool")).toBe(false);
  });
});
