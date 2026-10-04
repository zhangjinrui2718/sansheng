/**
 * 会话工厂测试(ADR-001 §4 —— 接线的最终验证)
 *
 * ── 这组测试证明的是「真的接上了」────────────────────────────────
 *
 * 在此之前,`ROLE_SPECS` / `solveToolset` / `dispatch` 都只是声明。这组测试
 * 用**注入的假 SDK** 断言「到底把什么交给了 createAgentSession」——
 * 不需要 provider、不需要 API key、不需要网络。
 *
 * 这是本项目吃过亏的地方:5 个 E2E blocker 至今只有 fakeLlmCall 验证,因为
 * 「真会话」在测试里建不起来。DI seam 就是为了绕开那个取舍。
 *
 * 最关键的一条断言:**两条通道合起来必须正好等于求解结果** ——
 * 多给是越权,少给是「声称有、实际没有」(8-A 形态)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import {
  insertProject, addMember, updateProject, closeProject, removeMember,
} from "../../src/platform/storage/repo/projects.js";
import { SqliteMemory } from "../../src/platform/memory/sqliteMemory.js";
import { createPlatformSession, type CreateSessionFn } from "../../src/platform/runtime/session.js";
import { splitToolset } from "../../src/platform/runtime/sdkAdapter.js";
import { planAgentSession, type RuntimeDeps } from "../../src/platform/runtime/assembly.js";
import { TOOL_INDEX } from "../../src/platform/tools/registry.js";
import type { ProjectRole, Specialization } from "../../src/platform/identity/role.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

let db: Database.Database;
let seq = 0;
const clock = 1_700_000_000_000;
let deps: RuntimeDeps;
const ids: Record<string, string> = {};

/** 假 SDK:只记录收到了什么,不建任何真会话。 */
interface Capture {
  opts: Parameters<CreateSessionFn>[0] | null;
}
function fakeSdk(cap: Capture): CreateSessionFn {
  return async (opts) => {
    cap.opts = opts;
    return { session: { id: "fake-session" } as unknown as AgentSession };
  };
}

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

const OPTS = { cwd: "/tmp/ws", agentDir: "/tmp/agent" };

describe("createPlatformSession · 接线成功路径", () => {
  it("建出会话并带回规划结果", async () => {
    const cap: Capture = { opts: null };
    const r = await createPlatformSession(deps, ids.wk, "p1", { ...OPTS, createSession: fakeSdk(cap) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session).toBeDefined();
    expect(r.plan.agent.id).toBe(ids.wk);
    expect(r.plan.project.id).toBe("p1");
  });

  it("**两条通道合起来正好等于求解结果** —— 不多给也不少给", async () => {
    const cap: Capture = { opts: null };
    const r = await createPlatformSession(deps, ids.wk, "p1", { ...OPTS, createSession: fakeSdk(cap) });
    if (!r.ok) throw new Error(r.detail);

    const handedOver = [...r.wiring.allowlist, ...r.wiring.customToolNames].sort();
    expect(handedOver).toEqual([...r.plan.tools].sort());
    // 与真正交给 SDK 的东西一致(不是我们自己算的另一份)
    expect([...(cap.opts?.tools ?? []), ...(cap.opts?.customTools ?? []).map((t) => t.name)].sort())
      .toEqual([...r.plan.tools].sort());
  });

  it("SDK 内置进 allowlist,平台工具进 customTools(混了就静默失效)", async () => {
    const cap: Capture = { opts: null };
    const r = await createPlatformSession(deps, ids.wk, "p1", { ...OPTS, createSession: fakeSdk(cap) });
    if (!r.ok) throw new Error(r.detail);

    // worker 有 code.* → 内置通道里该有 read / bash
    expect(r.wiring.allowlist).toContain("read");
    expect(r.wiring.allowlist).toContain("bash");
    expect(r.wiring.allowlist).not.toContain("board_write");

    // 平台工具不该出现在 allowlist 里(SDK 认不出那些名字)
    for (const t of r.wiring.customToolNames) {
      expect(r.wiring.allowlist, `${t} 不该混进 SDK 内置通道`).not.toContain(t);
    }
    // 反之亦然
    for (const t of r.wiring.allowlist) {
      expect(r.wiring.customToolNames).not.toContain(t);
    }
  });

  it("customTools 带齐元数据(label / description / parameters / promptSnippet)", async () => {
    const cap: Capture = { opts: null };
    await createPlatformSession(deps, ids.pm, "p1", { ...OPTS, createSession: fakeSdk(cap) });
    const tools = cap.opts?.customTools ?? [];
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.name).toBeTruthy();
      expect(t.label).toBeTruthy();
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.parameters).toBeDefined();
      expect(t.promptSnippet).toContain(t.name);
      expect(typeof t.execute).toBe("function");
    }
  });

  it("cwd / agentDir 原样传给 SDK", async () => {
    const cap: Capture = { opts: null };
    await createPlatformSession(deps, ids.pm, "p1", { cwd: "/x/y", agentDir: "/a/b", createSession: fakeSdk(cap) });
    expect(cap.opts?.cwd).toBe("/x/y");
    expect(cap.opts?.agentDir).toBe("/a/b");
  });
});

describe("createPlatformSession · 业务经理的甲方通道", () => {
  it("业务经理的 customTools 里有 ask_client / tell_client", async () => {
    const cap: Capture = { opts: null };
    const r = await createPlatformSession(deps, ids.bm, "p1", { ...OPTS, createSession: fakeSdk(cap) });
    if (!r.ok) throw new Error(r.detail);
    expect(r.wiring.customToolNames).toContain("ask_client");
    expect(r.wiring.customToolNames).toContain("tell_client");
  });

  it("**其余三个角色的 customTools 里绝对没有它们**", async () => {
    for (const key of ["pm", "wk", "qa"] as const) {
      const cap: Capture = { opts: null };
      const r = await createPlatformSession(deps, ids[key]!, "p1", { ...OPTS, createSession: fakeSdk(cap) });
      if (!r.ok) throw new Error(r.detail);
      expect(r.wiring.customToolNames, `${key} 不该拿到 ask_client`).not.toContain("ask_client");
      expect(r.wiring.customToolNames, `${key} 不该拿到 tell_client`).not.toContain("tell_client");
    }
  });
});

describe("createPlatformSession · 失败路径都是结构化的", () => {
  it("agent 不属于项目 → assembly 失败,不建会话", async () => {
    removeMember(db, "p1", ids.qa, clock + 1);
    const cap: Capture = { opts: null };
    const r = await createPlatformSession(deps, ids.qa, "p1", { ...OPTS, createSession: fakeSdk(cap) });
    expect(r).toMatchObject({ ok: false, reason: "assembly" });
    if (r.ok) return;
    expect(r.detail).toContain("agent_not_assigned");
    expect(cap.opts, "失败时不该建会话").toBeNull();
  });

  it("项目不存在 → assembly 失败", async () => {
    const r = await createPlatformSession(deps, ids.wk, "ghost", { ...OPTS, createSession: fakeSdk({ opts: null }) });
    expect(r).toMatchObject({ ok: false, reason: "assembly" });
  });

  it("agent 不存在 → assembly 失败", async () => {
    const r = await createPlatformSession(deps, "ghost", "p1", { ...OPTS, createSession: fakeSdk({ opts: null }) });
    expect(r).toMatchObject({ ok: false, reason: "assembly" });
  });
});

describe("splitToolset · 分道的单元契约", () => {
  it("把 SDK 内置与平台工具分开", () => {
    const s = splitToolset(["read", "bash", "board_write", "memory_search"]);
    expect(s.builtinAllowlist.sort()).toEqual(["bash", "read"]);
    expect(s.platformTools.map((t) => t.name).sort()).toEqual(["board_write", "memory_search"]);
    expect(s.unplaceable).toEqual([]);
  });

  it("**放不进任何通道的工具被如实报出** —— 那是 8-A 的形态", () => {
    // 现实中不该发生(solveToolset 只产出闭合集里的名字),但守卫要能拦住
    const s = splitToolset(["read", "nonexistent_tool"]);
    expect(s.unplaceable).toEqual(["nonexistent_tool"]);
  });

  it("每个角色的工具面都能被完整分道", async () => {
    for (const key of ["bm", "pm", "wk", "qa"] as const) {
      const r = planAgentSession(deps, ids[key]!, "p1");
      if (!r.ok) throw new Error(r.detail);
      const s = splitToolset(r.plan.tools);
      expect(s.unplaceable, `${key} 有放不进去的工具`).toEqual([]);
    }
  });
});

describe("会话级门控随项目状态变化", () => {
  it("项目暂停 → 项目内工具不进通道,记忆与代码工具仍在", async () => {
    updateProject(db, "p1", { status: "paused" });
    const cap: Capture = { opts: null };
    const r = await createPlatformSession(deps, ids.wk, "p1", { ...OPTS, createSession: fakeSdk(cap) });
    if (!r.ok) throw new Error(r.detail);

    expect(r.wiring.customToolNames).not.toContain("board_write");
    // 项目无关的两族仍在
    expect(r.wiring.customToolNames).toContain("memory_search");
    expect(r.wiring.allowlist).toContain("bash");
    expect(r.plan.blockedByScope.length).toBeGreaterThan(0);
  });

  it("项目已关闭 → 项目内工具全部退出", async () => {
    closeProject(db, "p1", "done", clock + 1);
    const r = await createPlatformSession(deps, ids.pm, "p1", { ...OPTS, createSession: fakeSdk({ opts: null }) });
    if (!r.ok) throw new Error(r.detail);
    expect(r.wiring.customToolNames).toContain("memory_search");
    expect(r.wiring.customToolNames).not.toContain("work_create");
  });

  it("越权的集合文件条目被挡下并如实记录", async () => {
    const cap: Capture = { opts: null };
    const r = await createPlatformSession(
      { ...deps, toolSetFor: () => ({ allow: ["tell_client", "board_write"], deny: [] }) },
      ids.wk, "p1", { ...OPTS, createSession: fakeSdk(cap) },
    );
    if (!r.ok) throw new Error(r.detail);
    expect(r.wiring.customToolNames).toEqual(["board_write"]);
    expect(r.plan.blockedByCeiling).toContain("tell_client");
  });
});

describe("不变式 · 交出去的工具必须都有实现", () => {
  it("四个角色的 customTools 全都在注册表里", async () => {
    for (const key of ["bm", "pm", "wk", "qa"] as const) {
      const cap: Capture = { opts: null };
      const r = await createPlatformSession(deps, ids[key]!, "p1", { ...OPTS, createSession: fakeSdk(cap) });
      if (!r.ok) throw new Error(r.detail);
      for (const name of r.wiring.customToolNames) {
        expect(TOOL_INDEX.has(name as never), `${key}:交出去的 ${name} 不在注册表里`).toBe(true);
      }
    }
  });

  it("交出去的 allowlist 全是 SDK 内置(SDK 认不出别的名字)", async () => {
    const SDK_BUILTINS = new Set(["read", "grep", "find", "ls", "edit", "write", "bash", "powershell"]);
    for (const key of ["bm", "pm", "wk", "qa"] as const) {
      const r = await createPlatformSession(deps, ids[key]!, "p1", { ...OPTS, createSession: fakeSdk({ opts: null }) });
      if (!r.ok) throw new Error(r.detail);
      for (const name of r.wiring.allowlist) {
        expect(SDK_BUILTINS.has(name), `${key}:allowlist 里的 ${name} 不是 SDK 内置工具`).toBe(true);
      }
    }
  });
});
