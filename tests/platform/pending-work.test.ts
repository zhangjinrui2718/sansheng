/**
 * 待办注入面测试(ADR-001 §5.2)
 *
 * 这一层的存在理由是「没有它,升级链在真实运行中会停摆,而单元测试全绿」。
 * 所以测试要覆盖的恰恰是**真实运行的那条路**:
 *   执行角色提问 → 项目经理的待办里应当出现它 → 渲染出的文本里带着假设全文
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember } from "../../src/platform/storage/repo/projects.js";
import { insertAsk, answerAsk, escalateAsk } from "../../src/platform/storage/repo/asks.js";
import { insertMeeting, respondToMeeting } from "../../src/platform/storage/repo/meetings.js";
import { insertBlocker, setBlockerStatus } from "../../src/platform/storage/repo/blockers.js";
import { insertChange } from "../../src/platform/storage/repo/changes.js";
import {
  collectPendingWork, hasActionableWork, renderPendingWork, summarizePendingWork,
} from "../../src/platform/runtime/pendingWork.js";
import type { Agent } from "../../src/platform/harness/authorize.js";

let db: Database.Database;
let seq = 0;
const clock = 1_700_000_000_000;
const ids: Record<string, string> = {};

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  function mk(role: Agent["role"]): string {
    const id = `ag_${role}`;
    insertAgent(db, { id, role, specialization: null, displayName: role, createdAt: clock });
    return id;
  }
  ids.bm = mk("business_manager");
  ids.pm = mk("project_manager");
  ids.wk = mk("research_worker");
  ids.qa = mk("quality_reviewer");
  insertProject(db, { id: "p1", name: "测试", client: "甲", goal: "g", status: "active", createdAt: clock });
  for (const id of Object.values(ids)) addMember(db, "p1", id, clock);
});
afterEach(() => db.close());

function mkAsk(from: string, to: string, q = "该怎么做?", h = "我猜是 A", deadlineAt?: number): string {
  const id = `ask_${++seq}`;
  insertAsk(db, {
    id, projectId: "p1", fromAgentId: from, toAgentId: to,
    question: q, hypothesis: h, createdAt: clock,
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
  });
  return id;
}

describe("collectPendingWork · 谁在等我", () => {
  it("等我答的提问出现在 toAgent 的待办里,不在别人的", () => {
    const a = mkAsk(ids.wk, ids.pm);
    const mine = collectPendingWork(db, ids.pm, "p1", clock);
    expect(mine.asksToAnswer.map((x) => x.id)).toEqual([a]);

    const other = collectPendingWork(db, ids.qa, "p1", clock);
    expect(other.asksToAnswer).toEqual([]);
  });

  it("**escalated 的问不再算「等我答」** —— 它已转交出去", () => {
    const a1 = mkAsk(ids.wk, ids.pm);
    escalateAsk(db, a1, {
      id: `ask_${++seq}`, projectId: "p1", fromAgentId: ids.pm, toAgentId: ids.bm,
      question: "q", hypothesis: "h", createdAt: clock,
    }, clock);

    // 项目经理手上应该空了(它把问题交出去了)
    expect(collectPendingWork(db, ids.pm, "p1", clock).asksToAnswer).toEqual([]);
    // 业务经理收到
    expect(collectPendingWork(db, ids.bm, "p1", clock).asksToAnswer).toHaveLength(1);
    // 而提问者仍然卡着
    expect(collectPendingWork(db, ids.wk, "p1", clock).myBlockedAsks).toHaveLength(1);
  });

  it("答复后三方都清空", () => {
    const a1 = mkAsk(ids.wk, ids.pm);
    const a2 = `ask_${++seq}`;
    escalateAsk(db, a1, {
      id: a2, projectId: "p1", fromAgentId: ids.pm, toAgentId: ids.bm,
      question: "q", hypothesis: "h", createdAt: clock,
    }, clock);
    answerAsk(db, a2, clock + 1, null);

    for (const id of [ids.bm, ids.pm, ids.wk]) {
      const w = collectPendingWork(db, id, "p1", clock + 2);
      expect(w.asksToAnswer, `${id} 不该还有待答`).toEqual([]);
      expect(w.myBlockedAsks, `${id} 不该还卡着`).toEqual([]);
    }
  });

  it("待表态会议", () => {
    insertMeeting(db, {
      id: "m1", projectId: "p1", topic: "排期", conveningAgentId: ids.bm,
      createdAt: clock, participants: [ids.pm, ids.qa],
    });
    expect(collectPendingWork(db, ids.pm, "p1", clock).meetingsToRespond.map((m) => m.id)).toEqual(["m1"]);
    respondToMeeting(db, "m1", ids.pm, "support", clock + 1);
    expect(collectPendingWork(db, ids.pm, "p1", clock + 2).meetingsToRespond).toEqual([]);
    expect(collectPendingWork(db, ids.qa, "p1", clock + 2).meetingsToRespond.map((m) => m.id)).toEqual(["m1"]);
  });

  it("超时的提问单独统计", () => {
    mkAsk(ids.wk, ids.pm, "q", "h", clock + 1000);
    expect(collectPendingWork(db, ids.pm, "p1", clock + 500).overdueAsks).toEqual([]);
    expect(collectPendingWork(db, ids.pm, "p1", clock + 2000).overdueAsks).toHaveLength(1);
  });

  it("未解决阻塞与待评审变更", () => {
    insertBlocker(db, {
      id: "b1", projectId: "p1", raisedByAgentId: ids.wk, title: "缺依赖", detail: "d",
      severity: "high", status: "open", createdAt: clock,
    });
    insertBlocker(db, {
      id: "b2", projectId: "p1", raisedByAgentId: ids.wk, title: "已解", detail: "d",
      severity: "low", status: "open", createdAt: clock,
    });
    setBlockerStatus(db, "b2", "resolved", clock + 1, "修了");
    insertChange(db, { id: "c1", projectId: "p1", title: "加字段", rationale: "r", impactJson: null, createdAt: clock });

    const w = collectPendingWork(db, ids.bm, "p1", clock + 2);
    expect(w.openBlockers.map((b) => b.id)).toEqual(["b1"]);
    expect(w.pendingChanges.map((c) => c.id)).toEqual(["c1"]);
  });
});

describe("hasActionableWork · 要不要注入", () => {
  it("有待答提问 → true", () => {
    mkAsk(ids.wk, ids.pm);
    expect(hasActionableWork(collectPendingWork(db, ids.pm, "p1", clock))).toBe(true);
  });

  it("只有「我自己卡着」不算 actionable —— 那不是我该动的事", () => {
    mkAsk(ids.wk, ids.pm);
    const w = collectPendingWork(db, ids.wk, "p1", clock);
    expect(w.myBlockedAsks).toHaveLength(1);
    expect(hasActionableWork(w), "卡着的时候不该被反复提醒去动").toBe(false);
  });

  it("全空 → false", () => {
    expect(hasActionableWork(collectPendingWork(db, ids.qa, "p1", clock))).toBe(false);
  });
});

describe("renderPendingWork · 注入文本", () => {
  it("**没有待办时返回空串** —— 调用方可以无脑拼接", () => {
    expect(renderPendingWork(db, collectPendingWork(db, ids.qa, "p1", clock))).toBe("");
  });

  it("等我的提问带**假设全文**与提问者姓名", () => {
    mkAsk(ids.wk, ids.pm, "要不要改 schema?", "我倾向不动,但影响面我评估不了");
    const text = renderPendingWork(db, collectPendingWork(db, ids.pm, "p1", clock));
    expect(text).toContain("等你的提问(1)");
    expect(text).toContain("有人因此停着");
    expect(text).toContain("research_worker");              // 提问者
    expect(text).toContain("要不要改 schema?");              // 问题
    expect(text).toContain("我倾向不动");                    // ← 7-L 约束①:假设全文
    expect(text).toContain("answer");                        // 告诉它怎么办
    expect(text).toContain("escalate");
  });

  it("会议段落说明「反对必须写理由」", () => {
    insertMeeting(db, {
      id: "m1", projectId: "p1", topic: "排期", conveningAgentId: ids.bm,
      createdAt: clock, participants: [ids.pm],
    });
    const text = renderPendingWork(db, collectPendingWork(db, ids.pm, "p1", clock));
    expect(text).toContain("等你表态的会议(1)");
    expect(text).toContain("反对必须写理由");
  });

  it("超时段落**如实说明没有调度器**", () => {
    mkAsk(ids.wk, ids.pm, "q", "h", clock - 1);
    const text = renderPendingWork(db, collectPendingWork(db, ids.pm, "p1", clock));
    expect(text).toContain("已超时");
    expect(text, "没有调度器这件事必须对 agent 明说,否则它以为有人在管").toContain("没有调度器");
  });

  it("阻塞段落提示向甲方交代时要能说清", () => {
    insertBlocker(db, {
      id: "b1", projectId: "p1", raisedByAgentId: ids.wk, title: "缺依赖", detail: "d",
      severity: "critical", status: "open", createdAt: clock,
    });
    const text = renderPendingWork(db, collectPendingWork(db, ids.bm, "p1", clock));
    expect(text).toContain("未解决的阻塞(1)");
    expect(text).toContain("critical");
  });

  it("纯阻塞/纯卡着也要能渲染出来(虽然 hasActionableWork 为 false)", () => {
    insertBlocker(db, {
      id: "b1", projectId: "p1", raisedByAgentId: ids.wk, title: "缺依赖", detail: "d",
      severity: "high", status: "open", createdAt: clock,
    });
    const w = collectPendingWork(db, ids.bm, "p1", clock);
    expect(hasActionableWork(w)).toBe(false);
    expect(renderPendingWork(db, w), "渲染不该因为 actionable=false 就变空").toContain("未解决的阻塞");
  });
});

describe("summarizePendingWork · 诊断摘要", () => {
  it("无待办", () => {
    expect(summarizePendingWork(collectPendingWork(db, ids.qa, "p1", clock))).toBe("无待办");
  });

  it("各类计数", () => {
    mkAsk(ids.wk, ids.pm);
    mkAsk(ids.wk, ids.pm);
    insertMeeting(db, {
      id: "m1", projectId: "p1", topic: "t", conveningAgentId: ids.bm,
      createdAt: clock, participants: [ids.pm],
    });
    const s = summarizePendingWork(collectPendingWork(db, ids.pm, "p1", clock));
    expect(s).toContain("2 条等你答");
    expect(s).toContain("1 场会等表态");
  });
});

describe("端到端 · 注入面让升级链真正转起来", () => {
  it("执行角色提问 → 项目经理**不必主动查**就知道有东西在等它", () => {
    // 这是 ADR §5.2 的核心断言:没有注入面,收到方只能靠显式 ask_list,
    // 而真实运行里没有人提醒它去查
    mkAsk(ids.wk, ids.pm, "实现细节用 A 还是 B?", "我倾向 A,因为现有代码已经用了 A 的模式");

    const w = collectPendingWork(db, ids.pm, "p1", clock);
    expect(hasActionableWork(w), "应当被判定为「有事要做」").toBe(true);

    const injected = renderPendingWork(db, w);
    // 注入的文本里必须带足够的信息让它**不必再查一次**就能判断
    expect(injected).toContain("我倾向 A");
    expect(injected).toContain("research_worker");
  });
});
