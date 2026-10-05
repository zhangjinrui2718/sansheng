/**
 * bug① · 对话页数据源「第 201 条起永远取不到」的独立复核 + 回归钉
 *
 * ── 这条缺陷的两层(都要被这个文件钉住)──────────────────────────
 *
 *   ① `listSessionMessages` 取的是**最早** limit 条
 *      (`ORDER BY created_at LIMIT ?`)—— `LIMIT` 在没有 `DESC` 时切的是**头**;
 *   ② `views.ts` 的 `listProjectMessages` 在**跨会话归并之后**又 `out.slice(-limit)`
 *      切一刀 —— 那一刀切的是「全体按时间排序后的最后 limit 条」,而输入是
 *      「每个会话各自的最早 limit 条」,两者不是一回事。
 *
 * 实测形态(A3,单会话 250 条):返回 200 条,首条 m001、末条 m200,**最新那条
 * (m250)不在里面** ⇒ 对话页自己的历史冻在旧窗口,刷新也读不到新消息。
 *
 * ── 语义(本文件钉的就是它)────────────────────────────────────
 *
 * `listProjectMessages(db, projectId, limit)` = **每个会话各取最新 limit 条**,
 * 归并后按 `(createdAt, id)` 升序返回,**不再有全体截断**。
 *
 * 为什么是「每会话」而不是「全体最新 limit 条」:调用方是对话页,它一次拿回全部
 * 消息再**按通道分流**(`web/src/lib/data.ts` 的 `partitionTurns`)。一条项目会话
 * 里 `thinking` / `tool` 也落库,内部会话轻易超过 200 条;若 limit 是**全体**的,
 * 甲方那场交付对话(设计 1 §2.11.6 的可见性不变量)会被内部刷屏整段挤出窗口 ——
 * 而页面上「另有 N 条不在这条通道里」那句**数不出被窗口丢掉的那些**
 * (`hidden` 只数拿到的轮里被过滤的),失败是静默的。
 *
 * ── 探针自检(本文件每个用例都自带)──────────────────────────────
 *
 *   正:先用一个**大于总条数**的 limit 读一遍,断言「全量读得到、且够得着最新那条」
 *       —— 读者本身没坏,窗口断言才有意义;
 *   负:再断言最旧的那些条**必须被挤出窗口** —— 一个「反正都返回」的实现过不了。
 *
 * 同毫秒:250 条同一个 `created_at` 时必须给出**全序且可重复**的结果,并且
 * `window(100) === window(200).slice(-100)`(截断是同一个全序的前缀,
 * 换 limit 不会把已经看到的行换掉)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import {
  appendSessionMessage, insertSession, listSessionMessages,
} from "../../src/platform/storage/repo/sessions.js";
import { listProjectMessages } from "../../src/platform/transport/views.js";
import { createPlatformApp, type HttpDeps } from "../../src/platform/transport/http.js";
import type { SessionMessageView } from "@shared/types/platform.js";

const P = "p-window";
const S_INTERNAL = "s_internal";
const S_CLIENT = "s_client";
const BASE = 1_700_000_000_000;

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  insertProject(db, {
    id: P, name: "登录系统", client: "甲方", goal: "把登录做出来",
    status: "active", createdAt: BASE,
  });
  insertAgent(db, {
    id: "bm", role: "business_manager", specialization: null, displayName: "业务经理", createdAt: BASE,
  });
});

afterEach(() => {
  db.close();
});

/**
 * 往一个会话灌 `n` 条消息,id 形如 `<tag>001`;返回落库 id 序列(时序)。
 *
 * `step` 用来造两种极端:`step=1` 逐毫秒递增(真实形态),
 * `step=0` **全部同一个 `created_at`**(同毫秒不可排序的现场)。
 */
function seed(sessionId: string, n: number, tag: string, base = BASE, step = 1): string[] {
  const ids: string[] = [];
  for (let i = 1; i <= n; i += 1) {
    const id = `${tag}${String(i).padStart(3, "0")}`;
    appendSessionMessage(db, {
      id,
      sessionId,
      agentId: null,
      kind: i % 2 === 0 ? "assistant" : "user",
      content: `${id} 的正文`,
      createdAt: base + i * step,
    });
    ids.push(id);
  }
  return ids;
}

function countRows(sessionId: string): number {
  const r = db
    .prepare(`SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ?`)
    .get(sessionId) as { n: number };
  return r.n;
}

function app(over?: Partial<HttpDeps>) {
  const deps: HttpDeps = {
    db,
    dataDir: "/tmp/bug1-window-test",
    cwd: "/tmp",
    personaName: "三生",
    version: "test",
    modelId: null,
    provider: null,
    hasAnyProvider: false,
    now: () => BASE,
    newId: (prefix) => `${prefix}_${(seq += 1)}`,
    reset: () => ({ cleared: [], totalRows: 0 }),
    harnessDirs: { dataDir: "/tmp/bug1-window-test", factoryDir: "/tmp/bug1-window-test-factory" },
    settings: {
      read: () => ({}),
      write: async () => ({ ok: true as const, settings: {} }),
      providers: () => [],
    },
    ...over,
  };
  return createPlatformApp(deps);
}

const idsOf = (rows: SessionMessageView[]): string[] => rows.map((m) => m.id);

describe("bug① · 对话页数据源的窗口:取的是最新 N 条,不是最早 N 条", () => {
  it("单会话 250 条:窗口 = 最后 200 条(m250 必须在里面)", () => {
    insertSession(db, { id: S_INTERNAL, projectId: P, createdAt: BASE });
    const all250 = seed(S_INTERNAL, 250, "m");

    // ── 探针自检(正样本):fixture 是真的,读者也够得着全量 ──────────
    expect(countRows(S_INTERNAL), "fixture 必须真有 250 条(否则下面的窗口断言是空转)").toBe(250);
    const full = listProjectMessages(db, P, 1000);
    expect(idsOf(full), "limit 大于总条数时,读函数必须逐条、按时序交出全部消息")
      .toEqual(all250);
    expect(idsOf(full).at(-1), "读者必须够得着最新那条 —— 否则「窗口里没有它」不是窗口的错").toBe("m250");

    // ── 被测:limit = 200 ─────────────────────────────────────────
    const win = listProjectMessages(db, P, 200);
    expect(win).toHaveLength(200);
    expect(win.at(-1)!.id, "最新的那条(m250)必须在窗口里 —— 这条在修之前是红的").toBe("m250");
    expect(win[0]!.id, "窗口是最后 200 条 ⇒ 首条是 m051").toBe("m051");
    expect(
      idsOf(win).includes("m001"),
      "最旧的 50 条必须被挤出去(一个「反正全返回」的实现过不了这条)",
    ).toBe(false);
    // 归并后的顺序:createdAt 非降
    for (let i = 1; i < win.length; i += 1) {
      expect(win[i]!.createdAt).toBeGreaterThanOrEqual(win[i - 1]!.createdAt);
    }
  });

  it("HTTP 面 GET /api/projects/:id/messages:对话页拿到的就是那个窗口", async () => {
    insertSession(db, { id: S_INTERNAL, projectId: P, createdAt: BASE });
    seed(S_INTERNAL, 250, "m");

    const res = await app().request(`/api/projects/${P}/messages`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: SessionMessageView[] };
    // 正样本自检:端点确实通了,而且把 200 条窗口交了回来
    expect(body.messages, "端点必须真的返回一窗口消息").toHaveLength(200);
    expect(
      body.messages.some((m) => m.id === "m250"),
      "对话页的数据源里必须有最新的那条(修之前这里是 false ⇒ 「新消息读不到」)",
    ).toBe(true);
    expect(body.messages.filter((m) => m.agentId === null && m.kind === "user").length)
      .toBeGreaterThan(0);
  });

  it("多会话:limit 是**每会话**的 —— 内部会话刷屏不许把甲方那场对话挤掉", () => {
    // 甲方那场交付对话**更早**(3 条),内部会话 250 条把它整段淹没
    insertSession(db, { id: S_CLIENT, projectId: P, createdAt: BASE, channel: "client" });
    seed(S_CLIENT, 3, "c", BASE);
    insertSession(db, { id: S_INTERNAL, projectId: P, createdAt: BASE + 10 });
    seed(S_INTERNAL, 250, "m", BASE + 10);

    // ── 探针自检:两个会话都在库里、都读得出来 ─────────────────────
    expect(countRows(S_CLIENT), "甲方对话那 3 条必须真的落库").toBe(3);
    expect(idsOf(listSessionMessages(db, S_CLIENT)), "且读得出来").toEqual(["c001", "c002", "c003"]);
    expect(countRows(S_INTERNAL), "内部会话 250 条").toBe(250);

    const win = listProjectMessages(db, P, 200);
    // 被测:每会话各取最新 limit 条 ⇒ 内部会话的窗口 + 甲方那 3 条
    expect(
      idsOf(win).includes("c003"),
      "甲方对话的新消息必须在窗口里(「全体最新 200 条」的语义会把它整段丢掉)",
    ).toBe(true);
    expect(idsOf(win), "甲方那场对话三条都在(它是**另一条**会话,不与内部抢窗口)").toEqual(
      expect.arrayContaining(["c001", "c002", "c003"]),
    );
    expect(win.at(-1)!.id, "内部会话的最新那条也在").toBe("m250");
    expect(idsOf(win).includes("m001"), "内部会话自己的旧消息照样被挤出去").toBe(false);
    // 跨会话归并:createdAt 非降
    for (let i = 1; i < win.length; i += 1) {
      expect(
        win[i]!.createdAt,
        `跨会话归并必须按时间升序(位置 ${i}:${win[i - 1]!.id} → ${win[i]!.id})`,
      ).toBeGreaterThanOrEqual(win[i - 1]!.createdAt);
    }
    // 归并面确实**跨**了两个会话(否则上面「按时间归并」是空话)
    expect(new Set(win.map((m) => m.id[0]))).toEqual(new Set(["c", "m"]));
  });

  it("同一 created_at:结果必须是全序、可重复,且换 limit 不换行", () => {
    insertSession(db, { id: S_INTERNAL, projectId: P, createdAt: BASE });
    // 250 条**全在同一个毫秒**,而且**插入次序与 id 次序相反** ——
    // 一个「靠 rowid / 插入次序兜底」的实现会切到**另外**那 200 条,所以这条有牙。
    const inserted: string[] = [];
    for (let i = 250; i >= 1; i -= 1) {
      const id = `m${String(i).padStart(3, "0")}`;
      appendSessionMessage(db, {
        id, sessionId: S_INTERNAL, agentId: null, kind: "user",
        content: `${id} 的正文`, createdAt: BASE, // ← 全部同一个 created_at
      });
      inserted.push(id);
    }
    // 正样本自检:fixture 真的是 250 条互不相同的行
    expect(countRows(S_INTERNAL)).toBe(250);
    expect(new Set(inserted).size).toBe(250);

    const a = idsOf(listProjectMessages(db, P, 200));
    const b = idsOf(listProjectMessages(db, P, 200));
    expect(a, "同毫秒下两次读必须一模一样(全序 ⇒ 不漂)").toEqual(b);
    expect(new Set(a).size, "窗口里不许出现重复行").toBe(200);

    // **契约**:同一毫秒的次序由 `id` 兜底(见 `listSessionMessages`)⇒
    // 窗口恰好是「最大的 200 个 id,升序」。这不是「真实发生次序」的断言,
    // 而是「全序长什么样」的断言 —— 它随查询计划漂就是静默漂,所以钉住。
    // (要换第二键是允许的,但同时要改 `listSessionMessages` 的 `ORDER BY` 与这里)
    expect(a, "同毫秒的第二键必须是 id(不是 rowid / 插入次序)").toEqual(
      [...inserted].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)).slice(-200),
    );

    // 截断必须是同一个全序的前缀:window(100) = window(200) 的最后 100 条
    const small = idsOf(listProjectMessages(db, P, 100));
    expect(small, "换 limit 不许把已经看到的行换掉(否则分页/截断会丢行)").toEqual(a.slice(-100));
  });

  it("边界:limit ≤ 0 / 非有限 → 空;limit 超上限 → 每会话最多 2000 条", () => {
    insertSession(db, { id: S_INTERNAL, projectId: P, createdAt: BASE });
    seed(S_INTERNAL, 250, "m");

    // 正样本自检:同样的 fixture 上 limit=1 必须给出 1 条(证明「空」不是 fixture 坏)
    expect(idsOf(listProjectMessages(db, P, 1))).toEqual(["m250"]);
    expect(listProjectMessages(db, P, 0), "limit = 0 ⇒ 没有消息(不是「每会话 1 条」那种怪值)").toEqual([]);
    expect(listProjectMessages(db, P, -5), "limit < 0 ⇒ 没有消息").toEqual([]);
    expect(listProjectMessages(db, P, Number.NaN), "limit 非有限 ⇒ 没有消息(不许退化成无界读)").toEqual([]);

    // 上限 2000(`repo/sessions.ts` 的 `normalizeMessageLimit`)
    seed(S_INTERNAL, 1850, "n", BASE + 1000); // 合计 2100 条
    expect(countRows(S_INTERNAL)).toBe(2100);
    const capped = listProjectMessages(db, P, 10_000);
    expect(capped, "limit 超上限时每会话截到 2000 条").toHaveLength(2000);
    expect(idsOf(capped).at(-1), "截断后最新那条仍然在").toBe("n1850");
    expect(idsOf(capped).includes("m001"), "最早那 100 条被上限挤出去").toBe(false);
  });

  it("接待会话(projectId === null)走同一个函数:最新那条也必须在窗口里", () => {
    insertSession(db, { id: "s_intake", projectId: null, createdAt: BASE });
    seed("s_intake", 250, "k");

    expect(countRows("s_intake")).toBe(250);
    const win = listProjectMessages(db, null, 200);
    expect(win, "接待会话是同一张表、同一个读函数").toHaveLength(200);
    expect(idsOf(win).at(-1), "接待会话的最新一条不许因为窗口写法而取不到").toBe("k250");
    // 正样本:它确实读的是接待会话那一条(不是空列表)
    expect(win.every((m) => m.projectId === null)).toBe(true);
  });
});
