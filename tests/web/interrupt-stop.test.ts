/**
 * 「停止对话」的能力 —— 回归
 *
 * ── 现场(用户原话)──────────────────────────────────────────────
 *
 *   「和业务经理聊天的时候 没有停止对话的能力」
 *
 * ── 为什么它必然发生(不是「没做」,是「做了但有一格是空的」)─────
 *
 * 中断链路**一直都在**:`ClientCommand.interrupt`(`shared/types/platform.ts`)
 * → `hub.onInterrupt` → `AgentSession.abort()`
 * (`src/platform/host/serve.ts` 的 `inflight` 登记表;端到端回归在
 * `tests/platform/interrupt.test.ts`)。界面上也**一直**有一个「■ 中断」按钮。
 *
 * 但那按钮的可见性只数**本地在飞的轮**(`liveCount`),而:
 *
 *   · `selectProject` / `selectSession` / 刷新页面都会清 `inFlight`(WS 没有回放);
 *   · 于是「刷新时正好有一轮在跑」⇒ **按钮不见了**;
 *   · `ChatComposer` 的 Esc 武装条件是 `disabled && reason === "streaming"`,
 *     而那一刻输入框**没被禁用**(本地没有在飞的轮)⇒ **Esc 也不武装**;
 *   · 而顶部那盏灯**照样显示「推演中」** —— 它读的是服务端那份运行态
 *     (`remoteRunning`,`GET /live` / `GET /api/intake/live`)。
 *
 * ⇒ 屏幕上写着「推演中」,手上却没有任何办法停下来。
 * 更糟的是:此时再发一条,服务端的忙闩会拒,原文是
 * 「与你对话的那位正在跑一个回合,等它结束或**先中断**」——
 * **服务端叫你先中断,而界面上没有中断的入口**。
 *
 * ── 这一份钉的四件事 ────────────────────────────────────────────
 *
 *   1. 判据只有一处(`lib/data.ts` 的 `interruptAvailableOf`):本地在飞 **或**
 *      服务端说在跑 ⇒ 能停;**读不到(`null`)⇒ 不给入口**(摆一个按下去必然无效的
 *      按钮比没有按钮更坏 —— 它是一句自信的假话);
 *   2. 停止按钮在**输入区**里(就在「发送」旁边),可见性只看「能不能停」;
 *   3. **Esc 的武装条件是「能不能停」**,不是「输入框被禁用」;
 *   4. 服务端说「读不到运行态」(`runtime !== "host"`)时,**不许**被读成
 *      「一个人都没在跑」—— 那会把「读不到」说成「空闲」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { IntakeLiveView, ProjectLiveView } from "@shared/types/platform";
import { interruptAvailableOf, type ChannelActivity } from "@/lib/data";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { useChatStore, type Turn } from "@/stores/chat";
import * as api from "@/lib/api";

// ⚠️ **必须 mock 掉 `@/lib/api`** —— store 的 `refreshRunning` 走的是它。
// mock 工厂在文件里是**被提升**的,所以里面不能引用外层的变量。
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

const chatSurface = read("web/src/components/chat/ChatSurface.tsx");
const chatComposer = read("web/src/components/chat/ChatComposer.tsx");
const messageList = read("web/src/components/chat/MessageList.tsx");
const historyRail = read("web/src/components/shell/HistoryRail.tsx");

// ── 夹具 ────────────────────────────────────────────────────────

/** `surfaceStatusOf` / `interruptAvailableOf` 只读**条数**,不看内容 —— 空壳够用。 */
function activity(client: number, internal: number): ChannelActivity {
  const mk = (n: number) => Array.from({ length: n }, () => ({}) as Turn);
  return { client: mk(client), internal: mk(internal), system: [] };
}

const NOTHING = activity(0, 0);

function projectLive(over: Partial<ProjectLiveView> = {}): ProjectLiveView {
  return {
    projectId: "p1",
    at: 1_700_000_000_000,
    runtime: "host",
    dispatch: { intervalMs: 10_000, lastRunAgeMs: 1_000, draining: false },
    runningTurns: 1,
    openWorks: 0,
    pendingQuestions: 0,
    agents: [
      {
        agentId: "bm",
        turn: { elapsedMs: 1_000, trigger: { kind: "user" } },
        currentWorks: [],
        readyWorks: 0,
        waitingWorks: 0,
        todos: [],
        exhaustedTodos: 0,
        lastMessage: null,
      },
    ],
    ...over,
  };
}

function intakeLive(over: Partial<IntakeLiveView> = {}): IntakeLiveView {
  return {
    at: 1_700_000_000_000,
    runtime: "host",
    runningTurns: 1,
    turns: [{ agentId: "bm", elapsedMs: 1_000, trigger: { kind: "user" } }],
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(api.getProjectLive).mockReset();
  vi.mocked(api.getIntakeLive).mockReset();
  useChatStore.setState({
    projectId: "p1",
    intakeActive: false,
    sessionId: null,
    turns: [],
    inFlight: {},
    inFlightOrder: [],
    currentTurn: null,
    lastUserEchoId: null,
    status: "idle",
    remoteRunning: null,
    error: null,
  });
});

// ── ① 判据:能不能停 ─────────────────────────────────────────────

describe("interruptAvailableOf · 「此刻能不能停」", () => {
  it("**正样本**:本地有在飞的轮(甲方通道)⇒ 能停", () => {
    expect(interruptAvailableOf(activity(1, 0), null)).toBe(true);
  });

  it("**正样本**:本地有在飞的轮(内部通道)⇒ 也能停 —— 内部那一轮同样在烧 token", () => {
    expect(interruptAvailableOf(activity(0, 1), null)).toBe(true);
  });

  it("**正样本**:本地没有、但服务端说甲方通道在跑 ⇒ 能停(刷新之后的那一格)", () => {
    expect(interruptAvailableOf(NOTHING, { client: true, internal: false })).toBe(true);
  });

  it("**正样本**:本地没有、但服务端说内部在跑 ⇒ 能停", () => {
    expect(interruptAvailableOf(NOTHING, { client: false, internal: true })).toBe(true);
  });

  it("**负样本**:服务端说一个人都没在跑 ⇒ 不给入口", () => {
    expect(interruptAvailableOf(NOTHING, { client: false, internal: false })).toBe(false);
  });

  it("⚠️ **负样本**:`null` = **读不到**,不许当成「没在跑」以外的任何东西", () => {
    // 「读不到」既不是「没在跑」也不是「在跑」⇒ 不给中断入口。
    // 摆一个按下去必然无效的按钮,比没有按钮更坏(自信的假话)。
    expect(interruptAvailableOf(NOTHING, null)).toBe(false);
  });
});

// ── ② 停止按钮在输入区里 ─────────────────────────────────────────

describe("ChatComposer · 停止按钮", () => {
  const base = {
    value: "",
    onChange: () => undefined,
    onSubmit: () => undefined,
  };

  it("**正样本**:「能停」⇒ 输入区里有可点的「■ 停止」", () => {
    const html = renderToStaticMarkup(
      createElement(ChatComposer, {
        ...base,
        interruptible: true,
        onInterrupt: () => undefined,
      }),
    );
    // ⚠️ **必须断言「那是个 button」**,不能只断言「页面里有这几个字」——
    // 状态行里也写着「■ 停止」,只断言字面量的话:把按钮删掉而留下那行提示,
    // 断言照样绿(变异 M3 实测过:它抓不住的就是这一种)。
    expect(html).toMatch(/<button[^>]*>\s*■ 停止\s*<\/button>/);
  });

  it("**负样本**:「不能停」⇒ 没有那个按钮(别让一个按了没用的按钮常驻)", () => {
    const html = renderToStaticMarkup(
      createElement(ChatComposer, {
        ...base,
        interruptible: false,
        onInterrupt: () => undefined,
      }),
    );
    expect(html).not.toMatch(/<button[^>]*>\s*■ 停止\s*<\/button>/);
  });

  it("⚠️ 输入框可用、但确实有回合在跑时,那一行**不许**说「就绪」", () => {
    const html = renderToStaticMarkup(
      createElement(ChatComposer, {
        ...base,
        interruptible: true,
        onInterrupt: () => undefined,
      }),
    );
    expect(html).not.toContain("就绪");
    expect(html).toContain("有回合在跑");
  });
});

// ── ③ Esc 的武装条件 ─────────────────────────────────────────────

describe("ChatComposer · Esc", () => {
  it("⚠️ Esc 武装看的是「能不能停」,不是「输入框被禁用」", () => {
    // 此前是 `disabled && reason === "streaming"`:刷新之后本地轮表是空的
    // ⇒ 输入框没被禁用 ⇒ Esc 不武装 ⇒ 用户按 Esc 什么也没发生。
    const stripped = chatComposer.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(stripped).toContain("const canInterrupt = !!interruptible && !!onInterrupt;");
    expect(stripped).not.toContain('reason === "streaming" && !!onInterrupt');
  });
});

// ── ④ 服务端那份运行态:「读不到」不许被读成「没在跑」 ─────────────

describe("store · refreshRunning", () => {
  it("**正样本**:服务端说甲方通道在跑 ⇒ 记成运行态(那盏灯与中断入口都靠它)", async () => {
    vi.mocked(api.getProjectLive).mockResolvedValue({ live: projectLive() });
    await useChatStore.getState().refreshRunning();
    expect(useChatStore.getState().remoteRunning).toEqual({ client: true, internal: false });
  });

  it("**正样本**:接待会话同样有这一份(那条端点以前是 404)", async () => {
    useChatStore.setState({ projectId: null, intakeActive: true });
    vi.mocked(api.getIntakeLive).mockResolvedValue({ live: intakeLive() });
    await useChatStore.getState().refreshRunning();
    expect(useChatStore.getState().remoteRunning).toEqual({ client: true, internal: false });
  });

  it("⚠️ **负样本**:`runtime !== \"host\"` = **读不到** ⇒ 不许被读成「一个人都没在跑」", async () => {
    // 运行态没接上的装配里 `agents[].turn` 全是 `null` —— 那不是「没在跑」。
    vi.mocked(api.getProjectLive).mockResolvedValue({
      live: projectLive({
        runtime: "unavailable",
        runningTurns: 0,
        agents: [
          {
            agentId: "bm",
            turn: null,
            currentWorks: [],
            readyWorks: 0,
            waitingWorks: 0,
            todos: [],
            exhaustedTodos: 0,
            lastMessage: null,
          },
        ],
      }),
    });
    await useChatStore.getState().refreshRunning();
    // 「没有服务端信息」≠ 「服务端说没人跑」:前者是 null,后者才是 false/false。
    expect(useChatStore.getState().remoteRunning).toBeNull();
  });

  it("⚠️ **负样本**:取数失败 ⇒ 也是 null(读不到),不是「没在跑」", async () => {
    vi.mocked(api.getProjectLive).mockRejectedValue(new Error("boom"));
    await useChatStore.getState().refreshRunning();
    expect(useChatStore.getState().remoteRunning).toBeNull();
  });
});

describe("store · 服务端说「他正忙着」", () => {
  it("**正样本**:`busy` 不是故障 —— 记成运行态证据(界面于是有中断入口)", () => {
    useChatStore.getState().applyEvent({
      type: "error",
      projectId: "p1",
      error: { code: "busy", message: "与你对话的那位正在跑一个回合,等它结束或先中断" },
    });
    const s = useChatStore.getState();
    expect(s.remoteRunning?.client).toBe(true);
    // 顶灯不许变红 —— 「出错」是给真故障的,这一条的意思是「他在忙」。
    expect(s.status).not.toBe("error");
  });

  it("⚠️ **负样本**:别的故障仍然照旧是「出错」(不许把这一条放得过宽)", () => {
    useChatStore.getState().applyEvent({
      type: "error",
      projectId: "p1",
      error: { code: "turn_failed", message: "boom" },
    });
    expect(useChatStore.getState().status).toBe("error");
    expect(useChatStore.getState().remoteRunning).toBeNull();
  });

  it("⚠️ 回合收口后,那条拒收**过期**(否则「他在跑」变成一句过期的事实)", () => {
    useChatStore.getState().applyEvent({
      type: "error",
      projectId: "p1",
      error: { code: "busy", message: "与你对话的那位正在跑一个回合,等它结束或先中断" },
    });
    expect(useChatStore.getState().error?.code).toBe("busy");
    useChatStore.getState().applyEvent({ type: "agent_end", projectId: "p1", ts: 1 });
    expect(useChatStore.getState().error).toBeNull();
  });

  it("⚠️ **负样本**:真故障的现场不许被回合收口顺手清掉", () => {
    useChatStore.getState().applyEvent({
      type: "error",
      projectId: "p1",
      error: { code: "turn_failed", message: "boom" },
    });
    useChatStore.getState().applyEvent({ type: "agent_end", projectId: "p1", ts: 1 });
    expect(useChatStore.getState().error?.code).toBe("turn_failed");
  });
});

// ── ⑤ 接线:判据只有一处,页面真的用它 ────────────────────────────

describe("接线 · 中断入口", () => {
  it("对话页用 `interruptAvailableOf` 判「能不能停」,并把它交给输入区", () => {
    expect(chatSurface).toContain("interruptAvailableOf(");
    expect(chatSurface).toContain("interruptible={interruptible}");
  });

  it("⚠️ 判据不许散成第二份 —— 页面里不许自己数「有没有在飞的轮」来判中断", () => {
    const stripped = chatSurface.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    // `liveCount` 只用来写提示文案(本地证据 vs 服务端证据),不许当判据。
    expect(stripped).not.toMatch(/liveCount\s*>\s*0\s*&&/);
    expect(stripped).not.toMatch(/\{liveCount\s*>/);
  });

  it("「他正忙着」那条拒收在对话页**看得见**(用户那句已经没发出去)", () => {
    // 静默它 = 用户以为消息到了 —— 而输入框已经被清空了。
    expect(messageList).toContain('status === "error" || error.code === "busy"');
  });

  it("⚠️ 左栏不许把「他正忙着」说成「加载失败」(那是一句假话:列表没加载失败)", () => {
    expect(historyRail).toContain('error.code.endsWith("_load_failed")');
  });
});
