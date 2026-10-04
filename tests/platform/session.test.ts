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
import { classifyToolset } from "../../src/platform/runtime/sdkAdapter.js";
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

    // 统一 allowlist 必须等于求解结果
    expect([...r.wiring.allowlist].sort()).toEqual([...r.plan.tools].sort());
    // 与真正交给 SDK 的东西一致(不是我们自己算的另一份)
    expect([...(cap.opts?.tools ?? [])].sort()).toEqual([...r.plan.tools].sort());
  });

  it("**allowlist 是统一名单**(只放内置会把 customTools 一起关掉)", async () => {
    const cap: Capture = { opts: null };
    const r = await createPlatformSession(deps, ids.wk, "p1", { ...OPTS, createSession: fakeSdk(cap) });
    if (!r.ok) throw new Error(r.detail);

    // SDK 的 isAllowedTool 对 builtin 与 customTools **同时**过滤:
    //   const isAllowedTool = (name) => (!allowedToolNames || allowedToolNames.has(name)) && ...
    // 所以 allowlist 必须含平台工具,否则它们被一起关掉 —— 首跑冒烟实测 0 个激活。
    expect(r.wiring.allowlist).toContain("read");
    expect(r.wiring.allowlist).toContain("bash");
    expect(r.wiring.allowlist, "平台工具也必须在 allowlist 里").toContain("board_write");
    // customTools 里的每个名字都必须在 allowlist 里,否则注册了也不会激活
    for (const t of r.wiring.customToolNames) {
      expect(r.wiring.allowlist, `${t} 注册了但不在 allowlist 里 → 不会激活`).toContain(t);
    }
  });

  it("allowlist 与 customTools 的差集正好是 SDK 内置", async () => {
    const r = await createPlatformSession(deps, ids.wk, "p1", { ...OPTS, createSession: fakeSdk({ opts: null }) });
    if (!r.ok) throw new Error(r.detail);
    const custom = new Set(r.wiring.customToolNames);
    const builtinOnly = r.wiring.allowlist.filter((t) => !custom.has(t));
    // worker 的 code.write → edit / write,所以是 7 个而非 6 个
    expect(builtinOnly.sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
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

describe("classifyToolset · 分道的单元契约", () => {
  it("按来源分类,并拼出统一 allowlist", () => {
    const s = classifyToolset(["read", "bash", "board_write", "memory_search"]);
    expect([...s.builtinTools].sort()).toEqual(["bash", "read"]);
    expect(s.platformTools.map((t) => t.name).sort()).toEqual(["board_write", "memory_search"]);
    expect(s.unplaceable).toEqual([]);
    // 统一名单 = 两类全都要(SDK 对 builtin 与 customTools 同时过滤)
    expect([...s.unifiedAllowlist].sort()).toEqual(["bash", "board_write", "memory_search", "read"]);
  });

  it("**放不进任何通道的工具被如实报出** —— 那是 8-A 的形态", () => {
    // 现实中不该发生(solveToolset 只产出闭合集里的名字),但守卫要能拦住
    const s = classifyToolset(["read", "nonexistent_tool"]);
    expect(s.unplaceable).toEqual(["nonexistent_tool"]);
  });

  it("每个角色的工具面都能被完整分道", async () => {
    for (const key of ["bm", "pm", "wk", "qa"] as const) {
      const r = planAgentSession(deps, ids[key]!, "p1");
      if (!r.ok) throw new Error(r.detail);
      const s = classifyToolset(r.plan.tools);
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

  it("**allowlist 里每个平台工具都注册了 customTools**,SDK 内置则不该注册", async () => {
    // 反过来断言的形态:统一 allowlist 里既有内置也有平台,所以不能再说「全是内置」。
    // 真正该守的不变式是「注册了就必须在名单里,反之名单里的非内置必须有注册」——
    // 漏一边就是静默失效(注册了不激活 / 激活了没实现)。
    const SDK_BUILTINS = new Set(["read", "grep", "find", "ls", "edit", "write", "bash", "powershell"]);
    for (const key of ["bm", "pm", "wk", "qa"] as const) {
      const r = await createPlatformSession(deps, ids[key]!, "p1", { ...OPTS, createSession: fakeSdk({ opts: null }) });
      if (!r.ok) throw new Error(r.detail);
      const custom = new Set(r.wiring.customToolNames);
      for (const name of r.wiring.allowlist) {
        if (SDK_BUILTINS.has(name)) {
          expect(custom.has(name), `${key}:${name} 是 SDK 内置,不该注册成 customTool`).toBe(false);
        } else {
          expect(custom.has(name), `${key}:名单里的 ${name} 没有 customTools 实现 → 会静默失效`).toBe(true);
        }
      }
      for (const name of r.wiring.customToolNames) {
        expect(r.wiring.allowlist, `${key}:注册了 ${name} 但不在名单里 → 不会激活`).toContain(name);
      }
    }
  });
});

// ── 接待会话(projectId === null)──────────────────────────────────
//
// 这是本项目补上的架构缺口:第一个项目存在之前,用户**无法**与业务经理对话 ——
// 每条用户消息都要 projectId,而项目还不存在;前端只好摆一张「创建项目」表单。
// 现在有一条 `project_id IS NULL` 的接待会话(见 migrations/012),业务经理在
// 里面与甲方谈诉求,谈拢了由**它**调 project_open 立项。

describe("createPlatformSession · 接待会话(还没有项目)", () => {
  it("工具面只有 project_open + 记忆,项目内工具一个都进不去", async () => {
    const cap: Capture = { opts: null };
    const r = await createPlatformSession(deps, ids.bm, null, { ...OPTS, createSession: fakeSdk(cap) });
    if (!r.ok) throw new Error(r.detail);

    expect(r.plan.project).toBeNull();
    expect([...r.wiring.customToolNames].sort()).toEqual([
      "memory_remember", "memory_search", "project_open",
    ]);
    // 沟通工具必须缺席:client_question 是工件,工件要挂 project_id
    expect(r.wiring.customToolNames).not.toContain("ask_client");
    expect(r.wiring.customToolNames).not.toContain("tell_client");
    // 交给 SDK 的名单与求解结果一致(少给 = 声称有实际没有;多给 = 越权)
    expect([...(cap.opts?.tools ?? [])].sort()).toEqual([...r.plan.tools].sort());
    // 接待模式没有任何 SDK 内置工具(业务经理本来就不持 code.*)
    expect(cap.opts?.tools ?? []).not.toContain("bash");
  });

  it("接待模式不校验项目与成员,只校验 agent 存在", async () => {
    const ok = await createPlatformSession(deps, ids.bm, null, { ...OPTS, createSession: fakeSdk({ opts: null }) });
    expect(ok.ok).toBe(true);

    const missing = await createPlatformSession(deps, "ag_不存在", null, {
      ...OPTS, createSession: fakeSdk({ opts: null }),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok && missing.reason === "assembly") expect(missing.detail).toContain("no_such_agent");
  });

  it("接待模式下花名册为空 —— 还没有项目,没有参与方", async () => {
    const planned = planAgentSession(deps, ids.bm, null);
    if (!planned.ok) throw new Error(planned.detail);
    expect(planned.plan.roster).toEqual([]);
    expect(planned.plan.project).toBeNull();
  });
});
