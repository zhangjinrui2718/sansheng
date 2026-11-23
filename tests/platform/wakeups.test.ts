/**
 * 结构化唤醒(038,2026-11-22)· 回归 —— 到点叫醒、错过折叠、预算闸、熔断
 *
 * ── 判据铁律(与批次 21 同一条)────────────────────────────────────
 *
 * 唤醒只是「到点 ⇒ `wakeup_due` 待办」,判定每次重查库;消费(at → done /
 * every → last_fired_at 续期)在回合成功结束之后。保险丝三条全部有判据:
 * 错过折叠(every 超期 N 倍也只有一条待办)、预算闸(key 稳定 + targetState =
 * 续期锚)、熔断(cancelExhaustedWakeups 读账本的 notified_at)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import {
  insertWakeup, getWakeup, dueWakeups, markWakeupFired, cancelWakeup,
  cancelExhaustedWakeups,
} from "../../src/platform/storage/repo/wakeups.js";
import { bumpAttempt, markAttemptNotified } from "../../src/platform/storage/repo/dispatch.js";
import { collectTodos, drainProject, renderTask, type DrainTurnReport } from "../../src/platform/runtime/dispatcher.js";
import { dispatch } from "../../src/platform/tools/registry.js";
import { createGitWorkspace } from "../../src/platform/workspace/git.js";
import { loadProjectForAuthz } from "../../src/platform/storage/repo/projects.js";
import { getAgent } from "../../src/platform/storage/repo/agents.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";

let db: Database.Database;
let workRoot: string;
const T0 = 1_700_000_000_000;
const MIN = 60_000;

beforeEach(() => {
  db = openPlatformMemoryDb();
  workRoot = mkdtempSync(join(tmpdir(), "ss-wu-"));
  insertProject(db, {
    id: "p1", name: "唤醒测试", client: "甲方", goal: "g", status: "active", createdAt: T0,
  });
  ensureProjectOrg(db, "p1", T0);
});
afterEach(() => {
  db.close();
  rmSync(workRoot, { recursive: true, force: true });
});

function mkWakeup(over: {
  id?: string; kind?: "at" | "every"; at?: number | null; intervalMs?: number | null;
  lastFiredAt?: number | null;
} = {}): string {
  const id = over.id ?? "wu_1";
  insertWakeup(db, {
    id, projectId: "p1", createdByAgentId: "bm",
    note: over.id === "wu_note" ? "查一下 W3 的进度并向我汇报" : "例行自查",
    kind: over.kind ?? "at",
    at: over.at !== undefined ? over.at : (over.kind ?? "at") === "at" ? T0 - 1 : null,
    intervalMs: over.intervalMs !== undefined ? over.intervalMs : over.kind === "every" ? 10 * MIN : null,
    status: "pending",
    lastFiredAt: over.lastFiredAt !== undefined ? over.lastFiredAt : null,
    firedCount: 0, createdAt: T0,
  });
  return id;
}

// ── ① 到期谓词(纯函数)──────────────────────────────────────────

describe("wakeups · 到期谓词与消费", () => {
  it("at:到点到期;点火 ⇒ done(一次性);every:锚点续期", () => {
    mkWakeup({ id: "wu_at", kind: "at", at: T0 - 1 });
    mkWakeup({ id: "wu_future", kind: "at", at: T0 + 60 * MIN });
    // 上次点火在 15 分钟前、周期 10 分钟 ⇒ 已超期 5 分钟,该叫了。
    mkWakeup({ id: "wu_ev", kind: "every", intervalMs: 10 * MIN, lastFiredAt: T0 - 15 * MIN });
    const due = dueWakeups(db, "p1", T0);
    expect(due.map((w) => w.id).sort()).toEqual(["wu_at", "wu_ev"]);

    markWakeupFired(db, "wu_at", T0 + 1);
    expect(getWakeup(db, "wu_at")!.status).toBe("done");
    markWakeupFired(db, "wu_ev", T0 + 1);
    expect(getWakeup(db, "wu_ev")!.status).toBe("pending"); // 周期性不终态
    expect(getWakeup(db, "wu_ev")!.lastFiredAt).toBe(T0 + 1);
    // 续期后未到下一个周期 ⇒ 不再到期;**边界两侧各钉一格**
    //(差一分钟不算到,满周期才算到 —— 判据漂到 interval/2 那种要当场红)。
    expect(dueWakeups(db, "p1", T0 + 2).map((w) => w.id)).toEqual([]);
    expect(dueWakeups(db, "p1", T0 + 1 + 10 * MIN - 1).map((w) => w.id)).toEqual([]);
    expect(dueWakeups(db, "p1", T0 + 1 + 10 * MIN).map((w) => w.id)).toEqual(["wu_ev"]);
  });

  it("错过折叠:every 超期 5 倍也只有一条待办(不按错过次数放大)", () => {
    mkWakeup({ id: "wu_late", kind: "every", intervalMs: 10 * MIN, lastFiredAt: T0 - 50 * MIN });
    const board = collectTodos({ db, projectId: "p1", now: T0 });
    expect(board.runnable.filter((t) => t.kind === "wakeup_due")).toHaveLength(1);
  });

  it("cancel 是终态:不再到期", () => {
    mkWakeup({ id: "wu_c", kind: "at", at: T0 - 1 });
    expect(cancelWakeup(db, "wu_c")).toBe(true);
    expect(dueWakeups(db, "p1", T0)).toEqual([]);
  });
});

// ── ② 规则与消费 ────────────────────────────────────────────────

describe("wakeups · 规则(wakeup_due)与任务正文", () => {
  it("到点 ⇒ 业务经理的 wakeup_due 待办,targetState = 续期锚;note 原样进正文", () => {
    mkWakeup({ id: "wu_note", kind: "at", at: T0 - 1 });
    const board = collectTodos({ db, projectId: "p1", now: T0 });
    const todo = board.runnable.find((t) => t.kind === "wakeup_due");
    expect(todo).toBeDefined();
    expect(todo!.key).toBe("wakeup_due:wu_note");
    expect(todo!.targetState).toBe(T0); // last_fired_at ?? created_at
    // note 原样带回 —— 模型没有别的地方能读到它。
    expect(renderTask(db, todo!)).toContain("查一下 W3 的进度并向我汇报");
  });

  it("回合成功 ⇒ 点火(at → done);失败不点,预算照烧", async () => {
    mkWakeup({ id: "wu_ok", kind: "at", at: T0 - 1 });
    const ok: DrainTurnReport = { aborted: false, timedOut: false, text: "查完了", toolCalls: [] };
    await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {},
      runAgentTurn: async () => ok,
      runWork: async () => { throw new Error("无工作项"); },
    });
    expect(getWakeup(db, "wu_ok")!.status).toBe("done");

    // 失败路径:回合 failed ⇒ 不点火、预算烧完。
    mkWakeup({ id: "wu_bad", kind: "at", at: T0 - 1 });
    await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {},
      runAgentTurn: async () => ({ ...ok, failed: true }),
      runWork: async () => { throw new Error("无工作项"); },
    });
    expect(getWakeup(db, "wu_bad")!.status).toBe("pending");
  });
});

// ── ③ 熔断(⑤)─────────────────────────────────────────────────

describe("wakeups · 熔断(cancelExhaustedWakeups)", () => {
  it("预算烧穿(notified_at 非空)的 pending 唤醒被自动取消;没烧穿的不动", () => {
    mkWakeup({ id: "wu_dead", kind: "at", at: T0 - 1 });
    mkWakeup({ id: "wu_alive", kind: "at", at: T0 - 1 });
    // wu_alive 也有账本行 —— 但只叫过一次、没到顶、没播报过。
    // (没有这一行的话,「熔断不看 notified_at」这类变异根本无从咬合:它没有行可看。)
    bumpAttempt(db, { projectId: "p1", todoKey: "wakeup_due:wu_alive", targetState: T0, at: T0 });
    // 手工把 wu_dead 的账本推到「叫到顶并播报过」。
    for (let i = 0; i < 3; i++) {
      bumpAttempt(db, { projectId: "p1", todoKey: "wakeup_due:wu_dead", targetState: T0, at: T0 + i });
    }
    markAttemptNotified(db, "p1", "wakeup_due:wu_dead", T0 + 3);

    const cancelled = cancelExhaustedWakeups(db, "p1");
    expect(cancelled.map((w) => w.id)).toEqual(["wu_dead"]);
    expect(getWakeup(db, "wu_dead")!.status).toBe("cancelled");
    expect(getWakeup(db, "wu_alive")!.status).toBe("pending");
    // 幂等:再扫一遍没有新命中。
    expect(cancelExhaustedWakeups(db, "p1")).toEqual([]);
  });
});

// ── ④ 工具层(wakeup_create / wakeup_cancel)─────────────────────

let seq = 0;
function bmCtx(): ToolRunContext {
  const agent = getAgent(db, "bm")!;
  return {
    db, agent, project: loadProjectForAuthz(db, "p1")!,
    now: () => T0 + 100, newId: (p) => `${p}_${++seq}`,
    workspace: createGitWorkspace(), workspaceRoot: workRoot,
  };
}
function call(tool: string, args: Record<string, unknown>): ToolResult {
  const r = dispatch(tool, args, bmCtx());
  if (r instanceof Promise) throw new Error("sync only");
  return r;
}

describe("wakeups · 工具层", () => {
  it("create:at/every 各自的形状校验与拒收;过期 at 拒收(排过去的闹钟没有意义)", () => {
    const okAt = call("wakeup_create", {
      projectId: "p1", note: "两小时后查进度", kind: "at", atMs: T0 + 100 + 2 * 60 * MIN,
    });
    expect(okAt.ok, okAt.ok ? "" : okAt.message).toBe(true);

    const okEv = call("wakeup_create", {
      projectId: "p1", note: "每天早报", kind: "every", intervalMs: 24 * 60 * MIN,
    });
    expect(okEv.ok).toBe(true);

    const badKind = call("wakeup_create", { projectId: "p1", note: "n", kind: "cron" });
    expect(badKind.ok).toBe(false);
    const badPair = call("wakeup_create", { projectId: "p1", note: "n", kind: "at" });
    expect(badPair.ok).toBe(false);
    const past = call("wakeup_create", {
      projectId: "p1", note: "n", kind: "at", atMs: T0,
    });
    expect(past.ok).toBe(false);
    const tooDense = call("wakeup_create", {
      projectId: "p1", note: "n", kind: "every", intervalMs: 30_000,
    });
    expect(tooDense.ok, "密周期 = 热循环,熔断在入口拦").toBe(false);
  });

  it("cancel:pending 可取消;终态再取消被拒(不是静默成功)", () => {
    mkWakeup({ id: "wu_x", kind: "at", at: T0 + 60 * MIN });
    const r = call("wakeup_cancel", { wakeupId: "wu_x" });
    expect(r.ok).toBe(true);
    const again = call("wakeup_cancel", { wakeupId: "wu_x" });
    expect(again.ok).toBe(false);
  });
});
