/**
 * 全员并发板的灵魂判据(v5 Wave D,2026-11-20)
 *
 * **板渲染全部成员,与选中无关** —— 这一波要修的正是「一次只看一个」:
 * 并发是真的(忙闩键 = (项目, agent),用户回合 ∥ 内部推进可达),而页签形态
 * 要你点两次才能确认「现在有两个人在跑」。板上五张卡同屏,谁在跑一眼全见。
 *
 * 三条判据:
 *   ① 卡数 = 成员数,不随 `selectedId` 变(选谁都渲染全部 —— 板不是过滤器);
 *   ② 三态纪律在卡上成立:runtime 不是 host 时,**读不到不许点亮、不许说空闲**;
 *   ③ 实时行(`liveLineOf`)取最后一个块:工具名 / 在写摘录 / 在推演,空轮 ⇒ null。
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MemberActivityView, MemberView } from "../../shared/types/platform";
import type { Turn } from "../../web/src/stores/chat";
import { MemberBoard, liveLineOf } from "../../web/src/components/members/MemberCard";
import { formatAge } from "../../web/src/components/members/activity";

const member = (id: string, role: MemberView["role"]): MemberView =>
  ({ id, role, displayName: id, specialization: null });

const BM = member("bm", "business_manager");
const WK = member("wk", "research_worker");
const QA = member("qa", "quality_reviewer");

const activity = (
  agentId: string,
  over: Partial<MemberActivityView> = {},
): MemberActivityView =>
  ({
    agentId,
    turn: null,
    currentWorks: [],
    readyWorks: 0,
    waitingWorks: 0,
    todos: [],
    exhaustedTodos: 0,
    lastMessage: null,
    ...over,
  }) as MemberActivityView;

const board = (members: MemberView[], selectedId: string | null, activityOf: (id: string) => MemberActivityView | null, runtime: "host" | "unavailable" | null = "host") =>
  renderToStaticMarkup(
    createElement(MemberBoard, {
      members,
      selectedId,
      onSelect: vi.fn(),
      activityOf,
      issuesOf: () => 0,
      runtime,
      liveTurnsOf: () => [],
      age: (ms: number) => formatAge(ms),
    }),
  );

describe("① 板渲染全部成员,与选中无关(本波的灵魂判据)", () => {
  it("三个成员 ⇒ 三张卡;选谁都不减半(板不是过滤器)", () => {
    const acts = (id: string) => activity(id);
    expect((board([BM, WK, QA], WK.id, acts).match(/data-member-card=/g) ?? []).length).toBe(3);
    expect((board([BM, WK, QA], null, acts).match(/data-member-card=/g) ?? []).length).toBe(3);
    // 反方向同样成立(变异「只渲染选中的那张」会让这一格当场变红)
    expect((board([BM, WK, QA], BM.id, acts).match(/data-member-card=/g) ?? []).length).toBe(3);
  });

  it("只有展开的那张 aria-expanded=true", () => {
    const html = board([BM, WK, QA], WK.id, (id) => activity(id));
    expect((html.match(/aria-expanded="true"/g) ?? []).length).toBe(1);
    expect((html.match(/aria-expanded="false"/g) ?? []).length).toBe(2);
  });

  it("在跑的成员卡带「在跑 · 已跑」;没跑的说「此刻没有回合在跑」(不是「空闲」)", () => {
    const acts = (id: string) =>
      id === WK.id ? activity(id, { turn: { elapsedMs: 65_000, trigger: { kind: "user" } } }) : activity(id);
    const html = board([BM, WK], null, acts);
    expect(html).toContain("在跑 · 已跑");
    expect(html).toContain("此刻没有回合在跑");
    expect(html).not.toContain("空闲");
  });
});

describe("② 卡上的三态纪律(与面板同一份 TurnStatus)", () => {
  it("runtime 不是 host ⇒ 给灰点、说「运行态读不到」,即便快照带着 turn 也不点亮", () => {
    const acts = () =>
      activity(WK.id, { turn: { elapsedMs: 1_000, trigger: { kind: "user" } } });
    const html = board([WK], null, acts, "unavailable");
    expect(html).toContain('data-state="unknown"');
    expect(html).toContain("运行态读不到");
    expect(html, "读不到却点亮了在跑").not.toContain("在跑 · 已跑");
  });

  it("还没拿到快照 ⇒ 「正在读取运行态…」(连「读不到」都还不能断言)", () => {
    const html = board([WK], null, () => null, "host");
    expect(html).toContain("正在读取运行态…");
    expect(html).not.toContain("此刻没有回合在跑");
  });
});

describe("③ liveLineOf · 实时行(WS 在飞轮的最后一格)", () => {
  const turn = (blocks: Turn["blocks"]): Turn[] =>
    [{ id: "t1", projectId: "p1", sessionId: "s", role: "assistant", blocks, startedAt: 1, agentId: "wk", origin: { source: "unknown" } }] as unknown as Turn[];

  it("最后一个块是工具 ⇒ 「刚调 {工具名}」", () => {
    expect(
      liveLineOf(turn([
        { kind: "text", text: "先读一下" },
        { kind: "tool", tool: { id: "t", name: "code_read" } },
      ])),
    ).toBe("刚调 code_read");
  });

  it("最后是正文 ⇒ 「在写:…」(截 24 字);只有思考 ⇒ 「在推演…」", () => {
    expect(liveLineOf(turn([{ kind: "text", text: "正在合并四份报告的结论部分" }]))).toContain("在写:");
    expect(liveLineOf(turn([{ kind: "thinking", text: "推理" }]))).toBe("在推演…");
  });

  it("没有在飞轮 ⇒ null(整行不出现;在跑与否由 TurnStatus 按快照说)", () => {
    expect(liveLineOf([])).toBeNull();
  });
});
