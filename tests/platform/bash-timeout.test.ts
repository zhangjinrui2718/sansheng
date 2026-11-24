/**
 * 内置 `bash` 的默认超时与封顶(2026-11-25)· 回归
 *
 * ── 这个机制补的是什么 ──────────────────────────────────────────
 *
 * SDK 的 `bash` 工具没有默认超时(模型不给 `timeout` 就能一直跑),而 SDK 没有
 * 「只停这一次工具调用」的入口 —— 平台能做的只有整回合 `abort()`。
 * 现在给 `bash` 包一层:没给就补上单工具窗口,给了就封顶;到点由 SDK 自己
 * 杀掉这条命令并把超时作为**工具结果**交还模型,回合不用整个作废。
 *
 * ── 钉住的三件事 ────────────────────────────────────────────────
 *
 *   ① 判据(两个纯函数):这次调用实际生效多少秒、给模型看的说明;
 *   ② 包装:底层 `execute` 收到的 `timeout` 确实被补上 / 封顶,工具名与参数 schema 不变;
 *   ③ 接线:拿得到 `bash` 的角色才有包装、窗口与看门狗第二道闸是同一个数、
 *      `customToolNames` 仍只报平台工具(不把一个内置名字混进「平台实现了哪些工具」)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember } from "../../src/platform/storage/repo/projects.js";
import {
  createPlatformSession, type CreateSessionFn,
} from "../../src/platform/runtime/agentRuntime/pi/session.js";
import {
  bashTimeoutDescription, resolveBashTimeout, withBashTimeout, type BashToolDefinition,
} from "../../src/platform/runtime/agentRuntime/pi/bashTimeout.js";

// ── ① 判据 ──────────────────────────────────────────────────────

describe("resolveBashTimeout · 这次调用实际生效的超时(秒)", () => {
  it("模型没给 ⇒ 单工具窗口(整秒)", () => {
    expect(resolveBashTimeout(undefined, 600_000)).toBe(600);
    expect(resolveBashTimeout(undefined, 90_500)).toBe(90);
  });

  it("模型给了更短的 ⇒ 原样(想更短可以)", () => {
    expect(resolveBashTimeout(30, 600_000)).toBe(30);
  });

  it("模型给了更长的 ⇒ **封顶**到窗口(更长的活放后台跑)", () => {
    expect(resolveBashTimeout(999_999, 600_000)).toBe(600);
  });

  it("坏值(0 / 负数 / NaN)当作没给 ⇒ 窗口", () => {
    expect(resolveBashTimeout(0, 600_000)).toBe(600);
    expect(resolveBashTimeout(-5, 600_000)).toBe(600);
    expect(resolveBashTimeout(Number.NaN, 600_000)).toBe(600);
  });

  it("窗口不足一秒 ⇒ 至少 1 秒(SDK 的 timeout 以秒计,0 会被它当成非法)", () => {
    expect(resolveBashTimeout(undefined, 200)).toBe(1);
  });
});

describe("bashTimeoutDescription · 给模型看的说明", () => {
  it("保留内置说明原文,并补上限与封顶", () => {
    const text = bashTimeoutDescription("Execute a bash command.", 600);
    expect(text.startsWith("Execute a bash command.")).toBe(true);
    expect(text).toContain("600s");
    expect(text).toContain("capped");
  });
});

// ── ② 包装 ──────────────────────────────────────────────────────

/** 一个只记录「底层 execute 收到了什么参数」的假底座(不真的跑命令)。 */
function fakeBase(): {
  base: BashToolDefinition;
  seen: Array<{ command: string; timeout?: number }>;
} {
  const seen: Array<{ command: string; timeout?: number }> = [];
  const base = {
    name: "bash",
    label: "Bash",
    description: "Execute a bash command in the current working directory.",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    executionMode: "parallel",
    execute: async (_id: string, params: { command: string; timeout?: number }) => {
      seen.push(params);
      return { content: [{ type: "text" as const, text: "ok" }], details: {} };
    },
  };
  return { base: base as unknown as BashToolDefinition, seen };
}

const call = (
  t: BashToolDefinition,
  params: { command: string; timeout?: number },
): Promise<unknown> => t.execute("tc1", params, undefined, undefined, {} as never);

describe("withBashTimeout · 底层 execute 收到的 timeout", () => {
  it("模型没给 ⇒ 底层收到窗口秒数(此前是 undefined = 不限时)", async () => {
    const { base, seen } = fakeBase();
    await call(withBashTimeout(base, 600_000), { command: "ls" });
    expect(seen).toEqual([{ command: "ls", timeout: 600 }]);
  });

  it("模型给了更短的 ⇒ 原样;给了更长的 ⇒ 封顶", async () => {
    const { base, seen } = fakeBase();
    const t = withBashTimeout(base, 600_000);
    await call(t, { command: "sleep 1", timeout: 30 });
    await call(t, { command: "npm install", timeout: 99_999 });
    expect(seen.map((p) => p.timeout)).toEqual([30, 600]);
  });

  it("工具名与参数 schema 原样保留 —— 模型看到的仍是那个 `bash`", () => {
    const { base } = fakeBase();
    const t = withBashTimeout(base, 600_000);
    expect(t.name).toBe("bash");
    expect(t.parameters).toEqual(base.parameters);
    expect(t.description).toContain("600s");
  });
});

// ── ③ 接线 ──────────────────────────────────────────────────────

let db: Database.Database;
const ids = { cw: "ag_cw", bm: "ag_bm" };

/** 假 SDK:只记录收到了什么,不建任何真会话。 */
function fakeSdk(cap: { opts: Parameters<CreateSessionFn>[0] | null }): CreateSessionFn {
  return async (opts) => {
    cap.opts = opts;
    return { session: { id: "fake-session" } as unknown as AgentSession };
  };
}

beforeEach(() => {
  db = openPlatformMemoryDb();
  insertAgent(db, { id: ids.cw, role: "coding_worker", specialization: null, displayName: "工程师", createdAt: 1 });
  insertAgent(db, { id: ids.bm, role: "business_manager", specialization: null, displayName: "业务经理", createdAt: 1 });
  insertProject(db, { id: "p1", name: "测试", client: "甲", goal: "g", status: "active", createdAt: 1 });
  addMember(db, "p1", ids.cw, 1);
  addMember(db, "p1", ids.bm, 1);
});
afterEach(() => db.close());

const OPTS = { cwd: "/tmp/ws", agentDir: "/tmp/agent" };

describe("createPlatformSession · 内置 bash 的超时接进了会话", () => {
  it("拿得到 bash 的角色(工程师)⇒ 有包装,窗口与传进来的单工具窗口同一个数", async () => {
    const cap: { opts: Parameters<CreateSessionFn>[0] | null } = { opts: null };
    const r = await createPlatformSession(
      { db, now: () => 1, newId: (p) => `${p}_1` }, ids.cw, "p1",
      { ...OPTS, createSession: fakeSdk(cap), toolTimeoutMs: 90_000 },
    );
    if (!r.ok) throw new Error(r.detail);
    expect(r.wiring.bashTimeoutSeconds).toBe(90);
    const wrapped = (cap.opts?.customTools ?? []).find((t) => t.name === "bash");
    expect(wrapped, "包装后的 bash 必须真的交给 SDK(不然模型用的还是没有超时的内置那份)").toBeDefined();
    expect(wrapped!.description).toContain("90s");
    // 名字还在允许清单里 —— 不在的话同名自定义工具不会激活(SDK 的 isAllowedTool 同时过滤两条通道)。
    expect(r.wiring.allowlist).toContain("bash");
  });

  it("缺省窗口 = `turn.ts` 的单工具窗口默认值(10 分钟)", async () => {
    const r = await createPlatformSession(
      { db, now: () => 1, newId: (p) => `${p}_1` }, ids.cw, "p1",
      { ...OPTS, createSession: fakeSdk({ opts: null }) },
    );
    if (!r.ok) throw new Error(r.detail);
    expect(r.wiring.bashTimeoutSeconds).toBe(600);
  });

  it("拿不到 bash 的角色(业务经理没有 code.exec)⇒ 没有包装", async () => {
    const cap: { opts: Parameters<CreateSessionFn>[0] | null } = { opts: null };
    const r = await createPlatformSession(
      { db, now: () => 1, newId: (p) => `${p}_1` }, ids.bm, "p1",
      { ...OPTS, createSession: fakeSdk(cap) },
    );
    if (!r.ok) throw new Error(r.detail);
    expect(r.wiring.bashTimeoutSeconds).toBeNull();
    expect((cap.opts?.customTools ?? []).some((t) => t.name === "bash")).toBe(false);
  });

  it("`customToolNames` 仍只报平台工具 —— 不把内置的 bash 混进「平台实现了哪些工具」", async () => {
    const cap: { opts: Parameters<CreateSessionFn>[0] | null } = { opts: null };
    const r = await createPlatformSession(
      { db, now: () => 1, newId: (p) => `${p}_1` }, ids.cw, "p1",
      { ...OPTS, createSession: fakeSdk(cap) },
    );
    if (!r.ok) throw new Error(r.detail);
    expect(r.wiring.customToolNames).not.toContain("bash");
    // 自检:交给 SDK 的 customTools 里确实比平台工具多一个(bash)—— 上面那条不是因为
    // 「什么都没交」才绿。
    expect((cap.opts?.customTools ?? []).length).toBe(r.wiring.customToolNames.length + 1);
  });
});
