/**
 * 「连接断了」那一格 —— 回归
 *
 * ── 现场 ────────────────────────────────────────────────────────
 *
 * 前两轮修的是「中断入口不见了」与「按下去没反应」。这一轮修的是**断线**:
 *
 *   · WS 断了之后,`PlatformSocket` 只是自己按指数退避重连 ——
 *     **不通知任何界面**(此前整个界面上没有一处看得见「连接断了」);
 *   · 本地那张轮表(`inFlight`)**永远收不到**那条 `agent_end`
 *     (WS 没有回放)⇒ 本地永远说「他在跑」⇒ **输入框永久禁用**
 *     (输入框的禁用读的就是那张表);
 *   · 中断指令在非 OPEN 时被 `send` **静默丢弃** ⇒ 「■ 停止」按下去**没有反应**;
 *   · 发出去的消息**乐观上屏**然后被静默丢弃 ⇒ **用户以为消息到了**,
 *     而服务端一条也没收到。
 *
 * ⇒ 「读不到 ≠ 没在跑」这条纪律在**传输层**也要有:连接断了就是断了,
 * 而界面必须**说这件事**(而不是装作一切正常)。
 *
 * ── 这一份钉的五件事 ────────────────────────────────────────────
 *
 *   1. `interruptAvailableOf` 的**第三格**:连接不在 OPEN ⇒ **不给中断入口**
 *      (摆一个按下去必然无效的按钮比没有按钮更坏);
 *   2. `sendMessage` / `sendInterrupt` 在断线时**如实说「没发出去」**
 *      ⇒ 调用方不清输入框、界面说清楚;
 *   3. `staleTurnIds`:重连之后按**服务端那份**对账,把本地**过期**的轮收掉
 *      (否则输入框永久死锁)—— 但**读不到时一条都不动**(读不到的时候
 *      「清掉」就是在瞎猜);
 *   4. 断线时界面**看得见**(横幅 + 发送键禁用 + 状态行);
 *   5. 接线哨兵:`ws.ts` 的 `send` **返回有没有发出去**,store 的乐观上屏
 *      **之前**查连接状态,`attachSocket` 订阅状态并在「从不通到通」时对账。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ProjectLiveView } from "@shared/types/platform";
import { interruptAvailableOf, staleTurnIds, type ChannelActivity } from "@/lib/data";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { useChatStore, type Turn } from "@/stores/chat";
import { PlatformSocket } from "@/lib/ws";
import * as api from "@/lib/api";

// ⚠️ **必须 mock 掉 `@/lib/api`** —— store 的 `refreshRunning` / `reloadCurrentMessages`
// 走的是它。mock 工厂在文件里是**被提升**的,所以里面不能引用外层的变量。
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getProjectLive: vi.fn(),
    getIntakeLive: vi.fn(),
    getProjectMessages: vi.fn(),
    getIntakeMessages: vi.fn(),
  };
});

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, "..", "..", rel), "utf8");

const chatSurface = read("web/src/components/chat/ChatSurface.tsx");
const chatComposer = read("web/src/components/chat/ChatComposer.tsx");
const wsSrc = read("web/src/lib/ws.ts");
const storeSrc = read("web/src/stores/chat.ts");

// ── 夹具 ────────────────────────────────────────────────────────

/** `interruptAvailableOf` 只读**条数** —— 空壳够用。 */
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
    runningTurns: 0,
    openWorks: 0,
    pendingQuestions: 0,
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
    ...over,
  };
}

function turn(id: string, agentId: string | null): Turn {
  return {
    id,
    projectId: "p1",
    sessionId: "s1",
    role: agentId === null ? "user" : "assistant",
    blocks: [{ kind: "text", text: "…" }],
    startedAt: 1_700_000_000_000,
    agentId,
    // ⚠️ `origin` 是**必填**的封套(见 `tests/web/fixture-envelope-fields.test.ts`):
    // 它是「这一轮是谁发起的」的唯一判据(`lib/data.ts` 的 `channelOf` 读它)。
    origin: { source: "turn", trigger: { kind: "user" } },
  } as Turn;
}

/** 一个假 socket —— `delivered` 假扮「命令到底有没有发出去」。 */
function fakeSocket(over: Partial<Record<string, unknown>> = {}): PlatformSocket {
  return {
    send: () => true,
    sendToProject: () => true,
    interrupt: () => true,
    getStatus: () => "open",
    onStatus: () => () => undefined,
    ...over,
  } as unknown as PlatformSocket;
}

/** **发不出去**的那个 socket —— 传输层断了,命令一律被丢掉。 */
function brokenSocket(onSend?: () => void): PlatformSocket {
  return fakeSocket({
    send: () => {
      onSend?.();
      return false;
    },
    sendToProject: () => {
      onSend?.();
      return false;
    },
    interrupt: () => {
      onSend?.();
      return false;
    },
    getStatus: () => "closed",
  });
}

beforeEach(() => {
  vi.mocked(api.getProjectLive).mockReset();
  vi.mocked(api.getIntakeLive).mockReset();
  vi.mocked(api.getProjectMessages).mockReset();
  vi.mocked(api.getIntakeMessages).mockReset();
  vi.mocked(api.getProjectMessages).mockResolvedValue({
    projectId: "p1",
    messages: [],
  });
  useChatStore.setState({
    projectId: "p1",
    intakeActive: false,
    sessionId: "s1",
    turns: [],
    inFlight: {},
    inFlightOrder: [],
    currentTurn: null,
    lastUserEchoId: null,
    lastUserSend: null,
    status: "idle",
    remoteRunning: null,
    error: null,
    socket: null,
    socketStatus: "open",
  });
});

// ── ① 中断入口:连接断了就不给 ────────────────────────────────────

describe("interruptAvailableOf · 连接状态那一格", () => {
  it("**正样本**:连接正常 + 本地有在飞的轮 ⇒ 能停", () => {
    expect(interruptAvailableOf(activity(1, 0), null, "open")).toBe(true);
  });

  it("⚠️ **负样本**:连接断了 ⇒ **不给入口**(按下去的命令会被静默丢弃)", () => {
    // 「服务端说在跑」也不给 —— 那一格更危险:按钮亮着,按下去什么也不会发生。
    expect(interruptAvailableOf(activity(1, 0), { client: true, internal: false }, "closed")).toBe(
      false,
    );
  });

  it("⚠️ **负样本**:还在连(connecting)⇒ 也不给(命令同样发不出去)", () => {
    expect(interruptAvailableOf(NOTHING, { client: true, internal: false }, "connecting")).toBe(
      false,
    );
  });
});

// ── ② 过期的那几轮:重连之后要收掉 ────────────────────────────────

describe("staleTurnIds · 本地那一格过期了哪些轮", () => {
  const running = new Set(["bm"]);

  it("**正样本**:服务端说这个 agent 不在跑 ⇒ 本地那条就是过期的", () => {
    expect(staleTurnIds([{ id: "t1", agentId: "wk" }], running)).toEqual(["t1"]);
  });

  it("**负样本**:服务端说它还在跑 ⇒ 不许收(那是真在跑的一轮)", () => {
    expect(staleTurnIds([{ id: "t1", agentId: "bm" }], running)).toEqual([]);
  });

  it("⚠️ **负样本**:服务端那份**读不到**(`null`)⇒ 一条都不动", () => {
    // 读不到的时候「清掉」就是在瞎猜 —— 而猜错的后果是「正在跑的一轮凭空消失」。
    expect(staleTurnIds([{ id: "t1", agentId: "wk" }], null)).toEqual([]);
  });

  it("⚠️ **负样本**:`agentId === null`(甲方自己那句乐观上屏)⇒ 不归它管", () => {
    expect(staleTurnIds([{ id: "t1", agentId: null }], running)).toEqual([]);
  });
});

// ── ③ 断线时发不出去:如实说 ──────────────────────────────────────

describe("store · 断线时发送", () => {
  it("⚠️ 断线时 `sendMessage` **如实说没发出去**(返回 false)", () => {
    useChatStore.setState({ socket: brokenSocket(), socketStatus: "closed" });
    const ok = useChatStore.getState().sendMessage("在吗");
    expect(ok).toBe(false);
    expect(useChatStore.getState().error?.code).toBe("socket_disconnected");
  });

  it("⚠️ 断线时**不许乐观上屏**(那句话压根没发出去)", () => {
    useChatStore.setState({ socket: brokenSocket(), socketStatus: "closed" });
    useChatStore.getState().sendMessage("在吗");
    // 上屏了就是「用户以为消息到了」—— 而服务端一条也没收到。
    expect(useChatStore.getState().turns).toEqual([]);
  });

  it("**正样本**:连接正常 ⇒ 照旧乐观上屏并返回 true", () => {
    useChatStore.setState({ socket: fakeSocket(), socketStatus: "open" });
    const ok = useChatStore.getState().sendMessage("在吗");
    expect(ok).toBe(true);
    expect(useChatStore.getState().turns).toHaveLength(1);
    expect(useChatStore.getState().error).toBeNull();
  });
});

describe("store · 断线时中断", () => {
  it("⚠️ 断线时 `sendInterrupt` **返回 false**,并如实说「没发出去」", () => {
    // ⚠️ **判据是 socket 返回的那个 `false`**(它看的是 `ws.readyState`)——
    // 界面那份状态镜像只管显示。store 拿到的答复是「没发出去」⇒ 就必须说出来。
    const attempted: (string | null)[] = [];
    useChatStore.setState({
      socket: brokenSocket(() => attempted.push("stop")),
      socketStatus: "closed",
    });
    const ok = useChatStore.getState().sendInterrupt();
    expect(ok).toBe(false);
    expect(useChatStore.getState().error?.code).toBe("socket_disconnected");
    expect(useChatStore.getState().error?.message).toContain("没发出去");
  });

  it("**正样本**:连接正常 ⇒ 指令真的发出去", () => {
    const sent: (string | null)[] = [];
    useChatStore.setState({
      socket: fakeSocket({ interrupt: (p: string | null) => sent.push(p) }),
      socketStatus: "open",
    });
    const ok = useChatStore.getState().sendInterrupt();
    expect(ok).toBe(true);
    expect(sent).toEqual(["p1"]);
  });
});

// ── ④ 重连之后对账:把过期的那几轮收掉 ────────────────────────────

describe("store · resyncAfterReconnect", () => {
  it("**正样本**:服务端说那一轮**不在跑** ⇒ 本地那条收掉(输入框不再死锁)", async () => {
    useChatStore.setState({
      inFlight: { t1: turn("t1", "bm") },
      inFlightOrder: ["t1"],
    });
    vi.mocked(api.getProjectLive).mockResolvedValue({ live: projectLive() });
    await useChatStore.getState().resyncAfterReconnect();
    expect(useChatStore.getState().inFlight).toEqual({});
    expect(useChatStore.getState().inFlightOrder).toEqual([]);
  });

  it("**负样本**:服务端说它**还在跑** ⇒ 不许收(那是真在跑的一轮)", async () => {
    useChatStore.setState({
      inFlight: { t1: turn("t1", "bm") },
      inFlightOrder: ["t1"],
    });
    vi.mocked(api.getProjectLive).mockResolvedValue({
      live: projectLive({
        runningTurns: 1,
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
      }),
    });
    await useChatStore.getState().resyncAfterReconnect();
    expect(useChatStore.getState().inFlightOrder).toEqual(["t1"]);
  });

  it("⚠️ **负样本**:服务端那份**读不到** ⇒ 一条都不动(不许瞎猜)", async () => {
    useChatStore.setState({
      inFlight: { t1: turn("t1", "bm") },
      inFlightOrder: ["t1"],
    });
    vi.mocked(api.getProjectLive).mockResolvedValue({ live: projectLive({ runtime: "unavailable" }) });
    await useChatStore.getState().resyncAfterReconnect();
    expect(useChatStore.getState().inFlightOrder).toEqual(["t1"]);
  });
});

describe("PlatformSocket · 传输层", () => {
  /** 假 WebSocket —— `readyState` 说了算,`send` 记录。 */
  function fakeWs(readyState: number, sent: string[]): unknown {
    return class {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = readyState;
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) {}
      send(data: string): void {
        sent.push(data);
      }
      close(): void {}
    };
  }

  function withSocket<T>(readyState: number, fn: (sock: PlatformSocket, sent: string[]) => T): T {
    const sent: string[] = [];
    vi.stubGlobal("WebSocket", fakeWs(readyState, sent));
    vi.stubGlobal("window", { location: { protocol: "http:", host: "127.0.0.1:5173" } });
    try {
      const sock = new PlatformSocket("/ws");
      sock.connect();
      return fn(sock, sent);
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("⚠️ 连接不在 OPEN ⇒ `send` **返回 false**(静默丢弃 = 用户以为消息到了)", () => {
    withSocket(3, (sock) => {
      expect(sock.send({ type: "ping" })).toBe(false);
      expect(sock.sendToProject("p1", "在吗")).toBe(false);
      expect(sock.interrupt("p1")).toBe(false);
    });
  });

  it("**正样本**:连接在 OPEN ⇒ 真的发了,且返回 true", () => {
    withSocket(1, (sock, sent) => {
      expect(sock.sendToProject("p1", "在吗")).toBe(true);
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0]!).type).toBe("send");
    });
  });
});

// ── ⑤ 断线这件事要看得见 ──────────────────────────────────────────

describe("ChatComposer · 断线时", () => {
  const base = {
    value: "在吗",
    onChange: () => undefined,
    onSubmit: () => true,
  };

  it("⚠️ 断线时**发送键是死的**,并说清楚为什么(不是「发送 ⏎」)", () => {
    const html = renderToStaticMarkup(
      createElement(ChatComposer, { ...base, connection: "closed" }),
    );
    expect(html).toContain("连接断了");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>\s*连接断了\s*<\/button>/);
  });

  it("⚠️ 断线时状态行**说连接断了**(不是「就绪」—— 那是在说「没事」)", () => {
    const html = renderToStaticMarkup(
      createElement(ChatComposer, { ...base, connection: "closed" }),
    );
    expect(html).toContain("连接已断开");
    expect(html).not.toContain("就绪");
  });

  it("⚠️ **「还在连」与「已经断了」是两种故障** —— 界面不许把前者说成后者", () => {
    const html = renderToStaticMarkup(
      createElement(ChatComposer, { ...base, connection: "connecting" }),
    );
    expect(html).toContain("连接中");
    expect(html).not.toContain("连接断了");
    expect(html).not.toContain("已断开");
  });

  it("⚠️ 断线时**输入框仍然可用**(用户那句话还在他手里 —— 不许替他锁死)", () => {
    const html = renderToStaticMarkup(
      createElement(ChatComposer, { ...base, connection: "closed" }),
    );
    // ⚠️ 判据落在 textarea 上:只有 textarea 是 disabled 才算锁死。
    expect(html).toMatch(/<textarea(?![^>]*disabled)[^>]*>/);
  });

  it("⚠️ 断线时**不给中断入口**(那条指令发不出去)", () => {
    const html = renderToStaticMarkup(
      createElement(ChatComposer, {
        ...base,
        connection: "closed",
        interruptible: false,
        onInterrupt: () => undefined,
      }),
    );
    expect(html).not.toMatch(/<button[^>]*>\s*■ 停止\s*<\/button>/);
  });

  it("⚠️ **没发出去就不许清输入框**(用户那句话还在他手里)", () => {
    // 判据落在源码上:`onSubmit` 返回 false ⇒ 不调 `onChange("")`。
    const stripped = chatComposer
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(stripped).toContain("if (onSubmit(t) === false) return;");
    // ⚠️ 顺序也重要:清空**必须**在判据之后。
    expect(stripped.indexOf("if (onSubmit(t) === false) return;")).toBeLessThan(
      stripped.indexOf('onChange("")'),
    );
  });
});

describe("接线 · 连接状态", () => {
  it("对话页**看得见**「连接断了」(横幅)", () => {
    expect(chatSurface).toContain("socketStatus");
    expect(chatSurface).toContain("连接已断开");
  });

  it("⚠️ `ws.ts` 的 `send` **返回有没有发出去**(静默丢弃 = 用户以为消息到了)", () => {
    const stripped = wsSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(stripped).toMatch(/send\(cmd: ClientCommand\): boolean/);
    expect(stripped).toMatch(/sendToProject\([^)]*\): boolean/);
    expect(stripped).toMatch(/interrupt\([^)]*\): boolean/);
  });

  it("⚠️ 发送没发出去 ⇒ **把那句乐观上屏撤掉**(那句话不许留在屏幕上假装到了)", () => {
    // ⚠️ 乐观上屏**在发送之前**做(服务端回显假设它已经上屏)⇒ 失败时要**撤掉**。
    // 不撤 = 用户看着自己的话稳稳地停在屏幕上,而服务端一条也没收到。
    const stripped = storeSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const send = stripped.slice(stripped.indexOf("sendMessage(text): boolean"));
    const notDelivered = send.indexOf("if (!delivered)");
    const rollback = send.indexOf("s.turns.filter((t) => t !== gone)");
    expect(notDelivered).toBeGreaterThan(-1);
    expect(rollback).toBeGreaterThan(notDelivered);
  });

  it("⚠️ `attachSocket` 订阅连接状态,并在「从不通到通」时对账", () => {
    const stripped = storeSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(stripped).toContain("socket.onStatus(");
    expect(stripped).toContain('if (st === "open" && was !== "open") void get().resyncAfterReconnect();');
  });
});
