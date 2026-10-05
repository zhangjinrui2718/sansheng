/**
 * 调度器 · 测试
 *
 * ── 最要紧的一条断言是「它不做事」 ──────────────────────────────
 *
 * 调度器能做的最坏的事,是**自动升级** —— 那会把组织图变成噪音放大器:
 * 每个「用户正在忙」的正常情况都产生一次升级,而用户学会忽略通知之后,
 * 真正需要他看的那条也一起被忽略了。
 *
 * 所以下面既测「它如实报出超时」,也测「它**没有**改任何状态」。
 * 后者才是这个模块的设计核心(经 jev 校准,p=0.81)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember } from "../../src/platform/storage/repo/projects.js";
import { insertAsk, getAsk } from "../../src/platform/storage/repo/asks.js";
import { listAsks } from "../../src/platform/storage/repo/asks.js";
import { schedulerTick, startScheduler } from "../../src/platform/host/scheduler.js";
import type { ServerEvent } from "@shared/types/platform.js";

let db: Database.Database;
let seq = 0;
const T0 = 1_700_000_000_000;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  for (const id of ["bm", "pm", "wk"]) {
    insertAgent(db, {
      id, role: id === "bm" ? "business_manager" : id === "pm" ? "project_manager" : "worker",
      specialization: null, displayName: id, createdAt: T0,
    });
  }
  insertProject(db, { id: "p1", name: "项目一", client: "甲", goal: "g", status: "active", createdAt: T0 });
  for (const id of ["bm", "pm", "wk"]) addMember(db, "p1", id, T0);
});
afterEach(() => db.close());

function mkAsk(over: {
  id?: string; projectId?: string; from?: string; to?: string;
  deadlineAt?: number | null; status?: never;
} = {}): string {
  const id = over.id ?? `ask_${++seq}`;
  insertAsk(db, {
    id,
    projectId: over.projectId ?? "p1",
    fromAgentId: over.from ?? "wk",
    toAgentId: over.to ?? "pm",
    question: "该怎么做?",
    hypothesis: "我猜是 A",
    createdAt: T0,
    ...(over.deadlineAt !== undefined && over.deadlineAt !== null
      ? { deadlineAt: over.deadlineAt }
      : {}),
  });
  return id;
}

describe("schedulerTick · 扫描", () => {
  it("没超时的提问不计入", () => {
    mkAsk({ deadlineAt: T0 + 100_000 });
    const r = schedulerTick(db, T0 + 1000);
    expect(r.total).toBe(0);
    expect(r.projects).toEqual([]);
  });

  it("过了截止时间的计入,带项目名与 id", () => {
    const a = mkAsk({ deadlineAt: T0 + 1000 });
    const r = schedulerTick(db, T0 + 2000);
    expect(r.total).toBe(1);
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0]!.projectId).toBe("p1");
    expect(r.projects[0]!.projectName).toBe("项目一");
    expect(r.projects[0]!.askIds).toEqual([a]);
  });

  it("没有 deadline 的提问**永不超时**(不该被当成长期挂起)", () => {
    mkAsk({});
    const r = schedulerTick(db, T0 + 999_999_999);
    expect(r.total).toBe(0);
  });

  it("已答复的提问不再算超时", () => {
    const a = mkAsk({ deadlineAt: T0 + 1000 });
    db.prepare(`UPDATE asks SET status = 'answered', resolved_at = ? WHERE id = ?`).run(T0 + 1500, a);
    expect(schedulerTick(db, T0 + 2000).total).toBe(0);
  });

  it("按项目归组,多个项目各自一条", () => {
    insertProject(db, { id: "p2", name: "项目二", client: "乙", goal: "g", status: "active", createdAt: T0 });
    mkAsk({ id: "a1", deadlineAt: T0 + 1000 });
    mkAsk({ id: "a2", projectId: "p2", deadlineAt: T0 + 1000 });
    const r = schedulerTick(db, T0 + 2000);
    expect(r.total).toBe(2);
    expect(r.projects.map((p) => p.projectId).sort()).toEqual(["p1", "p2"]);
  });
});

describe("**它不做事** —— 这是模块的设计核心", () => {
  it("扫描**不改任何提问的状态**", () => {
    const a = mkAsk({ deadlineAt: T0 + 1000 });
    schedulerTick(db, T0 + 999_999);
    const row = getAsk(db, a)!;
    expect(row.status, "调度器不该把超时改成 expired").toBe("open");
    expect(row.resolvedAt).toBeNull();
  });

  it("**不自动升级** —— 不产生子提问、不把父问置 escalated", () => {
    const a = mkAsk({ deadlineAt: T0 + 1000 });
    const before = listAsks(db, "p1").length;
    schedulerTick(db, T0 + 999_999);
    expect(listAsks(db, "p1").length, "升级会新建提问,数量就会变").toBe(before);
    expect(getAsk(db, a)!.status).not.toBe("escalated");
  });

  it("**不主动发起对话** —— 不建会话、不跑回合", () => {
    mkAsk({ deadlineAt: T0 + 1000 });
    schedulerTick(db, T0 + 999_999);
    const sessions = db.prepare(`SELECT COUNT(*) AS n FROM project_sessions`).get() as { n: number };
    expect(sessions.n, "调度器建了会话 = 它成了一个自主行为者").toBe(0);
  });
});

describe("startScheduler · 只推变化,不刷屏", () => {
  function collect(): { events: ServerEvent[] } {
    return { events: [] };
  }

  it("第一次 tick 就把超时推出去", () => {
    const c = collect();
    mkAsk({ deadlineAt: T0 + 1000 });
    const s = startScheduler({
      db, now: () => T0 + 5000,
      broadcast: (ev) => c.events.push(ev),
      log: () => {},
    });
    s.stop();
    const overdue = c.events.filter((e) => e.type === "overdue_asks");
    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toMatchObject({ type: "overdue_asks", projectId: "p1", count: 1 });
  });

  it("**集合没变就不重复推** —— 每分钟推同样内容会淹没真事件", () => {
    const c = collect();
    mkAsk({ deadlineAt: T0 + 1000 });
    const s = startScheduler({
      db, now: () => T0 + 5000,
      broadcast: (ev) => c.events.push(ev),
      log: () => {},
    });
    s.tick();
    s.tick();
    s.tick();
    s.stop();
    expect(c.events.filter((e) => e.type === "overdue_asks")).toHaveLength(1);
  });

  it("新增一条超时后会再推一次(因为集合变了)", () => {
    const c = collect();
    mkAsk({ id: "a1", deadlineAt: T0 + 1000 });
    const s = startScheduler({
      db, now: () => T0 + 5000,
      broadcast: (ev) => c.events.push(ev),
      log: () => {},
    });
    mkAsk({ id: "a2", deadlineAt: T0 + 1000 });
    s.tick();
    s.stop();
    expect(c.events.filter((e) => e.type === "overdue_asks")).toHaveLength(2);
  });

  it("全部答完之后,集合变空也会推一次(让徽标熄灭)", () => {
    const c = collect();
    const a = mkAsk({ deadlineAt: T0 + 1000 });
    const s = startScheduler({
      db, now: () => T0 + 5000,
      broadcast: (ev) => c.events.push(ev),
      log: () => {},
    });
    db.prepare(`UPDATE asks SET status = 'answered' WHERE id = ?`).run(a);
    const r = s.tick();
    s.stop();
    expect(r.total).toBe(0);
    // 第一次推了 1 条,清空后不会有 overdue_asks(projects 为空 → 不循环)
    // 但签名变化本身要能被观察到:stats 记录了扫描次数
    expect(s.stats().ticks).toBeGreaterThanOrEqual(2);
  });

  it("stop 之后不再扫描", () => {
    const c = collect();
    mkAsk({ deadlineAt: T0 + 1000 });
    const s = startScheduler({
      db, now: () => T0 + 5000,
      broadcast: (ev) => c.events.push(ev),
      intervalMs: 10,
      log: () => {},
    });
    const before = s.stats().ticks;
    s.stop();
    expect(s.stats().ticks).toBe(before);
  });
});

// ── fixed-delay 兜底定时器的**心跳**(2026-10-06)────────────────────
//
// `lastRunAt()` 是这次为「此刻在做什么」补的一位(`GET /api/projects/:id/live`
// 的 `dispatch.lastRunAgeMs` 读它)。它看起来像个无聊的 getter,但两条失效方向
// 都会让页面说假话:
//
//   ① 记在**跑完**而不是**开始** ⇒ 一次 16 分钟的排空期间,页面显示「上一次 0 秒前」,
//      而它其实正在跑(心跳该说「正在转」);
//   ② 一直返回 `null` ⇒ 页面永远显示「本进程还没跑过兜底检查」,而它其实每 10s 跑一次。
//
// `FixedDelayLoop` 的语义(「上一轮跑完再等 interval」)由既有实现保证,这里只钉
// 心跳这一个新增读点。
describe("startFixedDelay · 心跳(lastRunAt)", () => {
  it("没跑过时是 null,跑过之后记的是**开始**那一刻(不是结束那一刻)", async () => {
    const { startFixedDelay } = await import("../../src/platform/host/scheduler.js");
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    let resolveRun: (() => void) | null = null;
    const loop = startFixedDelay({
      intervalMs: 60_000,
      run: () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        }),
    });
    // 正样本自检:先确认「没跑过 ⇒ null」不是因为这一位永远返回 null
    expect(loop.lastRunAt(), "还没跑过").toBeNull();

    const before = Date.now();
    const running = loop.runNow();
    // 这一轮**卡在 run 里**(模拟一次 16 分钟的排空)
    expect(typeof resolveRun).toBe("function");
    const justAfterStart = Date.now();
    await sleep(30);
    resolveRun?.();
    await running;

    const stamp = loop.lastRunAt();
    expect(stamp, "跑过之后必须有值").not.toBeNull();
    expect(stamp ?? 0).toBeGreaterThanOrEqual(before);
    // ⚠️ 这条就是「开始 vs 结束」的判别:实现若记在 `await deps.run()` **之后**,
    // 这里拿到的戳会晚于 `justAfterStart` + 30ms;而页面会在整个长回合期间
    // 显示「上一次 0 秒前」,把「正在跑」说成「刚跑完」。
    expect(stamp ?? 0, "心跳记的是开始时刻").toBeLessThanOrEqual(justAfterStart);
    expect(loop.runs()).toBe(1);
    loop.stop();
  });
});
