/**
 * 「组织运行态」的状态派生(2026-10-05)
 *
 * ── 这一组钉的是什么 ────────────────────────────────────────────
 *
 * 用户看到项目页那张卡问的是:「这条停止推进,到底解没解决?」——而**同一个类名下的
 * 两条记录,状态可能完全不同**:一条早被兜底定时器接回去了,一条卡在预算用尽上。
 * 本文件把五档判据逐条钉住,外加两条最容易说反的负样本:
 *
 *   1. **读不到 ≠ 空闲**:`GET /live` 没拿到时必须是 `unreadable`,**不许**落到
 *      「已接回 / 会被接回 / 已收口」任何一档(那是这个项目修过一次的谎)。
 *   2. **接回的判据是「回合」,不是「消息」**:用户/平台通知落在记录之后不算接回。
 *   3. **有可执行待办 ⇒ 会被接回**,排在「在等你」之前:两者同时成立时平台照样会动。
 *
 * ⚠️ **合规告警在这一层没有状态,也不该有**(`orgRuntime().compliance` 是原样的记录):
 * 那一个回合确实没留工作记录,平台不替模型补 —— 任何「已解决」都是编造现场。
 */
import { describe, expect, it } from "vitest";
import type { MemberActivityView, ProjectLiveView, SessionMessageView } from "@shared/types/platform";
import { liveHeadline, needsAttention, orgRuntime, stopState } from "@/lib/orgState";
import { collectPlatformNotices } from "@/lib/platformNotices";

const T0 = 1_700_000_000_000;

/** 真机原文(与 `tests/web/platform-notices.test.ts` 同一份,逐字不改写)。 */
const REAL_STOP =
  "⚠️ 组织停止推进(8 次派发 · 其中 2 个真回合):已达单次排空上限 8 次派发(其中 2 个真回合)," +
  "仍有待办没跑完 —— 已停下(不是静默停:这条会广播并落库)\n本轮路径:pm → wk → wk → pm → wk → wk → pm → qa";
const REAL_COMPLIANCE =
  "⚠️ 平台检测:平台叫醒的回合没留工作记录(未调 tell_client,正文也没有行首标记)\n" +
  "项目 pj_x · bm · 回合 msg_1\n待办类别 report_downstream;成功投递的 tell_client 0 次(共调用 0 次);" +
  "收尾时项目级未消费事件 4 条\n正文前 120 字:[工作记录] …";

function agent(over: Partial<MemberActivityView> = {}): MemberActivityView {
  return {
    agentId: "wk",
    turn: null,
    currentWorks: [],
    readyWorks: 0,
    waitingWorks: 0,
    todos: [],
    exhaustedTodos: 0,
    lastMessage: null,
    ...over,
  };
}

function live(over: Partial<ProjectLiveView> = {}): ProjectLiveView {
  return {
    projectId: "pj_x",
    at: T0,
    runtime: "host",
    dispatch: { intervalMs: 10_000, lastRunAgeMs: 4_000, draining: false },
    runningTurns: 0,
    openWorks: 1,
    pendingQuestions: 0,
    agents: [agent()],
    ...over,
  };
}

function msg(
  id: string,
  kind: SessionMessageView["kind"],
  content: string,
  createdAt: number,
): Pick<SessionMessageView, "id" | "kind" | "content" | "createdAt"> {
  return { id, kind, content, createdAt };
}

describe("stopState · 停止推进的五档判据", () => {
  const base = { createdAt: T0, turnsAfter: 0 };

  it("⚠️ **读不到**优先于一切:`live === null` 不许落到任何「已接回 / 空闲」档", () => {
    // 负样本的关键:即便「之后又落了 5 个回合」,读不到运行态也只能说读不到
    const s = stopState({ ...base, live: null, turnsAfter: 5 });
    expect(s.key).toBe("unreadable");
    expect(s.why).toContain("读不到");
    expect(s.action).toContain("读不到不等于空闲");
    expect(needsAttention(s), "读不到不是「要你动手」,别把它染成告警色").toBe(false);
  });

  it("此刻有回合在跑 / 正在排空 ⇒ 正在接回", () => {
    expect(stopState({ ...base, live: live({ runningTurns: 2 }), turnsAfter: 0 }).key).toBe("resumed");
    expect(
      stopState({
        ...base,
        live: live({ dispatch: { intervalMs: 10_000, lastRunAgeMs: 1_000, draining: true } }),
        turnsAfter: 0,
      }).label,
    ).toBe("正在接回");
  });

  it("这条之后又落了回合 ⇒ 已接回(判据是**回合**,不是任何消息)", () => {
    const s = stopState({ ...base, live: live({ openWorks: 1 }), turnsAfter: 3 });
    expect(s.key).toBe("resumed");
    expect(s.why).toContain("又有 3 个回合");
  });

  it("还有可执行待办 ⇒ **会被接回**(兜底定时器每 10 s 重查),且判据里带上心跳", () => {
    const s = stopState({
      ...base,
      live: live({ agents: [agent({ todos: [{ kind: "execute_work", label: "干活", attempts: 1, maxAttempts: 3, target: "w1" }] })] }),
      turnsAfter: 0,
    });
    expect(s.key).toBe("will_resume");
    expect(s.why).toContain("1 条可执行待办");
    expect(s.why).toContain("10s");
    expect(s.why).toContain("4s 前");
    expect(s.action).toBe("不需要你动作");
  });

  it("⚠️ 待办与「等你答」同时成立 ⇒ 说**会被接回**,不说「在等你」(说反会让人以为不答就不动)", () => {
    const s = stopState({
      ...base,
      live: live({
        pendingQuestions: 2,
        agents: [agent({ todos: [{ kind: "execute_work", label: "干活", attempts: 0, maxAttempts: 3, target: "w1" }] })],
      }),
      turnsAfter: 0,
    });
    expect(s.key).toBe("will_resume");
    expect(needsAttention(s)).toBe(false);
  });

  it("没有可执行待办、但有问题等甲方 ⇒ 在等你(这一档要人动手)", () => {
    const s = stopState({ ...base, live: live({ pendingQuestions: 2, openWorks: 1 }), turnsAfter: 0 });
    expect(s.key).toBe("waiting_client");
    expect(s.action).toContain("待办");
    expect(needsAttention(s)).toBe(true);
  });

  it("**预算用尽 ⇒ 不会自愈** —— 这一档才是真的要人看", () => {
    const s = stopState({
      ...base,
      live: live({ agents: [agent({ exhaustedTodos: 3 })] }),
      turnsAfter: 0,
    });
    expect(s.key).toBe("stalled");
    expect(s.label).toBe("不会自愈");
    expect(s.why).toContain("3 条待办的尝试预算用尽");
    expect(needsAttention(s)).toBe(true);
  });

  it("未终态工作项 0 ⇒ 已收口(那一刻之后没有新的活)", () => {
    const s = stopState({ ...base, live: live({ openWorks: 0 }), turnsAfter: 0 });
    expect(s.key).toBe("done");
    expect(s.action).toBe("不需要你动作");
  });

  it("兜底档:还有未终态工作项、但可执行待办为空 ⇒ 如实说「停着且没有下一步」", () => {
    const s = stopState({ ...base, live: live({ openWorks: 4 }), turnsAfter: 0 });
    expect(s.key).toBe("stalled");
    expect(s.why).toContain("4 个未终态工作项");
    expect(s.action).toContain("「工作项」页");
  });
});

describe("orgRuntime · 两类记录分组 + 接回判据只认回合", () => {
  const rows = [
    msg("m-sys-old", "system", REAL_STOP, T0),
    msg("m-user", "user", "甲方说的话", T0 + 10), // 甲方说话**不算**接回
    msg("m-sys-note", "system", "⚠️ 平台检测:…", T0 + 20), // 平台通知也不算
    msg("m-turn", "assistant", "pm 干的活", T0 + 30), // 这才算
  ];

  it("`turnsAfter` 只数 assistant 消息:用户/平台消息落在后面不算「接回」", () => {
    const r = orgRuntime({
      messages: [msg("m-sys", "system", REAL_STOP, T0), msg("m-user", "user", "你好", T0 + 10)],
      live: live({ runningTurns: 0, openWorks: 3 }),
    });
    const s = r.stops[0]!.state;
    expect(s.key).not.toBe("resumed");
    expect(s.why).not.toContain("又有");
  });

  it("真回合落在后面 ⇒ 已接回", () => {
    const r = orgRuntime({ messages: rows, live: live({ runningTurns: 0, openWorks: 1 }) });
    expect(r.stops).toHaveLength(1);
    expect(r.stops[0]!.state.key).toBe("resumed");
    expect(r.stops[0]!.state.why).toContain("又有 1 个回合");
  });

  it("⚠️ 合规告警**不带状态**:它原样分组,不做任何派生", () => {
    const r = orgRuntime({ messages: rows, live: live() });
    expect(r.compliance.map((n) => n.id)).toEqual(["m-sys-note"]);
    expect(Object.keys(r.compliance[0]!)).not.toContain("state");
    // 而且它不该把项目页提示色点亮 —— 它是记录,不是要用户处理的事
    expect(r.attention).toBe(0);
  });

  it("需要用户动作的只数停止推进里 stalled / waiting_client 那两档", () => {
    const stalls = [
      msg("m-1", "system", REAL_STOP, T0),
      msg("m-2", "system", REAL_STOP.replace("(8 次派发", "(9 次派发"), T0 + 100),
    ];
    // 预算用尽 ⇒ 两条都 stalled ⇒ attention = 2
    const r = orgRuntime({ messages: stalls, live: live({ agents: [agent({ exhaustedTodos: 1 })] }) });
    expect(r.attention).toBe(2);
    // 换成「会被接回」⇒ attention = 0
    const r2 = orgRuntime({
      messages: stalls,
      live: live({ agents: [agent({ todos: [{ kind: "execute_work", label: "干活", attempts: 0, maxAttempts: 3, target: "w1" }] })] }),
    });
    expect(r2.attention).toBe(0);
  });

  it("分类器与 orgRuntime 同源:停止推进条数 == collectPlatformNotices().stops.length", () => {
    const n = collectPlatformNotices(rows);
    const r = orgRuntime({ messages: rows, live: live() });
    expect(r.stops.map((s) => s.notice.id)).toEqual(n.stops.map((s) => s.id));
  });
});

describe("liveHeadline · 「此刻」那一行", () => {
  it("⚠️ 读不到时明写读不到(不许渲染成空闲)", () => {
    const t = liveHeadline(null);
    expect(t).toContain("读不到");
    expect(t).not.toContain("0 个回合在跑");
  });

  it("读得到时给齐四件事实,预算用尽/等你答只在真有时才出现", () => {
    const t = liveHeadline(live({ runningTurns: 1, openWorks: 2, pendingQuestions: 0 }));
    expect(t).toContain("1 个回合在跑");
    expect(t).toContain("未终态工作项 2");
    expect(t).toContain("兜底每 10s");
    expect(t).not.toContain("预算用尽");
    expect(t).not.toContain("等你回答");

    const t2 = liveHeadline(live({ agents: [agent({ exhaustedTodos: 2 })], pendingQuestions: 1 }));
    expect(t2).toContain("预算用尽 2 条");
    expect(t2).toContain("等你回答 1 条");
  });
});
