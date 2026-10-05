/**
 * T4 · 用量 HTTP 端点(`GET /api/projects/:id/usage` · `GET /api/intake/usage`)
 *
 * ── 这个文件守的三件事 ──────────────────────────────────────────
 *
 *   ① **窗口 / `limit` 的边界是接口契约的一部分**:坏值取默认、`days` 有上界、
 *      `limit` **只截 `byDay`**。这些不能靠「看代码觉得对」—— 一个 `days=0`
 *      被当成「无上界」的实现会让响应随着历史无限长大,而页面看起来一切正常。
 *   ② **项目隔离**:`/projects/p1/usage` 交出来的数字里**不含** p2 的任何一行。
 *      负样本是「合计 ≠ p1+p2」—— 只断言「p1 的数对得上」抓不到串项目那种错
 *      (两边都是合法数字)。
 *   ③ **接待会话那笔账读得到**(`projectId: null` 是一条**真的**上下文,
 *      不是「没有上下文」)—— 它是产品里第一个花钱的回合。
 *
 * 视图层的两个字段(`agentName` / `role`)也在这里核对:它们是
 * `transport/views.ts` 的职责,而**坏数据(agents 表里没有的 agent_id)必须响亮**
 * 而不是静默回一个像名字的 id。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember } from "../../src/platform/storage/repo/projects.js";
import { insertTurnUsage } from "../../src/platform/storage/repo/usage.js";
import { createPlatformApp, type HttpDeps } from "../../src/platform/transport/http.js";
import type { ProjectUsageResponse } from "@shared/types/platform.js";

const P1 = "p-u1";
const P2 = "p-u2";
const NOW = new Date(2026, 4, 20, 15, 30, 0, 0).getTime();
const DAY = 86_400_000;

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  for (const [id, name] of [[P1, "项目一"], [P2, "项目二"]] as const) {
    insertProject(db, { id, name, client: "甲", goal: "g", status: "active", createdAt: 1 });
  }
  insertAgent(db, { id: "bm", role: "business_manager", specialization: null, displayName: "业务经理", createdAt: 1 });
  insertAgent(db, { id: "pm", role: "project_manager", specialization: null, displayName: "项目经理", createdAt: 1 });
  insertAgent(db, { id: "wk", role: "worker", specialization: "engineering", displayName: "工程师", createdAt: 1 });
  addMember(db, P1, "pm", 1);
  addMember(db, P1, "wk", 1);
  addMember(db, P2, "wk", 1);
});
afterEach(() => db.close());

/** 本地 `dayOffset` 天前、`hour` 点。 */
function at(dayOffset: number, hour = 12): number {
  const d = new Date(NOW);
  d.setHours(0, 0, 0, 0);
  return d.getTime() - dayOffset * DAY + hour * 3_600_000;
}

function put(over: {
  projectId?: string | null;
  agentId?: string;
  createdAt: number;
  input?: number;
  output?: number;
  cacheRead?: number;
}): string {
  seq += 1;
  const id = `tu_${seq}`;
  insertTurnUsage(db, {
    id,
    projectId: over.projectId === undefined ? P1 : over.projectId,
    sessionId: null,
    agentId: over.agentId ?? "wk",
    workId: null,
    model: null,
    inputTokens: over.input ?? 0,
    outputTokens: over.output ?? 0,
    cacheRead: over.cacheRead ?? 0,
    createdAt: over.createdAt,
  });
  return id;
}

function app(): ReturnType<typeof createPlatformApp> {
  const deps: HttpDeps = {
    db,
    dataDir: "/tmp/usage-http-test",
    cwd: "/tmp",
    personaName: "三生",
    version: "test",
    modelId: null,
    provider: null,
    hasAnyProvider: false,
    now: () => NOW,
    newId: (prefix) => `${prefix}_${(seq += 1)}`,
    reset: () => ({ cleared: [], totalRows: 0 }),
    harnessDirs: { dataDir: "/tmp/usage-http-test", factoryDir: "/tmp/usage-http-factory" },
    settings: {
      read: () => ({}),
      write: async () => ({ ok: true as const, settings: {} }),
      providers: () => [],
    },
  };
  return createPlatformApp(deps);
}

async function get(path: string): Promise<{ status: number; body: unknown; text: string }> {
  const res = await app().request(path);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = null; // Hono 的兜底 500 是纯文本("Internal Server Error"),不是 JSON
  }
  return { status: res.status, body, text };
}
async function usage(path: string): Promise<ProjectUsageResponse["usage"]> {
  const r = await get(path);
  expect(r.status, `${path} 应当是 200`).toBe(200);
  return (r.body as ProjectUsageResponse).usage;
}

// ════════════════════════════════════════════════════════════════

describe("GET /api/projects/:id/usage · 正样本", () => {
  it("合计 / 今日 / 按角色 / 按天 四件事都答得出来", async () => {
    put({ agentId: "wk", createdAt: at(0, 9), input: 100, output: 10, cacheRead: 5 });
    put({ agentId: "pm", createdAt: at(0, 10), input: 200, output: 20, cacheRead: 7 });
    put({ agentId: "wk", createdAt: at(3, 9), input: 7, output: 1, cacheRead: 0 });

    const u = await usage(`/api/projects/${P1}/usage?days=7&limit=7`);
    expect(u.projectId).toBe(P1);
    expect(u.window.days).toBe(7);
    expect(u.totals).toEqual({ input: 307, output: 31, cacheRead: 12, turns: 3 });
    expect(u.allTime).toEqual(u.totals); // 窗口外的账一笔都没有 ⇒ 两者相等
    expect(u.today).toEqual({ input: 300, output: 30, cacheRead: 12, turns: 2 });
    expect(u.byAgent.map((b) => [b.agentId, b.agentName, b.role, b.input])).toEqual([
      ["pm", "项目经理", "project_manager", 200],
      ["wk", "工程师", "worker", 107],
    ]);
    expect(u.byDay.map((d) => [d.day, d.input])).toHaveLength(2);
    expect(u.byDayTruncated).toBe(false);
    expect(u.updatedAt).toBe(at(0, 10));
  });

  it("项目一分钱没花 ⇒ 全零 + `updatedAt: null`,**不是** 404", async () => {
    const u = await usage(`/api/projects/${P2}/usage`);
    expect(u.totals).toEqual({ input: 0, output: 0, cacheRead: 0, turns: 0 });
    expect(u.byAgent).toEqual([]);
    expect(u.byDay).toEqual([]);
    expect(u.updatedAt).toBeNull();
  });

  it("项目不存在 ⇒ 404 `not_found`(与「没花过钱」是两件事)", async () => {
    const r = await get(`/api/projects/p_不存在/usage`);
    expect(r.status).toBe(404);
    expect((r.body as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("★ `allTime` **不受窗口影响**:窗口外的账不在 totals 里,但在 allTime 里", async () => {
    put({ agentId: "wk", createdAt: at(0, 9), input: 10 });
    put({ agentId: "wk", createdAt: at(200, 9), input: 999 });
    const u = await usage(`/api/projects/${P1}/usage?days=7`);
    expect(u.totals.input).toBe(10);
    expect(u.allTime.input).toBe(1009);
  });
});

describe("GET /api/projects/:id/usage · 边界(坏值取默认 / 有上界)", () => {
  it("`days` 默认 7、上界 365;`0` / 垃圾值 / 超大值都不许变成「无上界」", async () => {
    expect((await usage(`/api/projects/${P1}/usage`)).window.days).toBe(7);
    expect((await usage(`/api/projects/${P1}/usage?days=`)).window.days).toBe(7);
    expect((await usage(`/api/projects/${P1}/usage?days=abc`)).window.days).toBe(7);
    expect((await usage(`/api/projects/${P1}/usage?days=0`)).window.days).toBe(7);
    expect((await usage(`/api/projects/${P1}/usage?days=-3`)).window.days).toBe(7);
    expect((await usage(`/api/projects/${P1}/usage?days=999999`)).window.days).toBe(365);
    expect((await usage(`/api/projects/${P1}/usage?days=1`)).window.days).toBe(1);
  });

  it("★ `limit` 只截 `byDay`:合计一个数都不变,且 `byDayTruncated` 如实报出", async () => {
    for (let d = 0; d < 5; d++) put({ agentId: "wk", createdAt: at(d, 9), input: d + 1 });
    const full = await usage(`/api/projects/${P1}/usage?days=7&limit=7`);
    const short = await usage(`/api/projects/${P1}/usage?days=7&limit=2`);
    expect(full.byDay).toHaveLength(5);
    expect(short.byDay).toHaveLength(2);
    expect(short.totals).toEqual(full.totals); // ← 截的是展示,不是账
    expect(short.allTime).toEqual(full.allTime);
    expect(short.byAgent).toEqual(full.byAgent);
    expect(short.byDayTruncated).toBe(true);
    expect(full.byDayTruncated).toBe(false);
    // 留下来的必须是**最近**两天(升序交回:昨天=2,今天=1)
    expect(short.byDay.map((d) => d.input)).toEqual([2, 1]);
  });

  it("`limit` 也给默认(缺省 = `days`),垃圾值不会截成 0 天", async () => {
    put({ agentId: "wk", createdAt: at(0, 9), input: 1 });
    for (const q of ["", "?limit=", "?limit=abc", "?limit=0", "?limit=-5"]) {
      const u = await usage(`/api/projects/${P1}/usage${q}`);
      expect(u.byDay, `「${q}」不该把 byDay 截空`).toHaveLength(1);
      expect(u.totals.turns).toBe(1);
    }
  });
});

describe("GET /api/projects/:id/usage · ★ 项目隔离", () => {
  it("p1 的数字里**不含** p2 的任何一行(负样本:合计 ≠ p1+p2)", async () => {
    put({ projectId: P1, agentId: "wk", createdAt: at(0, 9), input: 111, output: 11, cacheRead: 1 });
    put({ projectId: P2, agentId: "wk", createdAt: at(0, 9), input: 222, output: 22, cacheRead: 2 });
    put({ projectId: null, agentId: "bm", createdAt: at(0, 9), input: 444, output: 44, cacheRead: 4 });

    const a = await usage(`/api/projects/${P1}/usage`);
    const b = await usage(`/api/projects/${P2}/usage`);
    expect(a.totals).toEqual({ input: 111, output: 11, cacheRead: 1, turns: 1 });
    expect(b.totals).toEqual({ input: 222, output: 22, cacheRead: 2, turns: 1 });
    // 负样本:串项目(或把接待会话算进来)会让合计变成 777 —— 这里必须不是
    expect(a.totals.input).not.toBe(111 + 222);
    expect(a.totals.input).not.toBe(111 + 222 + 444);
    expect(a.allTime.input).toBe(111);
    expect(a.byAgent.map((x) => x.agentId)).toEqual(["wk"]);
  });
});

describe("GET /api/intake/usage · 接待会话那笔账", () => {
  it("★ `project_id IS NULL` 的那行读得到,`projectId` 为 null(**不是** 404)", async () => {
    put({ projectId: null, agentId: "bm", createdAt: at(0, 9), input: 10063, output: 133, cacheRead: 128 });
    const u = await usage(`/api/intake/usage`);
    expect(u.projectId).toBeNull();
    expect(u.totals).toEqual({ input: 10063, output: 133, cacheRead: 128, turns: 1 });
    expect(u.byAgent[0]).toMatchObject({ agentId: "bm", role: "business_manager" });
  });

  it("没有接待会话时返回全零(与 `/intake/messages` 同一条理由:首屏不该是一次错误)", async () => {
    const u = await usage(`/api/intake/usage`);
    expect(u.projectId).toBeNull();
    expect(u.totals.turns).toBe(0);
    expect(u.updatedAt).toBeNull();
  });

  it("接待会话的账**不会**出现在任何项目下(反向隔离)", async () => {
    put({ projectId: null, agentId: "bm", createdAt: at(0, 9), input: 555 });
    const u = await usage(`/api/projects/${P1}/usage`);
    expect(u.totals.turns).toBe(0);
    expect(u.allTime.turns).toBe(0);
  });
});

describe("用量视图的解析纪律 · 坏数据必须响亮", () => {
  it("★ agents 表里没有的 agent_id ⇒ 500(不静默回一个像名字的 id)", async () => {
    // Hono 会把未捕获的错误写到 console.error —— **把它当现场读**,而不是让它
    // 当噪音:错误文本里必须指出是哪个 agent_id(否则排查只能靠猜)。
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // 外键本该拦住它 —— 这里显式关掉外键,模拟「有人绕过外键写进来的坏数据」
      db.pragma("foreign_keys = OFF");
      put({ agentId: "ag_幽灵", createdAt: at(0, 9), input: 1 });
      db.pragma("foreign_keys = ON");

      const r = await get(`/api/projects/${P1}/usage`);
      expect(r.status, "账上出现了一个不存在的人 —— 这必须响亮,不能静默").toBe(500);
      const logged = spy.mock.calls.map((c) => String(c.join(" "))).join("\n");
      expect(logged).toContain("ag_幽灵");

      // 而**同一个项目**的合法数据单独读也没问题(证明上面红的是那一条坏行,不是接口坏了)
      db.prepare(`DELETE FROM turn_usage WHERE agent_id = ?`).run("ag_幽灵");
      expect((await get(`/api/projects/${P1}/usage`)).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});
