/**
 * 排空器 · 规则表与 nudge 接线(B1 + B2 的验收,设计 1 §2.11.4 / §2.12)
 *
 * ── 这个文件为什么单独存在 ──────────────────────────────────────
 *
 * B1(8 个分支 → 规则表)的验收判据是「**行为完全不变**」,而它的守门人是
 * `tests/platform/dispatcher.test.ts` —— 那个文件**一字不改**全绿就说明改对了。
 * 所以这里不再重复它的用例,只钉三件**它测不到**的事:
 *
 *   ① **规则表本身是闭合的**:规则恰好覆盖 `TodoKind` 的每一个取值,
 *      没有哪个 kind 还留在表外的分支里;每条 `on` 都含 `tick`(漏了它,
 *      「重启后补跑」那条性质就断了)。
 *   ② **纯度回归**(§2.12 的 B2 验收判据):`collectTodos` 在**有事件 / 无事件**下
 *      输出相同。事件今天唯一的作用是把 `collectTodos` 再叫一次。
 *   ③ **B2 的接线**:`blackboard.write` 进了门铃清单,且 `board_write` 成功后
 *      门铃真的响一次 —— 但它**不改变判定**(响了之后看板逐字相同)。
 *
 * ②③ 合起来才是那一条纪律的完整形式:**事件只是 nudge,判定永远重新查库。**
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { getAgent } from "../../src/platform/storage/repo/agents.js";
import {
  insertProject, loadProjectForAuthz,
} from "../../src/platform/storage/repo/projects.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { insertWork } from "../../src/platform/storage/repo/works.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import {
  collectTodos, NUDGE_CAPABILITIES, RULES, TODO_KINDS, TRIGGERS,
} from "../../src/platform/runtime/dispatcher.js";
import { dispatch } from "../../src/platform/tools/registry.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";
import type { Agent } from "../../src/platform/harness/authorize.js";

let db: Database.Database;
let seq = 0;
const T0 = 1_700_000_000_000;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  insertProject(db, {
    id: "p1", name: "语音机器人调研", client: "甲方",
    goal: "给出三条技术路线的对比与选型建议", status: "active", createdAt: T0,
  });
  ensureProjectOrg(db, "p1", T0);
});
afterEach(() => db.close());

function mkWork(): string {
  const id = `wk_${++seq}`;
  insertWork(db, {
    id, projectId: "p1", parentWorkId: null, title: "调研路线 A", goal: "写出对比结论",
    status: "open", assigneeAgentId: "wk", createdAt: T0, updatedAt: T0,
  });
  return id;
}

function mkArtifact(id: string, body: string): void {
  insertArtifact(db, {
    id, projectId: "p1", conversationId: null,
    kind: "evidence", status: "open", authorAgentId: "wk",
    title: "路线 A 的实测数据", body, metadataJson: null,
    createdAt: T0 + 1, updatedAt: T0 + 1,
  });
}

/** 看板的可比快照:`(kind, key, agent, 预算)` 四样 —— 判定产出的全部信息都在里面。 */
const snapshot = (now = T0): string[] =>
  [...collectTodos({ db, projectId: "p1", now }).runnable]
    .map((t) => `${t.kind}|${t.key}|${t.agentId}|${t.attempts}`)
    .sort();

function ctxFor(agentId: string): ToolRunContext {
  const row = getAgent(db, agentId);
  if (row === null) throw new Error(`未知 agent ${agentId}`);
  const project = loadProjectForAuthz(db, "p1");
  if (project === null) throw new Error("项目 p1 读不出来");
  const agent: Agent = {
    id: row.id, role: row.role, displayName: row.displayName,
    ...(row.specialization !== null ? { specialization: row.specialization } : {}),
  };
  return { db, agent, project, now: () => T0, newId: (p) => `${p}_rules${++seq}` };
}

function sync(r: Promise<ToolResult> | ToolResult): ToolResult {
  if (r instanceof Promise) throw new Error("这个工具应当是同步的");
  return r;
}

// ── ① 规则表是闭合的 ────────────────────────────────────────────

describe("B1 · 规则表:每个 `TodoKind` 恰好一条规则(C3 之后是 10 条,丙③ 之后 11 条)", () => {
  it("`TodoKind` 的每个取值**恰好**有一条规则产出它 —— 没有分支留在表外", () => {
    const kinds = RULES.map((r) => r.then.kind);
    // B1 落地时是 8/8;C3 补了流水线缺的两环(`integrate` / `handover`);
    // 丙③ 补上第 11 条 `resolve_blocked_work`(一条 `blocked` 的工作项此前**没有
    // 任何驱动者** ⇒ 整个项目零待办的静默停摆)。
    // 这两个数字**同时**改是对的:集合相等那条断言才是闭合性本身。
    expect(RULES).toHaveLength(11);
    expect(TODO_KINDS).toHaveLength(11);
    // 集合相等 ⇒ 「表产出的 kind」与「闭集」是同一个集合
    expect([...kinds].sort()).toEqual([...TODO_KINDS].sort());
    // 且没有两条规则争同一个 kind(否则「谁负责这一条」没有答案)
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("id 唯一、why 与 on 都非空(`why` 是写给人读的现场)", () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of RULES) {
      expect(r.id.length, "规则没有 id").toBeGreaterThan(0);
      expect(r.why.length, `${r.id} 没有 why`).toBeGreaterThan(20);
      expect(r.on.length, `${r.id} 的 on 是空的`).toBeGreaterThan(0);
    }
  });

  it("**每条 `on` 都含 `tick`** —— 漏了它,「重启后补跑」那条性质就断了", () => {
    for (const r of RULES) {
      expect(r.on, `${r.id} 漏了 tick:纯查询下它是重启后补跑的唯一载体`).toContain("tick");
    }
  });

  it("`on` 里的每个取值都在闭合触发集里", () => {
    const closed = new Set<string>(TRIGGERS);
    for (const r of RULES) {
      for (const t of r.on) {
        expect(closed.has(t), `${r.id} 的 on 出现了闭合集外的触发「${t}」`).toBe(true);
      }
    }
  });

  it("**`artifact_inserted` 只被 C3 的两条新规则用**(B2 的纪律:事件不是判据)", () => {
    // B2 让产出工件去敲门铃,而**没有**让任何规则开始读工件 —— 所以当时这条断言
    // 写的是「`artifact_inserted` 不在任何规则的 `on` 里」。C3 的 `integrate` /
    // `handover` 是**唯一**计划内合法打破它的地方(B2 的注释里就预告了这一刻),
    // 所以这里改成钉**谁**用它:多一条规则都不许。
    //
    // 它守的仍然是同一条纪律:规则的 `if` 只许读工件的**结构化列**(kind /
    // `work_id` / status),不许读正文;而**判定永远重新查库** —— 门铃只是门铃。
    const usingArtifact = RULES.filter((r) => r.on.includes("artifact_inserted")).map((r) => r.id);
    expect(usingArtifact.sort()).toEqual(["handover_deliverable", "integrate_reviewed_subtree"]);
    const used = new Set<string>(RULES.flatMap((r) => [...r.on]));
    expect([...used].sort()).toEqual([
      "artifact_inserted", "ask_answered", "ask_opened", "change_decided",
      "meeting_concluded", "tick", "work_status_changed",
    ]);
  });
});

// ── ② 纯度回归:有事件 / 无事件,输出相同 ────────────────────────

describe("B2 · 纯度回归:`collectTodos` 在有事件 / 无事件下输出相同", () => {
  it("正样本自检:看板非空(否则下面的「相同」没有任何信息量)", () => {
    mkWork();
    const s = snapshot();
    expect(s.length).toBeGreaterThan(0);
    expect(s.some((x) => x.includes("execute_work"))).toBe(true);
  });

  it("**一件工件落库(= 产出工件那次事件)不改变看板** —— 判定全部从库里重算", () => {
    mkWork();
    const before = snapshot();
    // 「刚才产出了一个工件」正是 B2 让门铃响的那件事;它是一行**库里的新事实**
    mkArtifact("art_1", "实测:路线 A 的延迟 120ms");
    expect(snapshot()).toEqual(before);
  });

  it("连**正文**都不参与判定:同样的结构化列、不同的 `body`,看板逐字相同", () => {
    mkWork();
    mkArtifact("art_a", "结论:选 A");
    const a = snapshot();
    mkArtifact("art_b", "结论:选 B,而且 A 是错的");
    // 只有「多了一行工件」这件事变了;两行工件的正文完全相反,判定不受影响
    expect(snapshot()).toEqual(a);
  });

  it("**多塞一个「刚才发生了什么」的入参也不改变输出** —— 入参里根本没有它", () => {
    // 这条测试有牙:哪天有人给 `CollectTodosOptions` 加一个 `trigger` / `event`
    // 之类的字段并**真的去读它**(或按触发筛规则),这里传进去的值就会改变看板,
    // 于是这条红。它守的是「纯度纪律一个字都不能松」。
    mkWork();
    const before = snapshot();
    const foreign: Record<string, unknown> = {
      trigger: "artifact_inserted",
      producedArtifacts: 3,
      lastEvent: { kind: "artifact_inserted", at: T0 },
    };
    const b = collectTodos({ db, projectId: "p1", now: T0, ...foreign });
    expect(
      [...b.runnable].map((t) => `${t.kind}|${t.key}|${t.agentId}|${t.attempts}`).sort(),
    ).toEqual(before);
  });
});

// ── ③ B2:产出工件现在真的会敲门 ─────────────────────────────────

describe("B2 · `blackboard.write` 挂上唯一漏斗(`dispatch`)", () => {
  it("`blackboard.write` 在门铃清单里(它原先被**刻意排除**,理由今天只对了一半)", () => {
    expect(NUDGE_CAPABILITIES).toContain("blackboard.write");
  });

  it("`board_write` 成功后门铃响一次", () => {
    let rings = 0;
    const ctx: ToolRunContext = { ...ctxFor("wk"), nudge: () => { rings++; } };
    const r = sync(dispatch(
      "board_write",
      { kind: "evidence", title: "路线 A 的实测数据", body: "延迟 120ms" },
      ctx,
    ));
    expect(r.ok, r.ok ? "" : `[${r.code}] ${r.message}`).toBe(true);
    expect(rings, "产出工件必须敲一次门铃 —— 那是「工件推动流程」的触发侧").toBe(1);
  });

  it("**门铃响了判定也不变**:`board_write` 之后看板与之前逐字相同", () => {
    mkWork();
    const before = snapshot();
    let rings = 0;
    const ctx: ToolRunContext = { ...ctxFor("wk"), nudge: () => { rings++; } };
    const r = sync(dispatch(
      "board_write",
      { kind: "evidence", title: "路线 A 的实测数据", body: "延迟 120ms" },
      ctx,
    ));
    expect(r.ok, r.ok ? "" : `[${r.code}] ${r.message}`).toBe(true);
    expect(rings).toBe(1);
    // 这就是那条纪律的完整形式:门铃只把 `collectTodos` 再叫一次,而它的输入没变
    expect(snapshot()).toEqual(before);
  });

  it("失败的调用不敲门(没发生的事不该叫醒任何人)", () => {
    // 质检只能写 `review_finding`(`ROLE_SPECS.quality_reviewer.writeKinds`),
    // 写 `evidence` 会被调用期门拒 —— 门铃不该响。
    let rings = 0;
    const ctx: ToolRunContext = { ...ctxFor("qa"), nudge: () => { rings++; } };
    const r = sync(dispatch(
      "board_write", { kind: "evidence", title: "t", body: "b" }, ctx,
    ));
    expect(r.ok).toBe(false);
    expect(rings).toBe(0);
  });
});
