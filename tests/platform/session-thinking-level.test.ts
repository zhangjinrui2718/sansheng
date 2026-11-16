/**
 * thinkingLevel 接线测试(2026-11-16 · pi 适配器域批次)
 *
 * ── 背景 ────────────────────────────────────────────────────────
 *
 * `settings` 里每个 provider 都有 `thinkingLevel`(`off|minimal|low|medium|high`,
 * `shared/types/settings.ts` 的 `ProviderConfig`),此前**存了但从未传给会话**
 * —— grep 全仓零调用点,正是 7-B 那种「配置落地了但没人读」的死接线。
 *
 * 这组测试钉的是会话工厂这一段:`createPlatformSession` 的
 * `PlatformSessionOptions.thinkingLevel` 必须真的出现在**交给 SDK 的配置里**
 * (经 DI seam 捕获断言,不需要 provider / API key / 网络)。
 *
 * ── SDK 侧证据(pi 1.2.0)─────────────────────────────────────────
 *
 * · `CreateAgentSessionOptions.thinkingLevel?: ThinkingLevel`
 *   (`pi-coding-agent/dist/core/sdk.d.ts`);缺省链 = 恢复会话存档 → 读 pi 的
 *   settings.json → `"medium"`。
 * · SDK 的 `ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`
 *   (`pi-agent-core/dist/types.d.ts`)—— 三生的五值是它的**子集**,原样可赋
 *   (类型层由 tsc 证明,运行时不需要再做映射)。
 * · ⚠️ **`"off"` 必须原样传,不能「不传」**:不传 = 掉进上面的默认链 = medium;
 *   而真 `"off"` 由 SDK 翻译成请求里不带 reasoning
 *   (`pi-agent-core/dist/agent.js`:
 *   `reasoning: thinkingLevel === "off" ? undefined : thinkingLevel`)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember } from "../../src/platform/storage/repo/projects.js";
import { SqliteMemory } from "../../src/platform/memory/sqliteMemory.js";
import { createPlatformSession, type CreateSessionFn } from "../../src/platform/runtime/agentRuntime/pi/session.js";
import type { RuntimeDeps } from "../../src/platform/runtime/assembly.js";
import type { ThinkingLevel } from "../../shared/types/settings.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

let db: Database.Database;
let seq = 0;
const clock = 1_700_000_000_000;
let deps: RuntimeDeps;
let wk: string;

/** 假 SDK:只记录收到了什么,不建任何真会话(session.test.ts 同款)。 */
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
  wk = "ag_wk";
  insertAgent(db, { id: wk, role: "research_worker", specialization: null, displayName: "研究员", createdAt: clock });
  insertProject(db, { id: "p1", name: "测试", client: "甲", goal: "g", status: "active", createdAt: clock });
  addMember(db, "p1", wk, clock);
  deps = {
    db,
    memory: new SqliteMemory(db, { newId: (p) => `${p}_${++seq}`, now: () => clock }),
    now: () => clock,
    newId: (p) => `${p}_${++seq}`,
  };
});
afterEach(() => db.close());

const OPTS = { cwd: "/tmp/ws", agentDir: "/tmp/agent" };

describe("thinkingLevel · 从会话工厂进 SDK 配置", () => {
  it("传 high → 原样出现在交给 SDK 的配置与 wiring 里", async () => {
    const cap: Capture = { opts: null };
    const r = await createPlatformSession(deps, wk, "p1", {
      ...OPTS, thinkingLevel: "high", createSession: fakeSdk(cap),
    });
    expect(r.ok).toBe(true);
    expect(cap.opts?.thinkingLevel).toBe("high");
    if (!r.ok) return;
    expect(r.wiring.thinkingLevel).toBe("high");
  });

  it("**off 必须原样传,不能静默不传**(不传 = SDK 默认链 = medium,那不是关闭)", async () => {
    const cap: Capture = { opts: null };
    const r = await createPlatformSession(deps, wk, "p1", {
      ...OPTS, thinkingLevel: "off", createSession: fakeSdk(cap),
    });
    expect(r.ok).toBe(true);
    expect(cap.opts?.thinkingLevel, "off 是 SDK 的合法值(pi-agent-core 把它翻成请求里不带 reasoning)").toBe("off");
    if (!r.ok) return;
    expect(r.wiring.thinkingLevel).toBe("off");
  });

  it("五档全部透传,不做任何改写(子集类型,tsc 证明可赋)", async () => {
    for (const level of ["off", "minimal", "low", "medium", "high"] as const satisfies readonly ThinkingLevel[]) {
      const cap: Capture = { opts: null };
      const r = await createPlatformSession(deps, wk, "p1", {
        ...OPTS, thinkingLevel: level, createSession: fakeSdk(cap),
      });
      if (!r.ok) throw new Error(r.detail);
      expect(cap.opts?.thinkingLevel, `档位 ${level} 被改写`).toBe(level);
    }
  });

  it("不传 = 交给 SDK 的配置里没有 thinkingLevel(wiring 如实记 undefined)", async () => {
    const cap: Capture = { opts: null };
    const r = await createPlatformSession(deps, wk, "p1", { ...OPTS, createSession: fakeSdk(cap) });
    expect(r.ok).toBe(true);
    expect("thinkingLevel" in (cap.opts ?? {})).toBe(false);
    if (!r.ok) return;
    expect(r.wiring.thinkingLevel).toBeUndefined();
  });

  it("wiring.thinkingLevel 与真正交给 SDK 的是同一个值(不是自己另算的一份)", async () => {
    const cap: Capture = { opts: null };
    const r = await createPlatformSession(deps, wk, "p1", {
      ...OPTS, thinkingLevel: "low", createSession: fakeSdk(cap),
    });
    if (!r.ok) throw new Error(r.detail);
    expect(r.wiring.thinkingLevel).toBe(cap.opts?.thinkingLevel);
  });
});
