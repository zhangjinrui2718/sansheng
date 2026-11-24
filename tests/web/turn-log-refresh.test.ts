/**
 * 「他做了什么」:随工具调用刷新 + 未结束的回合被标出来(2026-11-25)· 回归
 *
 * ── 这个机制补的是什么 ──────────────────────────────────────────
 *
 * 轨迹行(`turn_events`)此前在回合收口时整批落库,于是:
 *   ① 回合进行中,成员面板那一块一个字都不长 —— 长回合里只能看实时流,
 *      刷新一下页面就什么都没有了;
 *   ② 断线期间落库的行,重连之后没人去取(WS 没有回放)。
 * 现在工具行每次调用结束就落库,**服务端先写行、后广播 `tool_end`** ——
 * 前端在 `tool_end` 上敲 `turnLogRevision`,成员面板那一块据此重拉;
 * 没收口的回合带 `finished: false`,界面标「未结束」。
 *
 * ── 钉住的四件事 ────────────────────────────────────────────────
 *
 *   ① `tool_end`(且**只有** `tool_end`)敲那一下 —— `tool_start` 不敲:
 *      那时行还没写,拉回来的是旧数据;
 *   ② 本地轮表里有没有那一轮都敲(刷新之后轮表是空的,轨迹照样在长);
 *   ③ 重连对账时**无条件**敲 —— 哪怕运行态读不到(`/live` 为 null);
 *   ④ 界面:没收口的回合有标记,已收口的没有(负样本不许一起亮)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentTurnView, ProjectLiveView, ServerEvent } from "@shared/types/platform";
import { AgentTurnLogBody } from "@/components/members/AgentTurnLog";
import { useChatStore } from "@/stores/chat";
import * as api from "@/lib/api";

// 重连对账会问运行态(`refreshRunning` 走 `@/lib/api`)—— 必须 mock,
// 否则测试会真的去发 HTTP 请求。
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getProjectLive: vi.fn(),
    getIntakeLive: vi.fn(),
  };
});

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, "..", "..", rel), "utf8");

/** 只留**可见正文**:去掉标签(属性跟在一起一起走)与 SSR 插的 `<!-- -->`。 */
const visible = (html: string): string =>
  html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, "");

// ── 夹具 ────────────────────────────────────────────────────────

const P = "p1";

function turnView(over: Partial<AgentTurnView> = {}): AgentTurnView {
  return {
    turnId: "turn_1",
    sessionId: "s1",
    workId: null,
    createdAt: 1_700_000_000_000,
    finished: true,
    events: [
      { seq: 1, kind: "tool", tool: "board_list", argsSummary: "{}", resultSummary: "3 条工件", isError: false, durationMs: 12 },
    ],
    ...over,
  };
}

const liveNobodyRunning = (): ProjectLiveView => ({
  projectId: P,
  at: 1_700_000_000_000,
  runtime: "host",
  dispatch: { intervalMs: 10_000, lastRunAgeMs: 1_000, draining: false },
  runningTurns: 0,
  openWorks: 0,
  pendingQuestions: 0,
  agents: [],
});

const toolEnd = (projectId: string): ServerEvent => ({
  type: "tool_end", projectId, sessionId: "s1", messageId: "m-ghost",
  tool: { id: "t1", name: "board_list", result: { content: [] }, isError: false },
});

const rev = (): number => useChatStore.getState().turnLogRevision;

beforeEach(() => {
  vi.mocked(api.getProjectLive).mockReset();
  vi.mocked(api.getIntakeLive).mockReset();
  useChatStore.setState({
    projectId: P,
    intakeActive: false,
    sessionId: "s1",
    turns: [],
    // ⚠️ 轮表**故意是空的**:「刷新页面之后」就是这个形状 —— 轨迹照样要能长。
    inFlight: {},
    inFlightOrder: [],
    currentTurn: null,
    remoteRunning: null,
    turnLogRevision: 0,
  });
});

// ── ① ② ③ store ────────────────────────────────────────────────

describe("turnLogRevision · 什么时候敲这一下", () => {
  it("① 正样本:`tool_end` 敲一下 —— 本地轮表里**没有**那一轮也敲(刷新之后就是这种形状)", () => {
    useChatStore.getState().applyEvent(toolEnd(P));
    expect(rev()).toBe(1);
    // 轮表没被这次事件建出一轮来(找不到就丢 —— 那条纪律没变)。
    expect(useChatStore.getState().inFlight).toEqual({});
  });

  it("① 负样本:`tool_start` **不**敲 —— 那时行还没写,拉回来的是旧数据", () => {
    useChatStore.getState().applyEvent({
      type: "tool_start", projectId: P, sessionId: "s1", messageId: "m-ghost",
      agentId: "wk", tool: { id: "t1", name: "board_list", args: {} },
    });
    expect(rev()).toBe(0);
  });

  it("① 负样本:别的项目的 `tool_end` 不敲 —— 成员面板只显示当前项目的人", () => {
    useChatStore.getState().applyEvent(toolEnd("p-other"));
    expect(rev()).toBe(0);
  });

  it("③ 重连对账时敲一下 —— 运行态**读不到**(`/live` 为 null)也照敲:轨迹是库里的行", async () => {
    vi.mocked(api.getProjectLive).mockResolvedValue(null);
    await useChatStore.getState().resyncAfterReconnect();
    expect(rev()).toBe(1);
  });

  it("③ 重连对账时敲一下 —— 没有过期轮(提前 return 的那条路)也照敲", async () => {
    vi.mocked(api.getProjectLive).mockResolvedValue(liveNobodyRunning());
    await useChatStore.getState().resyncAfterReconnect();
    expect(rev()).toBe(1);
  });
});

// ── 接线哨兵(源码级)───────────────────────────────────────────

describe("接线 · 取数钩子读的是这一位", () => {
  it("`useAgentTurnEvents` 的依赖里有 `turnLogRevision` —— 没有它,敲了也没人重拉", () => {
    const src = read("web/src/lib/data.ts");
    const fn = src.slice(src.indexOf("export function useAgentTurnEvents"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("s.turnLogRevision");
    expect(body).toMatch(/\[projectId, agentId, revision, turnLogRevision\]/);
  });

  it("store 在 `tool_end` 分支里**先敲再判轮表**(顺序写反 = 刷新之后永远不敲)", () => {
    const src = read("web/src/stores/chat.ts");
    const branch = src.slice(src.indexOf('case "tool_end": {'), src.indexOf('case "message_end": {'));
    const bumpAt = branch.indexOf("turnLogRevision:");
    const earlyReturnAt = branch.indexOf("if (!cur) return;");
    expect(bumpAt).toBeGreaterThan(-1);
    // `if (cur === undefined) return;` 的等价写法也算 —— 判的是「敲」在「提前返回」之前。
    expect(bumpAt).toBeLessThan(earlyReturnAt);
  });
});

// ── ④ 界面 ──────────────────────────────────────────────────────

describe("AgentTurnLogBody · 未结束的回合被标出来", () => {
  function render(turns: readonly AgentTurnView[]): string {
    return renderToStaticMarkup(
      createElement(AgentTurnLogBody, { agentName: "研究员", turns, loading: false, error: null }),
    );
  }

  it("④ 正样本:没收口的回合带「未结束」,折叠标题里也计数(默认收起也要看得出有回合在长)", () => {
    const text = visible(render([
      turnView({ turnId: "turn_open", finished: false }),
      turnView({ turnId: "turn_done", finished: true }),
    ]));
    expect(text).toContain("未结束");
    expect(text).toContain("1 个未结束");
    expect(text).toContain("行会继续增加");
  });

  it("④ 负样本:全部已收口 ⇒ 没有标记、没有说明行(「未结束」不许常亮)", () => {
    const text = visible(render([turnView(), turnView({ turnId: "turn_2" })]));
    expect(text).not.toContain("未结束");
    expect(text).not.toContain("行会继续增加");
  });

  it("说明行不许把「未收口」说成「还在跑」—— 读面分不开它与「进程中途退出」", () => {
    const text = visible(render([turnView({ finished: false })]));
    expect(text).not.toContain("正在跑");
    expect(text).not.toContain("进行中");
  });
});
