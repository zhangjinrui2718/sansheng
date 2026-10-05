/**
 * BC2 Collaboration 测试(批次 5)
 *
 * ── 重点是 7-L 升级链 ─────────────────────────────────────────────
 *
 * AGENTS.md 记着 7-L 的三条约束。它们在 schema / 仓储层的落点是:
 *
 * ① **hypothesis 必填** —— 旧事故:payload 只有一句「Executor needs help」,
 *    判断轮连问题是什么都不知道。落成 CHECK + 仓储前置校验。
 * ② **升级时不留两条活问** —— 旧事故:`onEscalate` 没改挂 pending,
 *    一次迟到的 cancel 能再杀一遍已恢复的 executor。落成
 *    parent_ask_id + escalated 状态 + 回填链。
 * ③ 判断轮不再是独立 LLM 调用 → 卫生闸门随之消失(不是被删,是没有对应物)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent, getAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember, loadProjectForAuthz } from "../../src/platform/storage/repo/projects.js";
import {
  insertAsk, getAsk, listAsks, answerAsk, escalateAsk, cancelAsk, expireAsk,
  askChain, askedByMeOpen, listOverdueAsks, isAskStatus, ASK_STATUSES,
} from "../../src/platform/storage/repo/asks.js";
import {
  insertMeeting, getMeeting, listParticipants, respondToMeeting, concludeMeeting,
  pendingMeetingsFor, stanceTally, isStance, isMeetingStatus,
} from "../../src/platform/storage/repo/meetings.js";
import {
  insertSession, listSessions, appendSessionMessage, listSessionMessages, isSessionMessageKind,
} from "../../src/platform/storage/repo/sessions.js";
import { listArtifacts } from "../../src/platform/storage/repo/artifacts.js";
import { dispatch, TOOL_INDEX, notYetBuiltToolNames } from "../../src/platform/tools/registry.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";
import type { Agent, Project } from "../../src/platform/harness/authorize.js";
import type { ProjectRole, Specialization } from "../../src/platform/identity/role.js";

let db: Database.Database;
let seq = 0;
let clock = 1_700_000_000_000;
let project: Project;
const agents = new Map<string, Agent>();
const ids: Record<string, string> = {};

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  clock = 1_700_000_000_000;
  agents.clear();

  function mk(role: ProjectRole, spec?: Specialization): Agent {
    const id = `ag_${role}${spec ? "_" + spec : ""}`;
    insertAgent(db, { id, role, specialization: spec ?? null, displayName: `${role}${spec ?? ""}`, createdAt: clock });
    const a: Agent = { id, role, displayName: `${role}${spec ?? ""}`, ...(spec ? { specialization: spec } : {}) };
    agents.set(id, a);
    return a;
  }

  ids.bm = mk("business_manager").id;
  ids.pm = mk("project_manager").id;
  ids.wk = mk("worker", "algorithm").id;
  ids.qa = mk("quality_reviewer").id;

  const pid = "pj_1";
  insertProject(db, { id: pid, name: "测试项目", client: "甲方", goal: "g", status: "active", createdAt: clock });
  for (const id of Object.values(ids)) addMember(db, pid, id, clock);
  project = loadProjectForAuthz(db, pid)!;
});
afterEach(() => db.close());

function ctxFor(agentId: string): ToolRunContext {
  const agent = agents.get(agentId)!;
  return { db, agent, project, now: () => clock, newId: (p) => `${p}_${++seq}` };
}
function call(agentId: string, tool: string, args: Record<string, unknown> = {}): ToolResult {
  const r = dispatch(tool, args, ctxFor(agentId));
  if (r instanceof Promise) throw new Error("sync only");
  return r;
}
function okText(r: ToolResult): string {
  if (!r.ok) throw new Error(`期望成功,失败[${r.code}] ${r.message}`);
  return r.text;
}
function errOf(r: ToolResult): Extract<ToolResult, { ok: false }> {
  if (r.ok) throw new Error(`期望失败,成功:${r.text}`);
  return r;
}
function newAskId(): string {
  return `ask_${++seq}`;
}

// ── 表结构 ──────────────────────────────────────────────────────

describe("BC2 schema", () => {
  it("五张表都建出来了", () => {
    const rows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN
                ('project_sessions','session_messages','asks','meetings','meeting_participants')`)
      .all() as Array<{ name: string }>;
    expect(rows).toHaveLength(5);
  });

  it("hypothesis 非空由 schema 强制(7-L 约束①)", () => {
    expect(() =>
      db.prepare(
        `INSERT INTO asks (id, project_id, from_agent_id, to_agent_id, parent_ask_id,
                           question, hypothesis, options_json, needs, status, created_at)
         VALUES ('x','pj_1','a','b',NULL,'q','   ',NULL,NULL,'open',1)`,
      ).run(),
    ).toThrow(/CHECK/i);
  });

  it("不能向自己提问由触发器拦截", () => {
    expect(() =>
      db.prepare(
        `INSERT INTO asks (id, project_id, from_agent_id, to_agent_id, parent_ask_id,
                           question, hypothesis, options_json, needs, status, created_at)
         VALUES ('x','pj_1','a','a',NULL,'q','h',NULL,NULL,'open',1)`,
      ).run(),
    ).toThrow(/不能向自己提问/);
  });

  it("反对必须有理由由 schema 强制", () => {
    insertMeeting(db, {
      id: "m1", projectId: "pj_1", topic: "t", conveningAgentId: ids.bm,
      createdAt: clock, participants: [ids.wk],
    });
    expect(() =>
      db.prepare(`UPDATE meeting_participants SET stance='oppose', responded_at=1 WHERE meeting_id='m1'`).run(),
    ).toThrow(/CHECK/i);
  });

  it("表态了就必须有立场与时间(两者同生同灭)", () => {
    insertMeeting(db, {
      id: "m1", projectId: "pj_1", topic: "t", conveningAgentId: ids.bm,
      createdAt: clock, participants: [ids.wk],
    });
    expect(() =>
      db.prepare(`UPDATE meeting_participants SET responded_at=1 WHERE meeting_id='m1'`).run(),
    ).toThrow(/CHECK/i);
  });
});

// ── asks ────────────────────────────────────────────────────────

describe("BC2 asks · 基本", () => {
  function mkAsk(from: string, to: string, hyp = "我猜是 X"): string {
    const id = newAskId();
    insertAsk(db, {
      id, projectId: "pj_1", fromAgentId: from, toAgentId: to,
      question: "这事该怎么做?", hypothesis: hyp, createdAt: clock,
    });
    return id;
  }

  it("插入后状态是 open", () => {
    const id = mkAsk(ids.wk, ids.pm);
    expect(getAsk(db, id)).toMatchObject({ status: "open", fromAgentId: ids.wk, toAgentId: ids.pm });
  });

  it("空 hypothesis 被仓储层拒绝(比 schema 更早、更可读)", () => {
    expect(() =>
      insertAsk(db, {
        id: "x", projectId: "pj_1", fromAgentId: ids.wk, toAgentId: ids.pm,
        question: "q", hypothesis: "   ", createdAt: clock,
      }),
    ).toThrow(/必须带 hypothesis/);
  });

  it("不能向自己提问(仓储也拦)", () => {
    expect(() =>
      insertAsk(db, {
        id: "x", projectId: "pj_1", fromAgentId: ids.wk, toAgentId: ids.wk,
        question: "q", hypothesis: "h", createdAt: clock,
      }),
    ).toThrow(/不能向自己提问/);
  });

  it("listAsks 的 actionableOnly 只给 open(escalated 已转交,不该我答)", () => {
    const a1 = mkAsk(ids.wk, ids.pm);
    const a2 = mkAsk(ids.wk, ids.pm);
    escalateAsk(db, a2, {
      id: newAskId(), projectId: "pj_1", fromAgentId: ids.pm, toAgentId: ids.bm,
      question: "升级", hypothesis: "我也拿不准", createdAt: clock,
    }, clock);

    const actionable = listAsks(db, "pj_1", { toAgentId: ids.pm, actionableOnly: true });
    expect(actionable.map((a) => a.id)).toEqual([a1]);
    expect(getAsk(db, a2)?.status).toBe("escalated");
  });

  it("askedByMeOpen 给出提问者当前卡住的全部(含 escalated 的)", () => {
    const a1 = mkAsk(ids.wk, ids.pm);
    const a2 = mkAsk(ids.wk, ids.qa);
    answerAsk(db, a2, clock, null);
    const stuck = askedByMeOpen(db, ids.wk);
    expect(stuck.map((a) => a.id)).toEqual([a1]);
  });

  it("listOverdueAsks 按截止时间捞出超时未决的", () => {
    insertAsk(db, {
      id: "old", projectId: "pj_1", fromAgentId: ids.wk, toAgentId: ids.pm,
      question: "q", hypothesis: "h", createdAt: clock, deadlineAt: clock + 1000,
    });
    expect(listOverdueAsks(db, clock + 500)).toEqual([]);
    expect(listOverdueAsks(db, clock + 2000).map((a) => a.id)).toEqual(["old"]);
  });

  it("expireAsk 只对 open 生效", () => {
    const id = mkAsk(ids.wk, ids.pm);
    answerAsk(db, id, clock, null);
    expect(expireAsk(db, id, clock).ok).toBe(false);
  });

  it("守卫与 schema 闭集一致", () => {
    for (const s of ASK_STATUSES) expect(isAskStatus(s)).toBe(true);
    expect(isAskStatus("pending")).toBe(false);
  });
});

// ── 升级链(7-L 约束②)────────────────────────────────────────────

describe("BC2 升级链 · 任何时刻链上只有一条活问(7-L 约束②)", () => {
  function chain(): { a1: string; a2: string } {
    const a1 = newAskId();
    insertAsk(db, {
      id: a1, projectId: "pj_1", fromAgentId: ids.wk, toAgentId: ids.pm,
      question: "要不要改方案?", hypothesis: "我倾向改,因为 X", createdAt: clock,
    });
    const a2 = newAskId();
    const r = escalateAsk(db, a1, {
      id: a2, projectId: "pj_1", fromAgentId: ids.pm, toAgentId: ids.bm,
      question: "要不要改方案?", hypothesis: "下级倾向改;我也倾向改,但涉及甲方", createdAt: clock,
    }, clock);
    expect(r.ok).toBe(true);
    return { a1, a2 };
  }

  it("升级后父问转 escalated,子问 open,并记住 parent", () => {
    const { a1, a2 } = chain();
    expect(getAsk(db, a1)?.status).toBe("escalated");
    expect(getAsk(db, a2)).toMatchObject({ status: "open", parentAskId: a1 });
  });

  it("**全项目里 open 的只有链末端那一条**", () => {
    const { a2 } = chain();
    const open = listAsks(db, "pj_1", { status: "open" });
    expect(open.map((a) => a.id)).toEqual([a2]);
  });

  it("答复链末端 → **沿 parent 链回填**,原始提问者才真解除 blocked", () => {
    const { a1, a2 } = chain();
    const r = answerAsk(db, a2, clock + 10, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.alsoResolved).toEqual([a1]);
    expect(getAsk(db, a1)).toMatchObject({ status: "answered", resolvedAt: clock + 10 });
    // 提问者不再卡住
    expect(askedByMeOpen(db, ids.wk)).toEqual([]);
  });

  it("三层链也能一路回填", () => {
    const a1 = newAskId();
    insertAsk(db, { id: a1, projectId: "pj_1", fromAgentId: ids.wk, toAgentId: ids.qa, question: "q", hypothesis: "h1", createdAt: clock });
    const a2 = newAskId();
    escalateAsk(db, a1, { id: a2, projectId: "pj_1", fromAgentId: ids.qa, toAgentId: ids.pm, question: "q", hypothesis: "h2", createdAt: clock }, clock);
    const a3 = newAskId();
    escalateAsk(db, a2, { id: a3, projectId: "pj_1", fromAgentId: ids.pm, toAgentId: ids.bm, question: "q", hypothesis: "h3", createdAt: clock }, clock);

    const r = answerAsk(db, a3, clock + 1, null);
    expect(r.ok && r.alsoResolved.sort()).toEqual([a1, a2].sort());
    expect(listAsks(db, "pj_1", { status: "open" })).toEqual([]);
  });

  it("**迟到的 cancel 打不到已回填的父问** —— 这正是 7-L 要防的那次事故", () => {
    const { a1, a2 } = chain();
    answerAsk(db, a2, clock + 10, null);
    // 父问已 answered
    const late = cancelAsk(db, a1, clock + 99);
    expect(late).toEqual({ ok: false, reason: "not_open" });
    expect(getAsk(db, a1)?.status, "迟到操作不该改状态").toBe("answered");
  });

  it("升级已 answered 的问被拒(不能把了结的事重新捅上去)", () => {
    const a1 = newAskId();
    insertAsk(db, { id: a1, projectId: "pj_1", fromAgentId: ids.wk, toAgentId: ids.pm, question: "q", hypothesis: "h", createdAt: clock });
    answerAsk(db, a1, clock, null);
    const r = escalateAsk(db, a1, {
      id: newAskId(), projectId: "pj_1", fromAgentId: ids.pm, toAgentId: ids.bm,
      question: "q", hypothesis: "h", createdAt: clock,
    }, clock);
    expect(r).toEqual({ ok: false, reason: "not_open" });
  });

  it("升级同样必须带 hypothesis(上级比下级更需要判断依据)", () => {
    const a1 = newAskId();
    insertAsk(db, { id: a1, projectId: "pj_1", fromAgentId: ids.wk, toAgentId: ids.pm, question: "q", hypothesis: "h", createdAt: clock });
    expect(() =>
      escalateAsk(db, a1, {
        id: "x", projectId: "pj_1", fromAgentId: ids.pm, toAgentId: ids.bm,
        question: "q", hypothesis: "  ", createdAt: clock,
      }, clock),
    ).toThrow(/必须带 hypothesis/);
  });

  it("升级是原子的:子问没建成时父问不该变 escalated", () => {
    const a1 = newAskId();
    insertAsk(db, { id: a1, projectId: "pj_1", fromAgentId: ids.wk, toAgentId: ids.pm, question: "q", hypothesis: "h", createdAt: clock });
    // 故意让子问插入失败:自问自答
    const r = escalateAsk(db, a1, {
      id: newAskId(), projectId: "pj_1", fromAgentId: ids.pm, toAgentId: ids.pm,
      question: "q", hypothesis: "h", createdAt: clock,
    }, clock);
    expect(r).toEqual({ ok: false, reason: "no_parent_available" });
    expect(getAsk(db, a1)?.status, "升级失败后父问应保持 open").toBe("open");
  });

  it("askChain 给出从链首到末端的完整路径", () => {
    const { a1, a2 } = chain();
    const c = askChain(db, a2);
    expect(c.map((x) => x.id)).toEqual([a1, a2]);
  });
});

// ── meetings ────────────────────────────────────────────────────

describe("BC2 meetings", () => {
  function mkMeeting(): string {
    insertMeeting(db, {
      id: "m1", projectId: "pj_1", topic: "排期对焦",
      agendaJson: JSON.stringify(["确认交付时间"]),
      conveningAgentId: ids.bm, createdAt: clock,
      participants: [ids.pm, ids.wk, ids.qa],
    });
    return "m1";
  }

  it("建会时为每个参会方建「待表态」记录", () => {
    mkMeeting();
    const parts = listParticipants(db, "m1");
    expect(parts.map((p) => p.agentId).sort()).toEqual([ids.pm, ids.wk, ids.qa].sort());
    expect(parts.every((p) => p.respondedAt === null && p.stance === null)).toBe(true);
  });

  it("没有参会方的会议被拒", () => {
    expect(() =>
      insertMeeting(db, {
        id: "m0", projectId: "pj_1", topic: "t", conveningAgentId: ids.bm,
        createdAt: clock, participants: [],
      }),
    ).toThrow(/至少要有一个参会方/);
  });

  it("首次表态把会议从 convened 推到 in_progress", () => {
    mkMeeting();
    expect(getMeeting(db, "m1")?.status).toBe("convened");
    expect(respondToMeeting(db, "m1", ids.pm, "support", clock + 1).ok).toBe(true);
    expect(getMeeting(db, "m1")?.status).toBe("in_progress");
  });

  it("反对不给理由被拒(仓储层)", () => {
    mkMeeting();
    expect(respondToMeeting(db, "m1", ids.pm, "oppose", clock + 1)).toEqual({
      ok: false, reason: "oppose_needs_reason",
    });
    expect(respondToMeeting(db, "m1", ids.pm, "oppose", clock + 1, "  ")).toEqual({
      ok: false, reason: "oppose_needs_reason",
    });
    expect(respondToMeeting(db, "m1", ids.pm, "oppose", clock + 1, "排期不现实").ok).toBe(true);
  });

  it("非参会方不能表态", () => {
    mkMeeting();
    expect(respondToMeeting(db, "m1", ids.bm, "support", clock + 1)).toEqual({
      ok: false, reason: "not_participant",
    });
  });

  it("**只有发起人能收尾**", () => {
    mkMeeting();
    expect(concludeMeeting(db, "m1", ids.pm, "结论", clock + 9)).toEqual({
      ok: false, reason: "not_convener",
    });
    expect(concludeMeeting(db, "m1", ids.bm, "结论", clock + 9).ok).toBe(true);
  });

  it("收尾不强制所有人表态,但如实列出未表态者", () => {
    mkMeeting();
    respondToMeeting(db, "m1", ids.pm, "support", clock + 1);
    const r = concludeMeeting(db, "m1", ids.bm, "结论:按 A 走", clock + 9);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pending.sort()).toEqual([ids.wk, ids.qa].sort());
  });

  it("已收尾的会议不能再表态 / 再收尾", () => {
    mkMeeting();
    concludeMeeting(db, "m1", ids.bm, "结论", clock + 9);
    expect(respondToMeeting(db, "m1", ids.pm, "support", clock + 10)).toEqual({
      ok: false, reason: "meeting_closed",
    });
    expect(concludeMeeting(db, "m1", ids.bm, "又一次", clock + 11)).toEqual({
      ok: false, reason: "already_closed",
    });
  });

  it("pendingMeetingsFor 给出该 agent 还没表态的会议", () => {
    mkMeeting();
    expect(pendingMeetingsFor(db, ids.pm).map((m) => m.id)).toEqual(["m1"]);
    respondToMeeting(db, "m1", ids.pm, "undecided", clock + 1, "还在评估");
    expect(pendingMeetingsFor(db, ids.pm)).toEqual([]);
    expect(pendingMeetingsFor(db, ids.wk).map((m) => m.id)).toEqual(["m1"]);
  });

  it("stanceTally 统计四方立场", () => {
    mkMeeting();
    respondToMeeting(db, "m1", ids.pm, "support", clock + 1);
    respondToMeeting(db, "m1", ids.wk, "oppose", clock + 2, "时间不够");
    respondToMeeting(db, "m1", ids.qa, "undecided", clock + 3, "等测试结果");
    expect(stanceTally(db, "m1")).toEqual({ support: 1, oppose: 1, undecided: 1, silent: 0 });
  });

  it("守卫与闭集一致", () => {
    for (const s of ["convened", "in_progress", "concluded", "cancelled"]) {
      expect(isMeetingStatus(s)).toBe(true);
    }
    for (const s of ["support", "oppose", "undecided"]) expect(isStance(s)).toBe(true);
    expect(isStance("veto")).toBe(false);
  });
});

// ── project_sessions / session_messages ─────────────────────────

describe("BC2 会话", () => {
  it("会话按项目归属;消息按会话归属", () => {
    insertSession(db, { id: "s1", projectId: "pj_1", createdAt: clock });
    // 封套是 `appendSessionMessage` 的**必填实参**(W3-①):这里照实写
    // —— 甲方的回显是 `turn/user`,业务经理的正文按触发维度写。
    appendSessionMessage(db, { id: "m1", sessionId: "s1", agentId: null, kind: "user", content: "你好", createdAt: clock, originSource: "turn", triggerKind: "user" });
    appendSessionMessage(db, { id: "m2", sessionId: "s1", agentId: ids.bm, kind: "assistant", content: "在", createdAt: clock + 1, originSource: "turn", triggerKind: "user" });
    expect(listSessions(db, "pj_1").map((s) => s.id)).toEqual(["s1"]);
    const msgs = listSessionMessages(db, "s1");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ agentId: null, kind: "user", originSource: "turn", triggerKind: "user" });
    expect(msgs[1]).toMatchObject({ agentId: ids.bm, kind: "assistant", originSource: "turn", triggerKind: "user" });
  });

  it("messages.agent_id 可空 = 甲方说的话", () => {
    insertSession(db, { id: "s1", projectId: "pj_1", createdAt: clock });
    appendSessionMessage(db, { id: "m1", sessionId: "s1", agentId: null, kind: "user", content: "x", createdAt: clock, originSource: "turn", triggerKind: "user" });
    expect(listSessionMessages(db, "s1")[0]!.agentId).toBeNull();
  });

  it("非法 kind 被 CHECK 拒绝;守卫与闭集一致", () => {
    insertSession(db, { id: "s1", projectId: "pj_1", createdAt: clock });
    expect(() =>
      db.prepare(
        `INSERT INTO session_messages (id, session_id, agent_id, kind, content, created_at)
         VALUES ('x','s1',NULL,'bogus','c',1)`,
      ).run(),
    ).toThrow(/CHECK/i);
    for (const k of ["user", "assistant", "thinking", "tool", "system"]) {
      expect(isSessionMessageKind(k)).toBe(true);
    }
    expect(isSessionMessageKind("bogus")).toBe(false);
  });
});

// ── 工具层 ──────────────────────────────────────────────────────

describe("BC2 工具 · 走派发器的完整链路", () => {
  it("BC2 工具已全部实现,不再有「还没建」", () => {
    const missing = notYetBuiltToolNames();
    for (const t of ["ask_role", "answer", "ask_list", "ask_read", "escalate",
                     "convene", "meeting_read", "meeting_respond", "meeting_conclude"]) {
      expect(missing, `${t} 应已实现`).not.toContain(t);
    }
  });

  it("ask_role 建问并解析目标", () => {
    const t = okText(call(ids.wk, "ask_role", {
      targetRole: "project_manager", question: "要不要改方案?",
      hypothesis: "我倾向改,因为性能不达标", options: ["改方案", "加机器"],
    }));
    expect(t).toContain("已向");
    const askId = t.match(/\((\S+?)\)/)?.[1];
    expect(askId).toBeDefined();
    expect(getAsk(db, askId!)?.toAgentId).toBe(ids.pm);
  });

  it("ask_role 不给 hypothesis → invalid_args(7-L 约束①)", () => {
    const e = errOf(call(ids.wk, "ask_role", {
      targetRole: "project_manager", question: "怎么办?",
    }));
    expect(e.code).toBe("invalid_args");
    expect(e.message).toContain("hypothesis");
  });

  it("ask_role 向自己提问被拒", () => {
    const e = errOf(call(ids.pm, "ask_role", {
      targetRole: "project_manager", question: "q", hypothesis: "h",
    }));
    expect(e.code).toBe("invalid_args");
  });

  it("answer 落 decision 工件并回填链", () => {
    const askId = okText(call(ids.wk, "ask_role", {
      targetRole: "project_manager", question: "q", hypothesis: "h",
    })).match(/\((\S+?)\)/)![1]!;
    const t = okText(call(ids.pm, "answer", { askId, body: "按方案 A 走,依据是 X" }));
    expect(t).toContain("decision 工件");
    const arts = listArtifacts(db, "pj_1", { kind: "decision" });
    expect(arts).toHaveLength(1);
    expect(arts[0]!.body).toContain("原问题");
    expect(getAsk(db, askId)?.status).toBe("answered");
  });

  it("**越权代答被拒** —— 不是问你的事不能替你答", () => {
    const askId = okText(call(ids.wk, "ask_role", {
      targetRole: "project_manager", question: "q", hypothesis: "h",
    })).match(/\((\S+?)\)/)![1]!;
    const e = errOf(call(ids.bm, "answer", { askId, body: "我替你答" }));
    expect(e.code).toBe("denied");
    expect(e.message).toContain("不是问你");
  });

  it("escalate 按组织图升级:worker→pm→bm", () => {
    const askId = okText(call(ids.wk, "ask_role", {
      targetRole: "project_manager", question: "q", hypothesis: "worker 的猜测",
    })).match(/\((\S+?)\)/)![1]!;

    const t = okText(call(ids.pm, "escalate", {
      askId, reason: "涉及甲方范围,我无权定", hypothesis: "我倾向走方案 A",
    }));
    expect(t).toContain("已升级");
    const childId = t.match(/→ (\S+?)\(/)![1]!;
    expect(getAsk(db, childId)?.toAgentId).toBe(ids.bm);
    expect(getAsk(db, childId)?.parentAskId).toBe(askId);
    expect(getAsk(db, askId)?.status).toBe("escalated");
    // 升级后的假设里带上了下级的原因与原始假设
    expect(getAsk(db, childId)?.hypothesis).toContain("worker 的猜测");
    expect(getAsk(db, childId)?.hypothesis).toContain("涉及甲方范围");
  });

  it("**业务经理连 escalate 这个工具都没有** —— 它在 ceiling 层就被拦下", () => {
    const askId = okText(call(ids.pm, "ask_role", {
      targetRole: "business_manager", question: "q", hypothesis: "h",
    })).match(/\((\S+?)\)/)![1]!;
    const e = errOf(call(ids.bm, "escalate", { askId, reason: "r", hypothesis: "h" }));
    // 比工具内部的「没有可升级对象」更早:ROLE_SPECS.business_manager.ceiling
    // 里根本没有 collab.escalate —— 它是链路顶端,升级出口是 client.ask
    expect(e.code).toBe("denied");
    expect(e.message).toContain("架构上界");
    // 而它的 ceiling 里确实有 client.ask 作为出口,且那个工具已实现
    expect(TOOL_INDEX.has("ask_client")).toBe(true);
  });

  it("ask_list toMeOnly 是「有什么在等我答」", () => {
    okText(call(ids.wk, "ask_role", { targetRole: "project_manager", question: "Q1", hypothesis: "h" }));
    const t = okText(call(ids.pm, "ask_list", { toMeOnly: true }));
    expect(t).toContain("Q1");
    expect(okText(call(ids.qa, "ask_list", { toMeOnly: true }))).toContain("没有等你");
  });

  it("ask_read 给出假设、候选、需求与升级链", () => {
    const askId = okText(call(ids.wk, "ask_role", {
      targetRole: "project_manager", question: "要不要改方案?",
      hypothesis: "倾向改", options: ["改", "不改"], needs: "需要你拍板",
    })).match(/\((\S+?)\)/)![1]!;
    const t = okText(call(ids.pm, "ask_read", { askId }));
    expect(t).toContain("提问者的假设");
    expect(t).toContain("倾向改");
    expect(t).toContain("候选方案");
    expect(t).toContain("需要什么决定");
  });

  it("convene → meeting_respond → meeting_conclude 全链", () => {
    const t = okText(call(ids.bm, "convene", {
      topic: "排期对焦",
      participants: [{ role: "project_manager" }, { role: "worker", spec: "algorithm" }],
      agenda: ["确认交付时间"],
    }));
    const mid = t.match(/会议 (\S+?)「/)![1]!;

    // 发文者自动参会
    expect(listParticipants(db, mid).map((p) => p.agentId)).toContain(ids.bm);

    okText(call(ids.pm, "meeting_respond", { meetingId: mid, stance: "support" }));
    okText(call(ids.wk, "meeting_respond", { meetingId: mid, stance: "oppose", comment: "时间不够" }));

    const ct = okText(call(ids.bm, "meeting_conclude", { meetingId: mid, summary: "按 A 走,pm 负责" }));
    expect(ct).toContain("纪要工件");
    expect(getMeeting(db, mid)?.status).toBe("concluded");
    // 纪要落成 meeting_note 工件
    expect(listArtifacts(db, "pj_1", { kind: "meeting_note" })).toHaveLength(1);
  });

  it("meeting_respond 反对不给理由被拒", () => {
    const mid = okText(call(ids.bm, "convene", {
      topic: "t", participants: [{ role: "worker", spec: "algorithm" }],
    })).match(/会议 (\S+?)「/)![1]!;
    const e = errOf(call(ids.wk, "meeting_respond", { meetingId: mid, stance: "oppose" }));
    expect(e.code).toBe("conflict");
    expect(e.message).toContain("理由");
  });

  it("**非发起人收尾被拒**", () => {
    const mid = okText(call(ids.bm, "convene", {
      topic: "t", participants: [{ role: "project_manager" }],
    })).match(/会议 (\S+?)「/)![1]!;
    const e = errOf(call(ids.pm, "meeting_conclude", { meetingId: mid, summary: "我说了算" }));
    expect(e.code).toBe("denied");
    expect(e.message).toContain("只有发起人");
  });

  it("meeting_read 渲染立场分布与未表态者", () => {
    const mid = okText(call(ids.bm, "convene", {
      topic: "排期", participants: [{ role: "project_manager" }, { role: "quality_reviewer" }],
    })).match(/会议 (\S+?)「/)![1]!;
    okText(call(ids.pm, "meeting_respond", { meetingId: mid, stance: "support" }));
    const t = okText(call(ids.bm, "meeting_read", { meetingId: mid }));
    expect(t).toContain("支持 1");
    expect(t).toContain("尚未表态");
    expect(t).toContain(ids.qa);
  });
});

// ── 端到端:7-L 场景 ────────────────────────────────────────────

describe("端到端 · 7-L 场景:worker 卡住 → 沟通员判断 → 能自答 / 才升级", () => {
  it("沟通员能自答时,用户零打扰", () => {
    // worker 提问
    const askId = okText(call(ids.wk, "ask_role", {
      targetRole: "project_manager", question: "实现细节用 A 还是 B?",
      hypothesis: "我倾向 A,因为现有代码已经用了 A 的模式",
    })).match(/\((\S+?)\)/)![1]!;

    // 项目经理看到它在等自己 → 有自己的判断依据 → 直接答(不惊动业务经理)
    const pending = listAsks(db, "pj_1", { toAgentId: ids.pm, actionableOnly: true });
    expect(pending.map((a) => a.id)).toEqual([askId]);

    okText(call(ids.pm, "answer", { askId, body: "用 A,与现有模式一致" }));

    // 结论:worker 解除阻塞,没有任何问升级到业务经理
    expect(askedByMeOpen(db, ids.wk)).toEqual([]);
    expect(listAsks(db, "pj_1", { toAgentId: ids.bm, actionableOnly: true })).toEqual([]);
  });

  it("判不了时才升级,且升级链带上全部判断依据", () => {
    const askId = okText(call(ids.wk, "ask_role", {
      targetRole: "project_manager", question: "要不要动 schema?",
      hypothesis: "我倾向不动,但影响面我评估不了",
      options: ["不动 schema", "加一列"],
      needs: "需要判断能否接受停机",
    })).match(/\((\S+?)\)/)![1]!;

    okText(call(ids.pm, "escalate", {
      askId, reason: "涉及停机,需与甲方确认窗口",
      hypothesis: "我倾向加一列,但必须约窗口",
    }));

    // 业务经理看到的是带完整依据的问题
    const bmPending = listAsks(db, "pj_1", { toAgentId: ids.bm, actionableOnly: true });
    expect(bmPending).toHaveLength(1);
    const child = bmPending[0]!;
    expect(child.hypothesis).toContain("我倾向不动");        // 原始假设
    expect(child.hypothesis).toContain("涉及停机");          // 下级的原因
    expect(child.hypothesis).toContain("我倾向加一列");      // 下级的倾向
    expect(child.optionsJson).toContain("不动 schema");      // 候选方案继承下来

    // 业务经理答复 → 一路回填,worker 解除阻塞
    okText(call(ids.bm, "answer", { askId: child.id, body: "约在下周二窗口,可以加列" }));
    expect(getAsk(db, askId)?.status).toBe("answered");
    expect(askedByMeOpen(db, ids.wk)).toEqual([]);
  });
});

// ── 接待会话(project_id NULL)────────────────────────────────────
//
// 第一个项目之前的那条会话。它的身份就是 `project_id IS NULL`,而且**全局唯一**
// (由迁移 012 的部分唯一索引保证)。这里守两件事:仓储读得出来(不能写成
// `project_id = NULL`,那恒为 unknown),以及唯一性是 schema 兜的而不是靠自觉。

describe("BC2 接待会话(project_id NULL)", () => {
  it("insertSession 接受 null;listSessions(null) 用 IS NULL 查得出来", () => {
    insertSession(db, { id: "s_intake", projectId: null, createdAt: clock });
    insertSession(db, { id: "s_proj", projectId: "pj_1", createdAt: clock });
    expect(listSessions(db, null).map((s) => s.id)).toEqual(["s_intake"]);
    expect(listSessions(db, "pj_1").map((s) => s.id)).toEqual(["s_proj"]);
    // 读回来的行也要如实说「它不属于任何项目」
    expect(listSessions(db, null)[0]!.projectId).toBeNull();
  });

  it("接待会话的消息按 session_id 归属,与项目会话用同一张表", () => {
    insertSession(db, { id: "s_intake", projectId: null, createdAt: clock });
    appendSessionMessage(db, {
      id: "m1", sessionId: "s_intake", agentId: null, kind: "user", content: "我想做点东西", createdAt: clock,
      originSource: "turn", triggerKind: "user",
    });
    expect(listSessionMessages(db, "s_intake")).toHaveLength(1);
  });

  it("**接待会话全局只能有一条** —— 不变量在 schema 层,不靠应用层自觉", () => {
    insertSession(db, { id: "s_intake", projectId: null, createdAt: clock });
    expect(() => insertSession(db, { id: "s_intake2", projectId: null, createdAt: clock + 1 })).toThrow(
      /UNIQUE/i,
    );
    // 但同一个项目的多条会话必须照样允许(部分索引不该误伤非空行)
    insertSession(db, { id: "s_a", projectId: "pj_1", createdAt: clock });
    insertSession(db, { id: "s_b", projectId: "pj_1", createdAt: clock + 1 });
    expect(listSessions(db, "pj_1")).toHaveLength(2);
  });

  it("删除项目仍会级联删掉该项目的会话与消息(重建表没把外键弄丢)", () => {
    insertSession(db, { id: "s_proj", projectId: "pj_1", createdAt: clock });
    appendSessionMessage(db, {
      id: "m1", sessionId: "s_proj", agentId: null, kind: "user", content: "x", createdAt: clock,
      originSource: "turn", triggerKind: "user",
    });
    insertSession(db, { id: "s_intake", projectId: null, createdAt: clock });
    db.prepare(`DELETE FROM projects WHERE id = ?`).run("pj_1");
    expect(listSessions(db, "pj_1")).toEqual([]);
    expect(listSessionMessages(db, "s_proj")).toEqual([]);
    // 接待会话不随项目消失
    expect(listSessions(db, null).map((s) => s.id)).toEqual(["s_intake"]);
  });
});
