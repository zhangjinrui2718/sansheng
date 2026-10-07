/**
 * T4 · 用量仓储(`repo/usage.ts`)—— **读**那一半的机器形式
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────
 *
 * `tests/platform/turn-usage.test.ts` 守 018 的**表形状**;
 * `tests/platform/turn-usage-write.test.ts` 守**写**(读点、快照、几行);
 * 这里守**读**:窗口、按天分桶、NULL 语义、以及三条外键在**删数据时**的动作。
 * 三者各有各的静默失效方式,混在一个文件里迟早有一条没人跑。
 *
 * ── 本文件里最要紧的四条 ────────────────────────────────────────
 *
 *   ① **NULL 用 `IS ?`**:接待会话的账 `project_id IS NULL`,写成 `= ?` 会
 *      **一条都查不出来** —— 而「空列表」与「真的没花过钱」在接口上长得一样。
 *      这里连**负样本**一起钉:同一条 `= NULL` 的查询确实返回 0 行。
 *   ② **按天分桶是两套独立实现**:SQL 的 `date(..., 'localtime')` 与 JS 的
 *      `localDayKey` —— 交叉核对,两边不一致就红(时区处理错会**静默**把某天的
 *      账挪到另一天)。
 *   ③ **`limit` 只截 `byDay`,绝不截合计**:截合计会让数字在历史变长时静默变小。
 *   ④ **删数据时的三条外键动作**(会话无外键 / 工作项 SET NULL / 项目 CASCADE):
 *      018 为它们各写了一段理由,这里是那些理由的机器形式 —— 尤其
 *      「`project_sessions` 被 `adoptIntakeMessages` 删掉时用量**不许**跟着消失」。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember } from "../../src/platform/storage/repo/projects.js";
import { insertWork } from "../../src/platform/storage/repo/works.js";
import { insertSession } from "../../src/platform/storage/repo/sessions.js";
import {
  aggregateProjectUsage, insertTurnUsage, listTurnUsage, localDayKey,
  normalizeUsageDayLimit, normalizeUsageDays, startOfLocalDay,
  USAGE_DEFAULT_DAYS, USAGE_MAX_DAYS, type TurnUsageRow,
} from "../../src/platform/storage/repo/usage.js";

let db: Database.Database;

/** 固定「现在」—— 窗口与「今日」都以它为准,测试不依赖真实时钟。 */
const NOW = new Date(2026, 4, 20, 15, 30, 0, 0).getTime(); // 本地 2026-05-20 15:30
const DAY = 86_400_000;

/** 本地某天的 `h` 时(`dayOffset` 天前,0 = 今天)。 */
function at(dayOffset: number, hour = 12): number {
  return startOfLocalDay(NOW) - dayOffset * DAY + hour * 3_600_000;
}

let seq = 0;
function put(over: Partial<TurnUsageRow> & Pick<TurnUsageRow, "agentId" | "createdAt">): string {
  seq += 1;
  const id = over.id ?? `tu_${String(seq).padStart(3, "0")}`;
  insertTurnUsage(db, {
    id,
    projectId: over.projectId === undefined ? "p1" : over.projectId,
    sessionId: over.sessionId ?? null,
    agentId: over.agentId,
    workId: over.workId ?? null,
    model: over.model ?? null,
    inputTokens: over.inputTokens ?? 0,
    outputTokens: over.outputTokens ?? 0,
    cacheRead: over.cacheRead ?? 0,
    createdAt: over.createdAt,
  });
  return id;
}

beforeEach(() => {
  seq = 0;
  db = openPlatformMemoryDb();
  insertAgent(db, { id: "wk", role: "research_worker", specialization: "engineering", displayName: "研究员", createdAt: 1 });
  insertAgent(db, { id: "pm", role: "project_manager", specialization: null, displayName: "项目经理", createdAt: 1 });
  insertProject(db, { id: "p1", name: "项目一", client: "甲", goal: "g", status: "active", createdAt: 1 });
  insertProject(db, { id: "p2", name: "项目二", client: "乙", goal: "g", status: "active", createdAt: 1 });
  addMember(db, "p1", "wk", 1);
  addMember(db, "p1", "pm", 1);
  addMember(db, "p2", "wk", 1);
});
afterEach(() => db.close());

const aggP1 = (days = 7, dayLimit = 7) =>
  aggregateProjectUsage(db, "p1", { now: NOW, days, dayLimit });

// ════════════════════════════════════════════════════════════════

describe("usage · 窗口边界(坏值取默认,不取「无上界」)", () => {
  it("normalizeUsageDays:默认 7、上界 365,`0`/负数/NaN 一律归默认", () => {
    expect(normalizeUsageDays(7)).toBe(7);
    expect(normalizeUsageDays(365)).toBe(365);
    expect(normalizeUsageDays(366)).toBe(USAGE_MAX_DAYS);
    expect(normalizeUsageDays(1.9)).toBe(1);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(normalizeUsageDays(bad), `坏值 ${String(bad)} 必须取默认而不是无上界`).toBe(USAGE_DEFAULT_DAYS);
    }
  });

  it("normalizeUsageDayLimit:默认 = 窗口天数,且**不可能超过**窗口", () => {
    expect(normalizeUsageDayLimit(Number.NaN, 7)).toBe(7);
    expect(normalizeUsageDayLimit(0, 7)).toBe(7);
    expect(normalizeUsageDayLimit(3, 7)).toBe(3);
    expect(normalizeUsageDayLimit(99, 7)).toBe(7);
    // 窗口本身是坏值时,两边用的是同一个规范化函数 ⇒ 不会出现「lim > days」
    expect(normalizeUsageDayLimit(99, 0)).toBe(USAGE_DEFAULT_DAYS);
  });

  it("`days = 1` 就是今日:含今日共 days 个本地日历日", () => {
    put({ agentId: "wk", createdAt: at(0, 1), inputTokens: 10 });
    put({ agentId: "wk", createdAt: at(1, 23), inputTokens: 20 });
    const one = aggP1(1, 1);
    expect(one.totals.input).toBe(10);
    expect(one.window.since).toBe(startOfLocalDay(NOW));
    expect(one.byDay.map((d) => d.day)).toEqual([localDayKey(NOW)]);
  });

  it("窗口**含**边界两端(闭区间):`since` 那一刻与 `until` 那一刻都算", () => {
    put({ agentId: "wk", createdAt: startOfLocalDay(NOW) - 6 * DAY, inputTokens: 1 }); // 第 7 天零点
    put({ agentId: "wk", createdAt: startOfLocalDay(NOW) - 7 * DAY, inputTokens: 8 }); // 第 8 天(窗外)
    put({ agentId: "wk", createdAt: NOW, inputTokens: 2 }); // 此刻
    put({ agentId: "wk", createdAt: NOW + 1, inputTokens: 4 }); // 未来 1ms(窗外)
    const r = aggP1(7, 7);
    expect(r.window.since).toBe(startOfLocalDay(NOW) - 6 * DAY);
    expect(r.totals.input).toBe(1 + 2);
    // 窗外那两笔**没有消失**,它们在 allTime 里 —— 这正是「合计」与「全历史」分家的理由
    expect(r.allTime.input).toBe(1 + 8 + 2 + 4);
  });
});

describe("usage · NULL 语义(接待会话那笔账)", () => {
  it("★ `project_id = NULL` 的行读得到(`IS ?`),而 `= ?` 一条也查不出来", () => {
    put({ agentId: "pm", projectId: null, createdAt: at(0), inputTokens: 500 });
    put({ agentId: "wk", projectId: "p1", createdAt: at(0), inputTokens: 100 });

    const intake = listTurnUsage(db, null, { since: 0, until: Number.MAX_SAFE_INTEGER });
    expect(intake).toHaveLength(1);
    expect(intake[0]!.inputTokens).toBe(500);
    expect(intake[0]!.projectId).toBeNull();

    // **负样本**:同一条查询写成 `= ?` 会静默返回 0 —— 那正是「接待会话的账
    // 静默消失」的形态(而空结果与「真的没花过钱」长得一样)。
    const naive = db
      .prepare(`SELECT COUNT(*) AS n FROM turn_usage WHERE project_id = ?`)
      .get(null) as { n: number };
    expect(naive.n, "SQL 里 `= NULL` 恒为 unknown —— 这就是纪律①的现场").toBe(0);
    const correct = db
      .prepare(`SELECT COUNT(*) AS n FROM turn_usage WHERE project_id IS ?`)
      .get(null) as { n: number };
    expect(correct.n).toBe(1);
  });

  it("null 与项目**互不污染**:读接待会话不会带上任何项目,反之亦然", () => {
    put({ agentId: "pm", projectId: null, createdAt: at(0), inputTokens: 1 });
    put({ agentId: "wk", projectId: "p1", createdAt: at(0), inputTokens: 2 });
    const intake = aggregateProjectUsage(db, null, { now: NOW, days: 7, dayLimit: 7 });
    const p1 = aggP1();
    expect(intake.totals.input).toBe(1);
    expect(p1.totals.input).toBe(2);
    expect(intake.projectId).toBeNull();
    expect(p1.projectId).toBe("p1");
  });
});

describe("usage · 聚合(合计 / 今日 / 按角色 / 按天)", () => {
  it("★ 按天分桶与 `localDayKey` **交叉核对**(SQL `localtime` ↔ JS 两套实现)", () => {
    // 同一本地日的两端(00:00:01 与 23:59:59)必须落进同一天;
    // 跨零点必须分成两天。时区处理错会**静默**把某天的账挪到另一天。
    //
    // ⚠️ 这一条用**自己的 `now`**(当天 23:59:59):窗口的 `until` 是 `now`,
    // 用默认的 15:30 会让「今天 23:59」落在窗口外 —— 那是窗口边界的事,
    // 不是分桶的事,混在一起会让这条交叉核对测到错的东西。
    const NOW_LATE = new Date(2026, 4, 20, 23, 59, 59, 999).getTime();
    const dayStart = startOfLocalDay(NOW_LATE);
    const d1a = dayStart + 1000; // 今日 00:00:01
    const d1b = NOW_LATE; // 今日 23:59:59.999
    const d2 = dayStart - 12 * 3_600_000; // 昨日 12:00
    put({ agentId: "wk", createdAt: d1a, inputTokens: 1 });
    put({ agentId: "wk", createdAt: d1b, inputTokens: 2 });
    put({ agentId: "wk", createdAt: d2, inputTokens: 4 });

    const r = aggregateProjectUsage(db, "p1", { now: NOW_LATE, days: 7, dayLimit: 7 });
    const expectDays = [localDayKey(d2), localDayKey(d1a)]; // 升序
    expect(r.byDay.map((d) => d.day)).toEqual(expectDays);
    expect(r.byDay.map((d) => d.input)).toEqual([4, 1 + 2]);
    expect(localDayKey(d1a)).toBe(localDayKey(d1b)); // 同一天的两端
    expect(localDayKey(d1a)).not.toBe(localDayKey(d2));
  });

  it("按角色分组:量的降序,同量按 agentId 字典序(次序固定)", () => {
    put({ agentId: "wk", createdAt: at(0), inputTokens: 10, outputTokens: 1, cacheRead: 5 });
    put({ agentId: "pm", createdAt: at(0), inputTokens: 100, outputTokens: 2, cacheRead: 0 });
    put({ agentId: "wk", createdAt: at(1), inputTokens: 10, outputTokens: 3, cacheRead: 1 });
    const r = aggP1();
    expect(r.byAgent.map((b) => b.agentId)).toEqual(["pm", "wk"]);
    expect(r.byAgent[0]).toMatchObject({ agentId: "pm", input: 100, turns: 1 });
    expect(r.byAgent[1]).toMatchObject({ agentId: "wk", input: 20, output: 4, cacheRead: 6, turns: 2 });
    // 合计 = 各角色之和(不是「行数」或「最后一次」)
    expect(r.totals).toEqual({ input: 120, output: 6, cacheRead: 6, turns: 3 });
  });

  /** 造一条工作项(`turn_usage.work_id` 有外键 ⇒ 账不能凭空挂在 id 上)。 */
  const mkWork = (id: string): void => {
    insertWork(db, {
      id, projectId: "p1", parentWorkId: null, title: `活 ${id}`, goal: "g",
      status: "in_progress", assigneeAgentId: "wk", createdAt: 1, updatedAt: 1,
    });
  };

  it("★ 按**工作项**分组(2026-10-08):`null` 是独立的一桶,**不许并进任何工作项**", () => {
    // 这一维回答的是「哪件活在花钱」—— 而 `byAgent` 只回答「谁在花钱」。
    // 真机那条单回合 109k token 的工作项,在只有 byAgent 的读面上与别的活
    // 长得一模一样。
    mkWork("w_big");
    mkWork("w_small");
    put({ agentId: "wk", createdAt: at(0), workId: "w_big", inputTokens: 900 });
    put({ agentId: "wk", createdAt: at(0), workId: "w_small", inputTokens: 10 });
    put({ agentId: "pm", createdAt: at(0), workId: "w_small", inputTokens: 30 });
    // 平台回合:不挂任何工作项(播报 / 答复处置 / 收口判断)—— 真实花费
    put({ agentId: "pm", createdAt: at(0), workId: null, inputTokens: 5 });

    const r = aggP1();
    // 量的降序;**null 桶排在最后**(它是「不挂环节」,不是「最小的 id」)
    expect(r.byWork.map((b) => b.workId)).toEqual(["w_big", "w_small", null]);
    expect(r.byWork[0]).toMatchObject({ workId: "w_big", input: 900, turns: 1 });
    expect(r.byWork[1]).toMatchObject({ workId: "w_small", input: 40, turns: 2 });
    expect(r.byWork[2]).toMatchObject({ workId: null, input: 5, turns: 1 });

    // **分项之和 = 合计**:丢一个桶或并一个桶都会让这条等式不成立 ——
    // 而对不上的账本会让人先怀疑数字,再怀疑整个观测面。
    const sum = r.byWork.reduce((n, b) => n + b.input, 0);
    expect(sum).toBe(r.totals.input);
  });

  it("★ 按工作项分组**不受 `dayLimit` 截断**(工作项是十位数量级,回合是千位)", () => {
    for (let i = 0; i < 12; i += 1) {
      const wid = `w_${String(i).padStart(2, "0")}`;
      mkWork(wid);
      put({ agentId: "wk", createdAt: at(0), workId: wid, inputTokens: i + 1 });
    }
    const short = aggregateProjectUsage(db, "p1", { now: NOW, days: 7, dayLimit: 1 });
    // `byDay` 被截(那是它的契约),而 `byWork` 一条都不许少
    expect(short.byDay).toHaveLength(1);
    expect(short.byWork).toHaveLength(12);
  });

  it("`today` 是**本地日历日**,不是「最近 24 小时」", () => {
    put({ agentId: "wk", createdAt: startOfLocalDay(NOW) - 1, inputTokens: 7 }); // 昨夜 23:59:59.999
    put({ agentId: "wk", createdAt: startOfLocalDay(NOW), inputTokens: 9 }); // 今晨 00:00
    const r = aggP1();
    expect(r.today.input).toBe(9); // 昨夜那笔不算「今日」
    expect(r.totals.input).toBe(16);
  });

  it("★ `limit` 只截 `byDay`:**合计 / 全历史 / 按角色一个数都不许变**", () => {
    for (let d = 0; d < 6; d++) put({ agentId: "wk", createdAt: at(d, 3), inputTokens: d + 1 });
    const full = aggP1(7, 7);
    const short = aggP1(7, 3);
    expect(full.byDay).toHaveLength(6);
    expect(short.byDay).toHaveLength(3);
    // 截断的是**展示**,不是账
    expect(short.totals).toEqual(full.totals);
    expect(short.allTime).toEqual(full.allTime);
    expect(short.byAgent).toEqual(full.byAgent);
    expect(full.totals.input).toBe(1 + 2 + 3 + 4 + 5 + 6);
    // 而且**不许静默**:截了就说截了
    expect(short.byDayTruncated).toBe(true);
    expect(full.byDayTruncated).toBe(false);
    // 留下来的必须是**最近**那几天(降序取尾巴,再翻回升序)
    expect(short.byDay.map((d) => d.day)).toEqual([
      localDayKey(at(2, 3)), localDayKey(at(1, 3)), localDayKey(at(0, 3)),
    ]);
  });

  it("「今天还没花钱」**不报**成截断(假警报也是一种撒谎)", () => {
    for (let d = 3; d < 6; d++) put({ agentId: "wk", createdAt: at(d, 3), inputTokens: 1 });
    const r = aggP1(7, 3);
    expect(r.byDay).toHaveLength(3);
    expect(r.byDayTruncated, "窗口 7 天里只有 3 天有账 ⇒ 没有被截掉任何一天").toBe(false);
  });

  it("空项目:全零 + `updatedAt` 为 null(**不拿「现在」冒充**)", () => {
    const r = aggP1();
    expect(r.totals).toEqual({ input: 0, output: 0, cacheRead: 0, turns: 0 });
    expect(r.allTime).toEqual({ input: 0, output: 0, cacheRead: 0, turns: 0 });
    expect(r.byAgent).toEqual([]);
    expect(r.byDay).toEqual([]);
    expect(r.byDayTruncated).toBe(false);
    expect(r.updatedAt).toBeNull();
  });

  it("`updatedAt` = 窗口内**最近一行**的时刻(不是「现在」)", () => {
    put({ agentId: "wk", createdAt: at(2, 1), inputTokens: 1 });
    put({ agentId: "wk", createdAt: at(0, 9), inputTokens: 1 });
    put({ agentId: "wk", createdAt: at(30, 9), inputTokens: 1 }); // 窗口外
    expect(aggP1().updatedAt).toBe(at(0, 9));
  });

  it("同一份数据两次读**逐字相同**(次序不漂)", () => {
    put({ agentId: "wk", createdAt: at(0, 1), inputTokens: 5 });
    put({ agentId: "pm", createdAt: at(0, 1), inputTokens: 5 });
    put({ agentId: "wk", createdAt: at(1, 1), inputTokens: 5 });
    expect(JSON.stringify(aggP1())).toBe(JSON.stringify(aggP1()));
  });

  it("窗口外的行**不进** totals,但**进** allTime(合计不会静默变小)", () => {
    put({ agentId: "wk", createdAt: at(100, 1), inputTokens: 999 });
    put({ agentId: "wk", createdAt: at(0, 1), inputTokens: 1 });
    const r = aggP1(7, 7);
    expect(r.totals.input).toBe(1);
    expect(r.allTime.input).toBe(1000);
    expect(r.window).toEqual({ days: 7, since: startOfLocalDay(NOW) - 6 * DAY, until: NOW });
  });

  it("会话维度:`sessionId` 只是记录,不参与聚合(不按会话拆账)", () => {
    const s1 = "s_1";
    insertSession(db, { id: s1, projectId: "p1", createdAt: 1 });
    put({ agentId: "wk", createdAt: at(0, 1), inputTokens: 3, sessionId: s1 });
    put({ agentId: "wk", createdAt: at(0, 2), inputTokens: 4, sessionId: null });
    const r = aggP1();
    expect(r.totals.input).toBe(7);
    expect(r.totals.turns).toBe(2);
  });
});

describe("usage · 删数据时三条外键的动作(018 各写了一段理由)", () => {
  it("★ `session_id` **无外键**:删掉会话(立项时 `adoptIntakeMessages` 真会这么干)—— 用量**活下来**", () => {
    insertSession(db, { id: "s_del", projectId: "p1", createdAt: 1 });
    const id = put({ agentId: "wk", createdAt: at(0), inputTokens: 42, sessionId: "s_del" });

    // 立项之后接待会话行真的会被 DELETE —— 见 018 与 host/serve.ts 的 adoptIntakeMessages
    db.prepare(`DELETE FROM project_sessions WHERE id = ?`).run("s_del");

    const kept = db.prepare(`SELECT id, session_id FROM turn_usage WHERE id = ?`).get(id) as
      | { id: string; session_id: string | null }
      | undefined;
    expect(kept, "用量必须比会话活得久 —— 有 CASCADE 的话这里会**静默**少一笔账").toBeDefined();
    expect(kept!.session_id).toBe("s_del"); // 原样保留,不置空
  });

  it("`work_id` 是 **ON DELETE SET NULL**:删工作项不删账,只把工作项那一格置空", () => {
    insertWork(db, {
      id: "w_x", projectId: "p1", parentWorkId: null, title: "活", goal: "g",
      status: "in_progress", assigneeAgentId: "wk", createdAt: 1, updatedAt: 1,
    });
    const id = put({ agentId: "wk", createdAt: at(0), inputTokens: 42, workId: "w_x" });
    db.prepare(`DELETE FROM works WHERE id = ?`).run("w_x");
    const kept = db.prepare(`SELECT work_id FROM turn_usage WHERE id = ?`).get(id) as
      | { work_id: string | null }
      | undefined;
    expect(kept, "删工作项**不该**连带删掉已经花掉的钱的记录").toBeDefined();
    expect(kept!.work_id).toBeNull();
  });

  it("`project_id` 是 **ON DELETE CASCADE**:删项目连带删它的账(这条**是**设计)", () => {
    const id = put({ agentId: "wk", createdAt: at(0), inputTokens: 42 });
    db.prepare(`DELETE FROM projects WHERE id = ?`).run("p1");
    const gone = db.prepare(`SELECT id FROM turn_usage WHERE id = ?`).get(id);
    expect(gone).toBeUndefined();
  });

  it("`agent_id` 是 **NO ACTION**:删还有账的角色会被外键**拦住**(不静默删账)", () => {
    put({ agentId: "wk", createdAt: at(0), inputTokens: 1 });
    expect(() => db.prepare(`DELETE FROM agents WHERE id = ?`).run("wk")).toThrow(/FOREIGN KEY/i);
    expect(aggP1().totals.turns).toBe(1);
  });

  it("悬空引用被拒(负样本):不存在的项目 / 角色 / 工作项写不进去", () => {
    const row = (over: Partial<TurnUsageRow>): TurnUsageRow => ({
      id: "tu_bad", projectId: "p1", sessionId: null, agentId: "wk", workId: null,
      model: null, inputTokens: 1, outputTokens: 0, cacheRead: 0, createdAt: 1, ...over,
    });
    expect(() => insertTurnUsage(db, row({ projectId: "p_不存在" }))).toThrow(/FOREIGN KEY/i);
    expect(() => insertTurnUsage(db, row({ agentId: "ag_不存在" }))).toThrow(/FOREIGN KEY/i);
    expect(() => insertTurnUsage(db, row({ workId: "w_不存在" }))).toThrow(/FOREIGN KEY/i);
    expect(() => insertTurnUsage(db, row({ agentId: null as unknown as string })))
      .toThrow(/NOT NULL/i);
  });

  it("★ **负样本**:同一张表把 `project_id` 改成 `NOT NULL` ⇒ 接待会话那笔账**写不进去**", () => {
    // 018 的注释里说得很清楚:NOT NULL 会逼写入侧二选一 —— 丢掉它(静默少账)
    // 或编一个项目 id(假账)。这里把那句话变成一条**会红**的断言。
    const strict = new (db.constructor as new (p: string) => Database.Database)(":memory:");
    strict.exec(`CREATE TABLE turn_usage_strict (id TEXT PRIMARY KEY, project_id TEXT NOT NULL)`);
    expect(() => strict.prepare(`INSERT INTO turn_usage_strict VALUES (?, ?)`).run("x", null))
      .toThrow(/NOT NULL/i);
    // 而真实表(NOT NULL 缺席)接受它 —— 两条路必须**结果不同**,否则这条负样本是空的
    insertTurnUsage(db, {
      id: "tu_intake", projectId: null, sessionId: null, agentId: "pm", workId: null,
      model: null, inputTokens: 1, outputTokens: 0, cacheRead: 0, createdAt: 1,
    });
    const n = db.prepare(`SELECT COUNT(*) AS n FROM turn_usage WHERE project_id IS NULL`).get() as { n: number };
    expect(n.n).toBe(1);
    strict.close();
  });
});
