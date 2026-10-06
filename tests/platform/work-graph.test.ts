/**
 * 工作项图 · 依赖边可改 / 状态迁移表落进唯一写口 / outbox 写入侧收紧
 *
 * 这三件事在同一个文件里(`repo/works.ts`),因为它们其实是**同一个毛病的三个面**:
 * 判据散在模型的自述与调用点里,而不是库里的一条事实。
 *
 *   任务 1  依赖边只能在 `work_create` 时画 —— 已有工作项改不了
 *           → 项目经理只能「取消旧的 + 新建一份」→ 真机数据里那条 cancelled 事故
 *   任务 2  「状态机」只是一个闭集 + 一个写口,迁移合法性写在工具描述里(**文档不是机制**)
 *   任务 3  每一条状态迁移都写 outbox → 中间工作项的完成把业务经理叫醒 → 甲方看到一长串
 *   任务 4  `cancelled` 什么都不写 —— 而它正是下游悬空的来源
 *
 * 真机数据(`~/.sansheng/sansheng.db`,只读复核)里的形状,本文件第 1 组用例照着它写:
 *
 *   [cancelled] 三段式 vs omni 综合对比与替代路径分析   wk_mutsr5um7pvqej0r
 *   [open]      三段式 vs omni 综合对比与替代路径分析   wk_mutsrwg6tfcjv5x1  ← 同名新建
 *   [open]      调研报告整合与撰写                      wk_mutsrwg8cl7tatjx
 *       前置:… + 三段式 vs omni 综合对比 = **cancelled** ← 指向被取消的那份旧的
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject, loadProjectForAuthz } from "../../src/platform/storage/repo/projects.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import {
  insertWork, getWork, updateWorkStatus, checkWorkTransition, isWorkTransitionAllowed,
  nextWorkStatuses, setWorkDeps, listDeps, listDependents, createsCycle, addDep, WORK_TRANSITIONS,
  WORK_STATUSES, isTerminalWorkStatus, type WorkStatus,
} from "../../src/platform/storage/repo/works.js";
import {
  listPendingDispatchEvents, DISPATCH_EVENT_KIND_MIGRATION,
} from "../../src/platform/storage/repo/dispatch.js";
import { insertBlocker } from "../../src/platform/storage/repo/blockers.js";
import { collectTodos } from "../../src/platform/runtime/dispatcher.js";
import { dispatch } from "../../src/platform/tools/registry.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";
import type { Agent } from "../../src/platform/harness/authorize.js";

let db: Database.Database;
const T0 = 1_700_000_000_000;
let seq = 0;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  insertProject(db, {
    id: "p1", name: "语音机器人调研", client: "甲方",
    goal: "给出三条技术路线的对比与选型建议", status: "active", createdAt: T0,
  });
  ensureProjectOrg(db, "p1", T0);
  // 第二个项目:跨项目依赖那条用例要用
  insertProject(db, {
    id: "p2", name: "另一个项目", client: "甲方", goal: "g", status: "active", createdAt: T0,
  });
  ensureProjectOrg(db, "p2", T0);
});
afterEach(() => db.close());

interface WorkOver {
  id?: string;
  projectId?: string;
  parentWorkId?: string | null;
  title?: string;
  status?: WorkStatus;
  assignee?: string;
}

function mkWork(over: WorkOver = {}): string {
  const id = over.id ?? `wk_${++seq}`;
  insertWork(db, {
    id,
    projectId: over.projectId ?? "p1",
    parentWorkId: over.parentWorkId ?? null,
    title: over.title ?? `工作${seq}`,
    goal: "g",
    status: over.status ?? "open",
    assigneeAgentId: over.assignee ?? "wk",
    createdAt: T0 + seq,
    updatedAt: T0 + seq,
  });
  return id;
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

function pendingKinds(projectId = "p1"): string[] {
  return listPendingDispatchEvents(db, projectId).map((e) => e.kind);
}

function totalEventRows(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM dispatch_events`).get() as { n: number }).n;
}

// ── 工具层:一个真的项目经理上下文 ────────────────────────────────

function pmCtx(): ToolRunContext {
  const agent: Agent = { id: "pm", role: "project_manager", displayName: "项目经理" };
  return {
    db,
    agent,
    project: loadProjectForAuthz(db, "p1")!,
    now: () => T0 + 10_000,
    newId: (p) => `${p}_new${++seq}`,
  };
}

function callPm(tool: string, args: Record<string, unknown>): ToolResult {
  const r = dispatch(tool, args, pmCtx());
  if (r instanceof Promise) throw new Error("本文件只覆盖同步工具");
  return r;
}

function okText(r: ToolResult): string {
  if (!r.ok) throw new Error(`期望成功,实际失败[${r.code}] ${r.message}`);
  return r.text;
}

function errOf(r: ToolResult): Extract<ToolResult, { ok: false }> {
  if (r.ok) throw new Error(`期望失败,实际成功:${r.text}`);
  return r;
}

/**
 * 把 `dispatch_events` **退回 migration 015 之前**的 schema(013 的 4 值闭集)。
 *
 * ── 为什么方向反过来了(015 落地时改的)────────────────────────────
 * 这个函数原来是 `simulateMigration015()` —— 015 还没落地,于是手工重建一次来
 * 证明「放宽之后 work_cancelled 就落库了」。015 真的落地之后:
 *   - 正向模拟变成**空转**:真迁移已经做过同一件事,它只会掩盖一个事实 ——
 *     那两个用例其实是在测「schema 已经放宽」,而不是在测降级;
 *   - 而写入侧的降级路径(窄匹配那条 CHECK → 如实报 `deferred`)仍然必须
 *     **有牙地**被覆盖:它现在防的是「schema 落后于代码」(旧库 / 手工动过的库)。
 * 要测它,就得把 schema **真的**退回去 —— 方向反过来,断言一个字不用改。
 */
function simulatePreMigration015(): void {
  db.exec(`
    ALTER TABLE dispatch_events RENAME TO dispatch_events_post015;
    CREATE TABLE dispatch_events (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL CHECK (kind IN (
                    'work_done', 'work_failed', 'work_blocked', 'blocker_opened')),
      subject_id  TEXT NOT NULL,
      summary     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      consumed_at INTEGER,
      consumed_by TEXT REFERENCES agents(id)
    );
    INSERT INTO dispatch_events (seq, project_id, kind, subject_id, summary, created_at,
                                 consumed_at, consumed_by)
      SELECT seq, project_id, kind, subject_id, summary, created_at, consumed_at, consumed_by
      FROM dispatch_events_post015;
    DROP TABLE dispatch_events_post015;
    CREATE INDEX IF NOT EXISTS idx_dispatch_events_pending
      ON dispatch_events(project_id, created_at) WHERE consumed_at IS NULL;
  `);
}

// ══════════════════════════════════════════════════════════════════
// 任务 1 · 依赖边可改 —— 真机事故的真根因
// ══════════════════════════════════════════════════════════════════

describe("任务 1 · setWorkDeps 整体替换", () => {
  it("旧边被移除、新边被加上(整体替换,不是追加)", () => {
    const w = mkWork(), a = mkWork(), b = mkWork();
    expect(setWorkDeps(db, w, [a]).ok).toBe(true);
    const r = setWorkDeps(db, w, [b]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(sorted(r.removed)).toEqual([a]);
    expect(sorted(r.added)).toEqual([b]);
    expect(sorted(listDeps(db, w))).toEqual([b]);
  });

  it("空数组 = 清空依赖", () => {
    const w = mkWork(), a = mkWork();
    setWorkDeps(db, w, [a]);
    const r = setWorkDeps(db, w, []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.deps).toEqual([]);
    expect(listDeps(db, w)).toEqual([]);
  });

  it("给同一集合 = 幂等(没有新增也没有移除)", () => {
    const w = mkWork(), a = mkWork();
    setWorkDeps(db, w, [a]);
    const r = setWorkDeps(db, w, [a]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it("入参里重复的 id 去重(边还在 —— 没丢信息,所以不算静默丢弃)", () => {
    const w = mkWork(), a = mkWork();
    const r = setWorkDeps(db, w, [a, a]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.deps).toEqual([a]);
    expect(listDeps(db, w)).toEqual([a]);
  });
});

describe("任务 1 · 依赖边的三类非法输入都是**结构化错误**,不静默丢弃", () => {
  it("不存在的 id → not_found", () => {
    const w = mkWork();
    expect(setWorkDeps(db, w, ["wk_不存在"])).toMatchObject({
      ok: false, reason: "not_found", offending: "wk_不存在",
    });
  });

  it("跨项目的 id → cross_project", () => {
    const w = mkWork(), other = mkWork({ projectId: "p2" });
    expect(setWorkDeps(db, w, [other])).toMatchObject({
      ok: false, reason: "cross_project", offending: other,
    });
  });

  it("自环 → self", () => {
    const w = mkWork();
    expect(setWorkDeps(db, w, [w])).toMatchObject({ ok: false, reason: "self" });
  });

  it("成环 → cycle,而且**一个字节都没写**(原依赖保持不变)", () => {
    const a = mkWork(), b = mkWork(), c = mkWork();
    setWorkDeps(db, b, [a]); // b 依赖 a
    setWorkDeps(db, c, [b]); // c 依赖 b
    setWorkDeps(db, a, [c]); // a 依赖 c → 会成环
    const r = setWorkDeps(db, a, [c]);
    expect(r).toMatchObject({ ok: false, reason: "cycle", offending: c });
    expect(listDeps(db, a)).toEqual([]);
  });

  it("替换时**移除的那条边**不会让判据误判:先判后写与写后再判同结果", () => {
    // w 现在依赖 a;a 依赖 b。把 w 的依赖换成 [b] —— 合法(不移除也不会成环)。
    const w = mkWork(), a = mkWork(), b = mkWork();
    setWorkDeps(db, a, [b]);
    setWorkDeps(db, w, [a]);
    const r = setWorkDeps(db, w, [b]);
    expect(r.ok).toBe(true);
    expect(sorted(listDeps(db, w))).toEqual([b]);
  });

  it("失败时返回的 message 说清了是哪条边、为什么", () => {
    const w = mkWork();
    const r = setWorkDeps(db, w, ["ghost"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("ghost");
  });
});

describe("任务 1 · work_create 与 work_update 共用同一套依赖判定", () => {
  it("create 拦得住的环,update 也拦得住(同一个 reason,同一段代码)", () => {
    const a = mkWork(), b = mkWork();
    // create:b 依赖 a
    okText(callPm("work_create", {
      title: "B", goal: "g", assigneeRole: "worker", assigneeSpec: "engineering",
      dependsOn: [a],
    }));
    const bNew = listDependents(db, a)[0]!;
    // 让 a 依赖 b(那条新建的)→ 成环
    const e = errOf(callPm("work_update", { workId: a, dependsOn: [bNew] }));
    expect(e.code).toBe("conflict");
    expect(e.message).toContain("成环");
    expect(listDeps(db, a)).toEqual([]);
    void b;
  });

  it("create 的 dependsOn 也走严格读法:给了字符串而不是数组 → 拒绝,且**不建工作项**", () => {
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM works`).get() as { n: number }).n;
    const e = errOf(callPm("work_create", {
      title: "X", goal: "g", assigneeRole: "worker", assigneeSpec: "engineering",
      dependsOn: "wk_1",
    }));
    expect(e.code).toBe("invalid_args");
    const after = (db.prepare(`SELECT COUNT(*) AS n FROM works`).get() as { n: number }).n;
    expect(after, "参数不合法时不该留下一条没有依赖的工作项").toBe(before);
  });
});

describe("任务 1 · work_update 的 dependsOn(此前唯一能画边的工具是 work_create)", () => {
  it("在**既有**工作项上改依赖边,work_read 立刻看到新边(真机事故里做不到的事)", () => {
    const report = mkWork({ title: "调研报告整合与撰写" });
    const oldComparison = mkWork({ title: "三段式 vs omni 综合对比(旧)" });
    const newComparison = mkWork({ title: "三段式 vs omni 综合对比(新)" });
    // 起初指向旧的那一份 —— 复现真机数据里的悬空形状
    expect(setWorkDeps(db, report, [oldComparison]).ok).toBe(true);

    okText(callPm("work_update", { workId: report, dependsOn: [newComparison] }));
    expect(sorted(listDeps(db, report))).toEqual([newComparison]);

    const read = okText(callPm("work_read", { workId: report }));
    expect(read).toContain(newComparison);
    expect(read).not.toContain(oldComparison);
  });

  it("dependsOn: [] 把悬空边清掉", () => {
    const w = mkWork(), a = mkWork();
    setWorkDeps(db, w, [a]);
    okText(callPm("work_update", { workId: w, dependsOn: [] }));
    expect(listDeps(db, w)).toEqual([]);
  });

  it("只改依赖不改状态是合法的(状态保持原样)", () => {
    const w = mkWork({ status: "in_progress" }), a = mkWork();
    const text = okText(callPm("work_update", { workId: w, dependsOn: [a] }));
    expect(text).toContain("依赖已整体替换");
    expect(getWork(db, w)?.status).toBe("in_progress");
  });

  it("只改状态不改依赖也是合法的(依赖不动)", () => {
    const w = mkWork(), a = mkWork();
    setWorkDeps(db, w, [a]);
    okText(callPm("work_update", { workId: w, status: "in_progress" }));
    expect(listDeps(db, w)).toEqual([a]);
  });

  it("两个都不给 → invalid_args(不是静默成功)", () => {
    const w = mkWork();
    const e = errOf(callPm("work_update", { workId: w }));
    expect(e.code).toBe("invalid_args");
    expect(e.message).toContain("至少");
  });

  it("dependsOn 给了字符串(忘了包数组)→ 拒绝,**不静默当成「没提供」**", () => {
    const w = mkWork(), a = mkWork();
    const e = errOf(callPm("work_update", { workId: w, dependsOn: a }));
    expect(e.code).toBe("invalid_args");
    expect(e.message).toContain("字符串数组");
  });

  it("dependsOn: [123] → 拒绝,不静默过滤掉非字符串元素", () => {
    const w = mkWork();
    const e = errOf(callPm("work_update", { workId: w, dependsOn: [123] }));
    expect(e.code).toBe("invalid_args");
  });

  it("依赖非法时**状态也不落库**(不留「依赖没改、状态改了」的半成品)", () => {
    const w = mkWork(), a = mkWork();
    // a 依赖 w,于是 w 依赖 a 会成环
    setWorkDeps(db, a, [w]);
    const e = errOf(callPm("work_update", { workId: w, status: "done", dependsOn: [a] }));
    expect(e.code).toBe("conflict");
    expect(getWork(db, w)?.status, "状态一个字节都没动").toBe("open");
    expect(listDeps(db, w)).toEqual([]);
    expect(pendingKinds(), "也不该留下 done 的 outbox 事件").toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
// 任务 1.2 · 取消有后继 → 非阻塞警告(不是拒绝)
// ══════════════════════════════════════════════════════════════════

describe("任务 1.2 · 取消一个有后继依赖的工作项", () => {
  it("**是警告不是拒绝**:取消照样生效,文本里列出后继工作项 id", () => {
    const upstream = mkWork({ title: "三段式 vs omni 综合对比" });
    const downstream = mkWork({ title: "调研报告整合与撰写" });
    setWorkDeps(db, downstream, [upstream]);
    expect(listDependents(db, upstream)).toEqual([downstream]);

    const text = okText(callPm("work_update", { workId: upstream, status: "cancelled" }));

    expect(text, "取消必须真的生效").toContain(`工作项 ${upstream} → cancelled`);
    expect(getWork(db, upstream)?.status).toBe("cancelled");
    expect(text, "必须警告").toContain("非阻塞警告");
    expect(text, "必须列出后继 id").toContain(downstream);
    expect(text).toContain("调研报告整合与撰写");
  });

  it("警告里点出「改依赖不需要取消+新建」—— 真机事故里缺的正是这一句", () => {
    const upstream = mkWork();
    const downstream = mkWork();
    setWorkDeps(db, downstream, [upstream]);
    const text = okText(callPm("work_update", { workId: upstream, status: "cancelled" }));
    expect(text).toContain("dependsOn");
    expect(text).toContain("不需要「取消旧的 + 新建一份」");
  });

  it("没有后继时不吓人:不出现警告", () => {
    const w = mkWork();
    const text = okText(callPm("work_update", { workId: w, status: "cancelled" }));
    expect(text).not.toContain("非阻塞警告");
  });

  it("取消**中间**工作项时同样给警告(位置不影响这条警告)", () => {
    // ⚠️ 夹具改过一次(2026-10-06):原来把 `leaf` 建成 `mid` 的**子项**、再让
    // `leaf` 依赖 `mid` —— 那是「子等父」,现在是**被拒绝**的形状(父要等子项收口
    // 才完成 ⇒ 那条活永远开不了工,`setWorkDeps` 会以 reason=ancestor 拒绝,
    // 于是这个用例的边根本没画上,警告也就不会出现)。要测的是「有后继依赖」,
    // 那就用合法的形状:两条平级工作项之间一条前置。
    const root = mkWork();
    const mid = mkWork({ parentWorkId: root });
    const leaf = mkWork({ parentWorkId: root });
    const applied = setWorkDeps(db, leaf, [mid]);
    expect(applied.ok, "夹具本身必须是合法的依赖").toBe(true);
    const text = okText(callPm("work_update", { workId: mid, status: "cancelled" }));
    expect(text).toContain("非阻塞警告");
    expect(text).toContain(leaf);
  });
});

// ══════════════════════════════════════════════════════════════════
// 任务 2 · 状态迁移表落进唯一写口
// ══════════════════════════════════════════════════════════════════

describe("任务 2 · WORK_TRANSITIONS 表本身", () => {
  it("闭集与表一一对应(没有状态被漏掉)", () => {
    expect(Object.keys(WORK_TRANSITIONS).sort()).toEqual([...WORK_STATUSES].sort());
  });

  it("三个非终态互通,且都能直接到任一终态", () => {
    const nonTerminal: WorkStatus[] = ["open", "in_progress", "blocked"];
    for (const from of nonTerminal) {
      for (const to of WORK_STATUSES) {
        expect(isWorkTransitionAllowed(from, to), `${from} → ${to}`).toBe(true);
      }
    }
  });

  it("**cancelled 是真终态:零出边**", () => {
    expect(WORK_TRANSITIONS["cancelled"]).toEqual([]);
    expect(nextWorkStatuses("cancelled")).toEqual([]);
    for (const to of WORK_STATUSES) {
      if (to === "cancelled") continue;
      expect(isWorkTransitionAllowed("cancelled", to), `cancelled → ${to} 必须被拒`).toBe(false);
    }
  });

  it("裁决①:done → in_progress 允许(审查后退回重做)", () => {
    expect(isWorkTransitionAllowed("done", "in_progress")).toBe(true);
  });

  it("failed → in_progress 允许(重试;failed 不在任何待办里,这是它唯一的复活路径)", () => {
    expect(isWorkTransitionAllowed("failed", "in_progress")).toBe(true);
  });

  it("终态里除 in_progress 之外的出边都被拒(不留「复活」的口子)", () => {
    expect(isWorkTransitionAllowed("done", "open")).toBe(false);
    expect(isWorkTransitionAllowed("done", "done")).toBe(true); // 同状态 = 幂等空操作
    expect(isWorkTransitionAllowed("failed", "open")).toBe(false);
    // ⚠️ **`failed → cancelled` 现在是允许的(2026-10-06 真机现场改判)**。
    //
    // 这一条原来断言 `false`,而它把**两件不同的事**混成了一件:
    //   · **复活**(`failed → in_progress`):让一条失败的活原样再跑一次。
    //     一直允许,而且一直该谨慎(真机那条重跑会同样超时)。
    //   · **退役**(`failed → cancelled`):把一条**已被重新规划取代**的失败
    //     工作项标成「不做了」。它走��的是**另一个终态**,没有复活任何东西。
    //
    // 只留复活那条边时,一个真实的坑就形成了:项目经理把一条超时的工作项拆成
    // 更窄的几条、活也干完了,而**旧的 `failed` 出不来** —— 它永远停在
    // `failed`,于是任何「看到 failed 就重新划范围」的规则都会一直叫到预算用尽,
    // 而项目经理**做完了正事却收不了尾**。
    //
    // ⇒ 判据不是「终态不许出去」,是「**终态不许被复活**」:
    // `cancelled` 零出边(仍是真终态、不可复活),`done` 只能回 `in_progress`。
    expect(isWorkTransitionAllowed("failed", "cancelled")).toBe(true);
    // ⚠️ 退役之后**不能复活** —— `cancelled` 的零出边就是这一条
    expect(isWorkTransitionAllowed("cancelled", "in_progress")).toBe(false);
  });

  it("同状态一律放行(幂等空操作,不算迁移)", () => {
    for (const s of WORK_STATUSES) expect(isWorkTransitionAllowed(s, s)).toBe(true);
  });
});

describe("任务 2 · 写口判定(updateWorkStatus 是唯一写口)", () => {
  it("非法迁移返回结构化原因 + 回灌合法下一跳,**不抛**", () => {
    const w = mkWork();
    updateWorkStatus(db, w, "cancelled", T0 + 1);
    const r = updateWorkStatus(db, w, "open", T0 + 2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("illegal_transition");
    expect(r.from).toBe("cancelled");
    expect(r.allowed).toEqual([]);
    expect(getWork(db, w)?.status, "被拒时状态不变").toBe("cancelled");
  });

  it("not_found 也是结构化失败(不是静默 no-op)", () => {
    const r = updateWorkStatus(db, "wk_ghost", "done", T0 + 1);
    expect(r).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("checkWorkTransition 与写口用同一条规则(纯判定,不写库)", () => {
    const w = mkWork();
    expect(checkWorkTransition(w, "open", "done").ok).toBe(true);
    updateWorkStatus(db, w, "done", T0 + 1);
    const check = checkWorkTransition(w, "done", "cancelled");
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.allowed).toEqual(["in_progress"]);
    expect(getWork(db, w)?.status, "纯判定不改库").toBe("done");
  });

  it("同状态不算迁移:幂等成功,且不产生第二条事件", () => {
    const w = mkWork();
    updateWorkStatus(db, w, "done", T0 + 1);
    const r = updateWorkStatus(db, w, "done", T0 + 2);
    expect(r).toMatchObject({ ok: true, changed: false });
    expect(pendingKinds()).toEqual(["work_done"]);
  });

  it("report 走同一个写口 —— 同一张迁移表约束它(§2.7 说两个工具都能传任意值)", () => {
    const w = mkWork();
    updateWorkStatus(db, w, "cancelled", T0 + 1);
    const e = errOf(callPm("report", { workId: w, summary: "想复活", status: "in_progress" }));
    expect(e.code).toBe("conflict");
    expect(e.message).toContain("终态");
    expect(getWork(db, w)?.status).toBe("cancelled");
  });

  it("report 不带 status 时不碰状态(纯记录)", () => {
    const w = mkWork();
    const text = okText(callPm("report", { workId: w, summary: "进展" }));
    expect(text).toContain("已记录");
    expect(getWork(db, w)?.status).toBe("open");
  });
});

describe("任务 2 · 现有合法路径一条都没被挡死(逐条对真实调用方)", () => {
  const REAL_PATHS: ReadonlyArray<[WorkStatus, WorkStatus, string]> = [
    ["open", "in_progress", "runWorkItem 自动开工(execution.ts)"],
    ["in_progress", "blocked", "worker 登记阻塞"],
    ["blocked", "in_progress", "阻塞解除、重跑(checkRunnable 允许 blocked)"],
    ["blocked", "open", "放回队列"],
    ["open", "done", "一次回合之内跑完(storage.test 的既定形状)"],
    ["in_progress", "done", "正常完成"],
    ["in_progress", "failed", "失败"],
    ["in_progress", "cancelled", "范围不要了"],
    ["open", "failed", "直接失败"],
    ["open", "cancelled", "立项后发现不该做"],
    ["blocked", "failed", "阻塞无法解决"],
    ["done", "in_progress", "审查后打回重做(dispatcher.test 的既定形状)"],
    ["failed", "in_progress", "重试"],
  ];
  for (const [from, to, why] of REAL_PATHS) {
    it(`${from} → ${to} 允许(${why})`, () => {
      const w = mkWork();
      if (from !== "open") updateWorkStatus(db, w, from, T0 + 1);
      const r = updateWorkStatus(db, w, to, T0 + 2);
      expect(r.ok, `${from} → ${to} 被挡住了`).toBe(true);
      expect(getWork(db, w)?.status).toBe(to);
    });
  }
});

describe("任务 2 · 保留原实现的两条不变量", () => {
  it("迁入 done → review_state = pending", () => {
    const w = mkWork();
    updateWorkStatus(db, w, "done", T0 + 1);
    expect(getWork(db, w)?.reviewState).toBe("pending");
  });

  it("迁出 done → review_state = none(裁决①允许的代价的一半已经做对了)", () => {
    const w = mkWork();
    updateWorkStatus(db, w, "done", T0 + 1);
    updateWorkStatus(db, w, "in_progress", T0 + 2);
    expect(getWork(db, w)?.reviewState).toBe("none");
  });

  it("同状态的 done 写不会把已审的产出打回等审", () => {
    const w = mkWork();
    updateWorkStatus(db, w, "done", T0 + 1);
    db.prepare(`UPDATE works SET review_state = 'done' WHERE id = ?`).run(w);
    updateWorkStatus(db, w, "done", T0 + 2);
    expect(getWork(db, w)?.reviewState).toBe("done");
  });
});

// ══════════════════════════════════════════════════════════════════
// 任务 3 · outbox 写入侧收紧(用户抱怨的「一长串」)
// ══════════════════════════════════════════════════════════════════

describe("任务 3 · 可打扰判据在**写入侧**", () => {
  it("**中间工作项完成 → 不写进度流水**:5 次完成只换来 1 条可打扰事件(而且是里程碑)", () => {
    // ⚠️ 用 5 个子项:只有 1 个子项时,它的完成**就是**里程碑(全部后代终态),
    //    那一条是设计要的,不是流水。
    const root = mkWork({ title: "根" });
    const kids = [1, 2, 3, 4, 5].map((i) => mkWork({ parentWorkId: root, title: `子${i}` }));
    for (const k of kids.slice(0, 4)) updateWorkStatus(db, k, "done", T0 + 10);
    expect(totalEventRows(), "4 条中间完成 → 0 行 outbox(旧行为是 4 行)").toBe(0);

    updateWorkStatus(db, kids[4]!, "done", T0 + 11);
    const evs = listPendingDispatchEvents(db, "p1");
    expect(evs, "5 次完成 → 总共 1 行").toHaveLength(1);
    expect(evs[0]?.subjectId, "而且是里程碑(指向根),不是「子5 已完成」").toBe(root);
  });

  it("根工作项完成 → 写一行", () => {
    const root = mkWork({ title: "根" });
    updateWorkStatus(db, root, "done", T0 + 1);
    expect(pendingKinds()).toEqual(["work_done"]);
    expect(listPendingDispatchEvents(db, "p1")[0]?.summary).toContain("根");
  });

  it("中间工作项 blocked → 不写;根 blocked → 写(criterion 是 parent_work_id IS NOT NULL)", () => {
    const root = mkWork();
    const kid = mkWork({ parentWorkId: root });
    updateWorkStatus(db, kid, "blocked", T0 + 1);
    expect(totalEventRows()).toBe(0);
    updateWorkStatus(db, root, "blocked", T0 + 2);
    expect(pendingKinds()).toEqual(["work_blocked"]);
  });

  it("中间工作项 **failed → 照写**(失败与树的位置无关,它需要有人介入)", () => {
    // 两个子项:fail 掉一个还不构成里程碑,所以这一行只可能是它自己那条 work_failed
    const root = mkWork();
    const kid = mkWork({ parentWorkId: root, title: "子A" });
    mkWork({ parentWorkId: root, title: "子B" });
    updateWorkStatus(db, kid, "failed", T0 + 1);
    expect(pendingKinds()).toEqual(["work_failed"]);
    expect(listPendingDispatchEvents(db, "p1")[0]?.summary).toContain("失败");
  });

  it("根 failed 只写一条(不因为它既是根又是 failed 就翻倍)", () => {
    const root = mkWork();
    updateWorkStatus(db, root, "failed", T0 + 1);
    expect(pendingKinds()).toEqual(["work_failed"]);
  });
});

describe("任务 3 · 里程碑(某根工作项全部后代终态)", () => {
  it("最后一个后代终结 → 写一条**指向根**的事件", () => {
    const root = mkWork({ title: "调研阶段" });
    const c1 = mkWork({ parentWorkId: root, title: "子1" });
    const c2 = mkWork({ parentWorkId: root, title: "子2" });
    updateWorkStatus(db, c1, "done", T0 + 1);
    expect(totalEventRows(), "还没全部收口,不写").toBe(0);
    updateWorkStatus(db, c2, "done", T0 + 2);
    const evs = listPendingDispatchEvents(db, "p1");
    expect(evs).toHaveLength(1);
    expect(evs[0]?.kind).toBe("work_done");
    expect(evs[0]?.subjectId, "主体是**根**,不是刚完成的那条子项").toBe(root);
    expect(evs[0]?.summary).toContain("里程碑");
    expect(evs[0]?.summary).toContain("调研阶段");
    expect(evs[0]?.summary).toContain("完成 2");
  });

  it("里程碑只写一次(不会每来一条终态就再写一遍)", () => {
    const root = mkWork();
    const c1 = mkWork({ parentWorkId: root });
    const c2 = mkWork({ parentWorkId: root });
    const c3 = mkWork({ parentWorkId: root });
    updateWorkStatus(db, c1, "done", T0 + 1);
    updateWorkStatus(db, c2, "done", T0 + 2);
    updateWorkStatus(db, c3, "done", T0 + 3); // 这一刻达到里程碑
    expect(totalEventRows()).toBe(1);
    updateWorkStatus(db, c1, "in_progress", T0 + 4); // 打回重做 → 不再是「全部收口」
    expect(totalEventRows()).toBe(1);
    updateWorkStatus(db, c1, "done", T0 + 5); // 再次收口 → 再写一条(这是真的又收口了一次)
    expect(totalEventRows()).toBe(2);
  });

  it("取消也是终态:后代全部**取消**同样构成里程碑(下游悬空要被看见)", () => {
    const root = mkWork({ title: "根" });
    const c1 = mkWork({ parentWorkId: root });
    const c2 = mkWork({ parentWorkId: root });
    updateWorkStatus(db, c1, "cancelled", T0 + 1);
    updateWorkStatus(db, c2, "cancelled", T0 + 2);
    const evs = listPendingDispatchEvents(db, "p1");
    expect(evs).toHaveLength(1);
    expect(evs[0]?.summary).toContain("取消 2");
  });

  it("根**自己**已经终态时不再补发里程碑(它的终态已经是一条事件)", () => {
    const root = mkWork();
    const c1 = mkWork({ parentWorkId: root });
    const c2 = mkWork({ parentWorkId: root });
    updateWorkStatus(db, root, "done", T0 + 1); // 根先收
    updateWorkStatus(db, c1, "done", T0 + 2);
    updateWorkStatus(db, c2, "done", T0 + 3);
    expect(totalEventRows(), "只有根那一行").toBe(1);
    expect(listPendingDispatchEvents(db, "p1")[0]?.subjectId).toBe(root);
  });

  it("三层树:最深那条收口 → 里程碑指向最外层的根", () => {
    const root = mkWork({ title: "最外层" });
    const mid = mkWork({ parentWorkId: root });
    const leaf = mkWork({ parentWorkId: mid });
    updateWorkStatus(db, mid, "done", T0 + 1); // mid 完成但 leaf 还没 → 不算收口
    expect(totalEventRows()).toBe(0);
    updateWorkStatus(db, leaf, "done", T0 + 2);
    const evs = listPendingDispatchEvents(db, "p1");
    expect(evs).toHaveLength(1);
    expect(evs[0]?.subjectId).toBe(root);
  });
});

/**
 * ⚠️ 这一节的**推理在 Wave 2 被修正了一半**,如实记在这里:
 *
 *   - Wave 1 的结论「不能收在判定侧」**只在「不可打扰的事件仍然进库」时成立**。
 *     写入侧收紧之后它们大多根本不进库 ⇒ 库里剩下的每一行都值得交代,全量消费
 *     不再是缺陷。
 *   - 但**扁平结构**(真机库 9 work / 9 root / 0 中间)下写入侧几乎筛不掉东西 ⇒
 *     「每条终态都叫醒一次」这件事仍然要修,而它只能修在**判定侧**。
 *   - 判定侧新收窄的是**时机**(合并唤醒:N 条 / T 分钟),**不是资格** ——
 *     它不按 kind / 位置丢掉任何一行。所以下面这两条不变:
 *       ① 进库的行数由写入侧决定(第一节);
 *       ② 判定侧看到几行就报几行,不额外过滤(第二条断言的后半段)。
 */
describe("任务 3 · 写入侧收紧 vs 判定侧时机收窄(Wave 2 修正了归因)", () => {
  it("一次消费**不会**顺带交代一串不可打扰事件 —— 因为那一串根本没进库", () => {
    const root = mkWork();
    const kids = [1, 2, 3].map(() => mkWork({ parentWorkId: root }));
    for (const k of kids) updateWorkStatus(db, k, "done", T0 + 1);
    updateWorkStatus(db, root, "done", T0 + 2);
    // 4 次终态迁移(3 个子项 + 根)→ 库里 2 行(1 里程碑 + 1 根)。
    // 旧行为是 4 行,而消费一次会把那 4 行**全部**标记成已交代 —— consumed_at 撒谎。
    expect(totalEventRows()).toBe(2);
    const n = db
      .prepare(`UPDATE dispatch_events SET consumed_at = ?, consumed_by = 'bm'
                WHERE project_id = 'p1' AND consumed_at IS NULL`)
      .run(T0 + 3).changes;
    expect(n, "被交代的正好是库里那 2 行,没有多也没有少").toBe(2);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM dispatch_events WHERE consumed_at IS NULL`)
        .get() as { n: number }).n,
      "没有任何一行被「顺手」标记成已交代",
    ).toBe(0);
  });

  it("collectTodos:中间完成**连事件都没有**;根完成写一条,但叫醒要过合并窗口", () => {
    // 两个子项:完成一个**不等于**全部收口,所以不该产生任何事件
    const root = mkWork();
    const kid = mkWork({ parentWorkId: root });
    mkWork({ parentWorkId: root });
    // ⚠️ 「合并唤醒」开着缺省窗口时,**一条**事件不会生成待办(N=3 / T=5 分钟)。
    //    所以下面用 `reportBatchSize: 1` 只回答「写侧留了哪些行、它们会不会
    //    被判定侧过滤掉」——「一条事件要不要叫醒」由 dispatcher.test.ts 的
    //    `任务 5 · 合并唤醒` 专门钉。判定侧**不**按 kind/位置过滤任何一行。
    const NOW_COALESCE = { reportBatchSize: 1 };
    const hasReport = () =>
      collectTodos({ db, projectId: "p1", now: T0 + 100, ...NOW_COALESCE }).runnable
        .some((t) => t.kind === "report_downstream");
    expect(hasReport()).toBe(false);
    updateWorkStatus(db, kid, "done", T0 + 1);
    expect(hasReport(), "中间完成不写事件 ⇒ 也不该叫醒业务经理").toBe(false);
    expect(listPendingDispatchEvents(db, "p1"), "中间完成连一行都没有").toEqual([]);
    updateWorkStatus(db, root, "done", T0 + 2);
    expect(listPendingDispatchEvents(db, "p1"), "根完成才写这一条").toHaveLength(1);
    expect(hasReport(), "写侧留了行 → 判定侧就该把它变成待办").toBe(true);
  });
});

describe("任务 3 · blocker_opened 按 severity 判(high/critical 才打扰)", () => {
  const mkBlocker = (id: string, severity: "low" | "medium" | "high" | "critical") =>
    insertBlocker(db, {
      id, projectId: "p1", raisedByAgentId: "wk", title: `阻塞-${id}`, detail: "d",
      severity, status: "open", createdAt: T0,
    });

  it("high / critical → 写", () => {
    mkBlocker("b_high", "high");
    mkBlocker("b_crit", "critical");
    expect(sorted(pendingKinds())).toEqual(["blocker_opened", "blocker_opened"]);
  });

  it("low / medium → **不写** outbox(但阻塞行照样在库里)", () => {
    mkBlocker("b_low", "low");
    mkBlocker("b_med", "medium");
    expect(listPendingDispatchEvents(db, "p1")).toEqual([]);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM blockers`).get() as { n: number }).n,
      "不写 outbox 不等于没登记阻塞",
    ).toBe(2);
  });

  it("阻断方向是 at-least-once:阻塞行查不到时**放行**(宁可多写一条)", () => {
    // 直接往 outbox 写一条 subject 不存在的 blocker_opened —— 不静默丢
    const n = db
      .prepare(`INSERT INTO dispatch_events (project_id, kind, subject_id, summary, created_at,
                                            consumed_at, consumed_by)
                VALUES ('p1', 'blocker_opened', 'b_ghost', 's', ?, NULL, NULL)`)
      .run(T0).changes;
    expect(n).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
// 任务 4 · cancelled 写 outbox(migration 015 已放宽 CHECK)
// ══════════════════════════════════════════════════════════════════

describe("任务 4 · cancelled 进写入侧", () => {
  it("根 cancelled **判定为可打扰**;schema 落后(015 之前)时如实报成 deferred", () => {
    // 015 已落地 —— 「schema 落后于代码」不会自己发生了,所以显式把
    // dispatch_events 退回 013 的 4 值闭集,这条降级路径才**有牙**。
    simulatePreMigration015();
    const w = mkWork({ title: "这块不要了" });
    const r = updateWorkStatus(db, w, "cancelled", T0 + 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    expect(r.announced, "没写进去,所以 announced = 0").toBe(0);
    expect(r.deferred).toHaveLength(1);
    expect(r.deferred[0]?.kind).toBe("work_cancelled");
    expect(r.deferred[0]?.needsMigration).toBe(DISPATCH_EVENT_KIND_MIGRATION["work_cancelled"]);
    expect(r.deferred[0]?.detail).toContain("work_cancelled");
    expect(r.deferred[0]?.detail).toContain("没有落库");
    // 状态本身照样改了(取消是合法路径,schema 落后不该挡住它)
    expect(getWork(db, w)?.status).toBe("cancelled");
  });

  it("工具层把这件事**说出来**,不静默(schema 落后时的 work_update 返回文本)", () => {
    simulatePreMigration015();
    const w = mkWork();
    const text = okText(callPm("work_update", { workId: w, status: "cancelled" }));
    expect(text).toContain("没有落库");
    expect(text).toContain("work_cancelled");
  });

  it("中间 cancelled → 判定为**不可打扰**:连 deferred 都没有", () => {
    const root = mkWork();
    const kid = mkWork({ parentWorkId: root });
    mkWork({ parentWorkId: root }); // 还有一个没终态的子项,所以不成里程碑
    const r = updateWorkStatus(db, kid, "cancelled", T0 + 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.announced).toBe(0);
    expect(r.deferred).toEqual([]);
    expect(getWork(db, kid)?.status, "状态照样改").toBe("cancelled");
  });

  it("**015 之后(真迁移,不是模拟),同一条取消就落库了** —— deferred 与那句提示都消失", () => {
    // 这里**不再**手工重建:015 已经是真迁移,由 beforeEach 的
    // openPlatformMemoryDb() 经迁移器应用。断言因此更强 —— 它验的是真 schema。
    const w = mkWork({ title: "取消后该被交代" });
    const r = updateWorkStatus(db, w, "cancelled", T0 + 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.deferred, "schema 允许了,就不该再有 deferred").toEqual([]);
    expect(r.announced).toBe(1);
    const evs = listPendingDispatchEvents(db, "p1");
    expect(evs.map((e) => e.kind)).toEqual(["work_cancelled"]);
    expect(evs[0]?.summary).toContain("取消");
    // 工具层的同一段文本里,那句「没有落库」必须**消失**(核心判据)
    const w2 = mkWork({ title: "第二条取消" });
    const text = okText(callPm("work_update", { workId: w2, status: "cancelled" }));
    expect(text).not.toContain("没有落库");
  });

  it("里程碑事件用的是既有 kind —— 因此 015 之前也能落库(不会被 CHECK 挡)", () => {
    const root = mkWork();
    const c1 = mkWork({ parentWorkId: root });
    const c2 = mkWork({ parentWorkId: root });
    updateWorkStatus(db, c1, "cancelled", T0 + 1);
    const r = updateWorkStatus(db, c2, "cancelled", T0 + 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.deferred).toEqual([]);
    expect(pendingKinds()).toEqual(["work_done"]);
  });
});

// ══════════════════════════════════════════════════════════════════
// 真机事故的完整复现(三条改动合在一起才修得掉)
// ══════════════════════════════════════════════════════════════════

describe("真机事故复现:取消旧项 + 新建同名项 + 下游指向被取消的那份", () => {
  it("现在可以**直接把边指过去**,不需要再取消+新建第二次", () => {
    const comparisonOld = mkWork({ title: "三段式 vs omni 综合对比与替代路径分析" });
    const reportOld = mkWork({ title: "调研报告整合与撰写" });
    setWorkDeps(db, reportOld, [comparisonOld]);

    // ① 取消旧对比 → 得到警告,知道 reportOld 还指着它
    const warn = okText(callPm("work_update", { workId: comparisonOld, status: "cancelled" }));
    expect(warn).toContain("非阻塞警告");
    expect(warn).toContain(reportOld);

    // ② 新建一份对比(同名 —— 真机数据就是这样)
    okText(callPm("work_create", {
      title: "三段式 vs omni 综合对比与替代路径分析",
      goal: "重做对比",
      assigneeRole: "worker", assigneeSpec: "engineering",
    }));
    const comparisonNew = (db.prepare(
      `SELECT id FROM works WHERE title LIKE '三段式 vs omni%' AND status = 'open'`,
    ).get() as { id: string }).id;

    // ③ 把 reportOld 的边指向**新的那一份** —— 这一步此前做不到
    okText(callPm("work_update", { workId: reportOld, dependsOn: [comparisonNew] }));
    expect(listDeps(db, reportOld)).toEqual([comparisonNew]);

    // ④ 悬空边没了:没有任何一条边指向 cancelled 的前置(真机数据里有)
    const dangling = db.prepare(
      `SELECT d.work_id FROM work_deps d JOIN works w ON w.id = d.depends_on_work_id
       WHERE w.status = 'cancelled'`,
    ).all();
    expect(dangling).toEqual([]);
  });
});

// ── 任务 5(2026-10-06)· 环检测的方向必须与「先后」一致 ─────────────
//
// 「先后」的定义(与前端分层图同一份):前置先、本条后;子先、父后(容器由子项推动)。
// 于是三种组合里**只有一种有害**:
//
//   `P depends_on C`(父等子)⇒ 子本来就先于父 ⇒ 无害(冗余)⇒ **放行**
//   `C depends_on P`(子等父)⇒ 成环,而且在 `depsSatisfied` 里是**死锁**
//                              (父要等子项全收口才 done,子却要等父 done)⇒ **拦**
//   兄弟之间 ⇒ 正常排期 ⇒ **放行**
//
// ⚠️ 这条判据的第一版**写反了**:它沿「我依赖谁 + 我的父」走,于是把无害的
// 「父等子」拦掉,却放过了真正会死锁的「子等父」。真机库里那条
// `khu depends_on kv0`(父等子,无害)就是被它误判成环的 —— 而「dag 完全是乱的」
// 的真因是**前端把父边的方向画反了**,不是数据有环。
describe("任务 5 · 环检测的方向必须与「先后」一致", () => {
  const mk = (id: string, parent: string | null = null): void => {
    insertWork(db, {
      id, projectId: "p1", parentWorkId: parent, title: id, goal: "g", status: "open",
      assigneeAgentId: "wk", createdAt: T0, updatedAt: T0,
    });
  };

  it("✅ 真机那条边:父项 `depends_on` 自己的子项 ⇒ **放行**(子本来就先于父)", () => {
    mk("khu");
    mk("kv0", "khu");
    expect(createsCycle(db, "khu", "kv0"), "父等子不是环").toBe(false);
    expect(addDep(db, "khu", "kv0").ok, "冗余但无害,不该拦").toBe(true);
    expect(listDeps(db, "khu")).toEqual(["kv0"]);
  });

  it("⛔ 子项 `depends_on` 自己的父项 ⇒ 拦(它会变成一条永远开不了工的活)", () => {
    mk("khu");
    mk("kv0", "khu");
    expect(createsCycle(db, "kv0", "khu"), "子等父 = 成环 + 死锁").toBe(true);
    const r = addDep(db, "kv0", "khu");
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.reason : null).toBe("cycle");
    // 负样本:真的**一个字节都没写**
    expect(listDeps(db, "kv0")).toEqual([]);
  });

  it("⛔ 沿着**父链**多跳也算:孙项等祖父 ⇒ 拦", () => {
    mk("khu");
    mk("mid", "khu");
    mk("leaf", "mid");
    expect(createsCycle(db, "leaf", "khu"), "leaf 先于 mid 先于 khu ⇒ 反向").toBe(true);
    expect(createsCycle(db, "mid", "khu")).toBe(true);
    // 负样本:反过来(祖父等孙项)无害
    expect(createsCycle(db, "khu", "leaf")).toBe(false);
  });

  it("✅ 兄弟之间的前置**照常放行**(判据不能严到把正常排期也拦掉)", () => {
    mk("khu");
    mk("b", "khu");
    mk("a", "khu");
    expect(addDep(db, "a", "b").ok, "同层兄弟之间的依赖是正常的").toBe(true);
    expect(listDeps(db, "a")).toEqual(["b"]);
    // 负样本:**两条都加**就是纯前置环(不是「换个先后」),必须拦住
    const back = addDep(db, "b", "a");
    expect(back.ok).toBe(false);
    expect(back.ok === false ? back.reason : null).toBe("cycle");
  });

  it("⛔ 纯前置环仍然拦得住(原有行为不许退化)", () => {
    mk("a");
    mk("b");
    expect(addDep(db, "a", "b").ok).toBe(true);
    const r = addDep(db, "b", "a");
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.reason : null).toBe("cycle");
  });

  it("⛔ 拒绝的原因要**说得出口**:子等父报 `ancestor` 并点明「会永远开不了工」", () => {
    const root = mkWork();
    const child = mkWork({ parentWorkId: root });
    const r = setWorkDeps(db, child, [root]);
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.reason : null).toBe("ancestor");
    expect(r.ok === false ? r.message : "").toContain("死锁");
    expect(r.ok === false ? r.message : "").toContain("永远开不了工");
    expect(r.ok === false ? r.message : "").toContain("一个字节都没写");
    // 负样本:普通环报的仍是 cycle(两种原因不许混成一句话)
    const a = mkWork();
    const b = mkWork();
    db.prepare(`INSERT INTO work_deps (work_id, depends_on_work_id) VALUES (?, ?)`).run(a, b);
    const cyc = setWorkDeps(db, b, [a]);
    expect(cyc.ok === false ? cyc.reason : null).toBe("cycle");
  });

  it("⚠️ 存量数据不自动修:库里已有的边照实读出来,新写入才受判据约束", () => {
    mk("khu");
    mk("kv0", "khu");
    db.prepare(`INSERT INTO work_deps (work_id, depends_on_work_id) VALUES (?, ?)`).run("kv0", "khu");
    expect(listDeps(db, "kv0"), "存量边照实读出").toEqual(["khu"]);
    expect(createsCycle(db, "kv0", "khu"), "而新的同样一条会被拦").toBe(true);
  });
});
