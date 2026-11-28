/**
 * 补话(2026-11-25)· 回归
 *
 * ── 这个机制补的是什么 ──────────────────────────────────────────
 *
 * 甲方在业务经理**正在回答**时说的话,此前只能排队(036)等下一轮;回合越长
 * (看门狗放开了 10 分钟总时长之后尤其如此),「等一下,需求改了」就白等越久。
 * 现在它被补进当前这一轮(当前这批工具调用跑完后送进模型)。
 *
 * ── 两层判据 ────────────────────────────────────────────────────
 *
 * ① 纯函数(`runtime/steer.ts`):回执要对上的目标文本、能不能补;
 * ② 端到端:真宿主 + 真 WS + **真的适配层**(`events.ts` 的事件翻译与 `session.ts`
 *    的端口包装都是真的),只把 SDK 会话内部的队列机制做成假的 —— 假会话的行为
 *    照 SDK 源码写(`agent-session.js` 的 `_queueSteer` / `_queueUserInput`):
 *      · `steer()`:把(可能被展开的)文本排进队列,**同步**广播一次 `queue_update`,
 *        然后返回 `"queued"`;
 *      · 回合走到「这批工具调用跑完」时检查队列:逐条发 `message_start`(用户)、
 *        再发 `queue_update`(已移除);
 *      · 回合可以不消费队列就结束(补话和回合结束赛跑)。
 *
 * ── 钉住的六件事 ────────────────────────────────────────────────
 *
 *   同线补话并销账 / 没送达就不销账并清 SDK 队列 / 展开过的文本也认得出回执 /
 *   被中断不销账 / 四种退回排队(别的线、内部任务、第 4 句、会话没有 steer)。
 *   最后一格(没有 steer 的会话)由 `busy-queue.test.ts` 原样通过来证。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { serve } from "@hono/node-server";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  createPlatformHost, type PlatformHost,
} from "../../src/platform/host/serve.js";
import { attachHub } from "../../src/platform/transport/hub.js";
import { listProviders, providerEnvKey } from "../../src/platform/runtime/agentRuntime/pi/providers.js";
import { ensureOrg, ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { insertWork, getWork } from "../../src/platform/storage/repo/works.js";
import { pendingQueuedClientMessages } from "../../src/platform/storage/repo/queuedClientMessages.js";
import { normalizeSessionEvent } from "../../src/platform/runtime/agentRuntime/pi/events.js";
import {
  isSteerReceipt, MAX_STEERS_PER_TURN, steerBlocker, steerTargetOf,
} from "../../src/platform/runtime/steer.js";
import type { CreateSessionFn } from "../../src/platform/runtime/agentRuntime/pi/session.js";

// ══════════════════════════════════════════════════════════════════
// ① 纯函数
// ══════════════════════════════════════════════════════════════════

describe("steerTargetOf · 回执要对上的目标文本", () => {
  it("新增里有一份与原话逐字相同 ⇒ 就是它", () => {
    expect(steerTargetOf(["旧的一句"], ["旧的一句", "等一下,需求改了"], "等一下,需求改了"))
      .toBe("等一下,需求改了");
  });

  it("原话被展开过(SDK 展开 `/技能名` 与提示词模板)⇒ 取最后一条新增", () => {
    expect(steerTargetOf([], ["[已展开] 改需求"], "改需求")).toBe("[已展开] 改需求");
    expect(steerTargetOf(["别的一句"], ["别的一句", "新来的", "[已展开] 改需求"], "改需求"))
      .toBe("[已展开] 改需求");
  });

  it("还没看到任何新增(回执可能先到)⇒ 先按原话认", () => {
    expect(steerTargetOf(["甲"], ["甲"], "甲的新话")).toBe("甲的新话");
    expect(steerTargetOf([], [], "x")).toBe("x");
  });

  it("同名条目按**数量**对账(同一句被移走又加回来,不是简单去重)", () => {
    // 上一份快照里「再想想」有一条,这一份里有两条 ⇒ 新增了一条「再想想」。
    expect(steerTargetOf(["再想想"], ["再想想", "再想想"], "别的")).toBe("再想想");
  });
});

describe("isSteerReceipt · 送达回执", () => {
  it("正文逐字相等才算;差一个字都不算", () => {
    expect(isSteerReceipt("改需求", "改需求")).toBe(true);
    expect(isSteerReceipt("改需求 ", "改需求")).toBe(false);
    expect(isSteerReceipt("改需求。", "改需求")).toBe(false);
  });
});

describe("steerBlocker · 能不能补(判据只有这一处)", () => {
  const userTurn = { trigger: { kind: "user" as const }, steered: () => 0 };
  const todoTurn = { trigger: { kind: "todo" as const }, steered: () => 0 };

  it("正样本:甲方触发的回合、同一条线、没补满、会话能补 ⇒ 可以补(返回 null)", () => {
    expect(steerBlocker({ entry: userTurn, line: undefined, runningLine: "main", hasSteer: true })).toBeNull();
    expect(steerBlocker({ entry: userTurn, line: "main", runningLine: "main", hasSteer: true })).toBeNull();
  });

  it("对方在跑**内部任务**(排空器叫醒的)⇒ 不补", () => {
    const b = steerBlocker({ entry: todoTurn, line: undefined, runningLine: "main", hasSteer: true });
    expect(b).toMatchObject({ ok: false, reason: "not-steerable" });
  });

  it("这句话发在**另一条线**上 ⇒ 不补(排到那条线上去)", () => {
    const b = steerBlocker({ entry: userTurn, line: "thread", runningLine: "main", hasSteer: true });
    expect(b).toMatchObject({ ok: false, reason: "not-steerable" });
  });

  it("这一轮已经补满 ⇒ 不补", () => {
    const full = { ...userTurn, steered: () => MAX_STEERS_PER_TURN };
    expect(steerBlocker({ entry: full, line: undefined, runningLine: "main", hasSteer: true }))
      .toMatchObject({ ok: false, reason: "cap" });
    // 差一句就是可以 —— 上限是 3,不是 2。
    expect(MAX_STEERS_PER_TURN).toBe(3);
    expect(steerBlocker({
      entry: { ...userTurn, steered: () => MAX_STEERS_PER_TURN - 1 },
      line: undefined, runningLine: "main", hasSteer: true,
    })).toBeNull();
  });

  it("那条线上没有在跑的回合 / 会话还不能补(建会话那几秒、或端口没有 steer)⇒ 不补", () => {
    expect(steerBlocker({ entry: null, line: undefined, runningLine: "main", hasSteer: true }))
      .toMatchObject({ ok: false, reason: "unavailable" });
    expect(steerBlocker({ entry: userTurn, line: undefined, runningLine: "main", hasSteer: false }))
      .toMatchObject({ ok: false, reason: "unavailable" });
  });
});

describe("normalizeSessionEvent · 补话回执的翻译(真的适配层)", () => {
  const pi = (ev: unknown): AgentSessionEvent => ev as AgentSessionEvent;

  it("用户消息的 message_start ⇒ user_message_start;内容块里的 text 按顺序拼接", () => {
    expect(normalizeSessionEvent(pi({
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "等一下," }, { type: "text", text: "改需求" }] },
    }))).toEqual({ type: "user_message_start", text: "等一下,改需求" });
    expect(normalizeSessionEvent(pi({
      type: "message_start", message: { role: "user", content: "纯字符串正文" },
    }))).toEqual({ type: "user_message_start", text: "纯字符串正文" });
  });

  it("助手的 message_start 仍然丢弃(平台自己另行广播)", () => {
    expect(normalizeSessionEvent(pi({
      type: "message_start", message: { role: "assistant", content: [] },
    }))).toBeNull();
  });

  it("queue_update ⇒ 两份队列快照", () => {
    expect(normalizeSessionEvent(pi({
      type: "queue_update", steering: ["甲", "乙"], followUp: ["丙"],
    }))).toEqual({ type: "queue_update", steering: ["甲", "乙"], followUp: ["丙"] });
  });
});

// ══════════════════════════════════════════════════════════════════
// ② 端到端:真宿主 + 真 WS + 真的适配层 + 假的 SDK 队列
// ══════════════════════════════════════════════════════════════════

/** 甲方第一句话的标记:任务正文**以它收尾** ⇒ 这一轮是甲方触发的回合(见 `isClientTurn`)。 */
const TURN_MARKER = "第一句,先忙你的";

/**
 * 这份任务正文是不是**甲方触发的回合** —— 判「这句话是现在说的」,不判「正文里出现过它」。
 *
 * ⚠️ 新会话会重放主对话的最近消息(`renderConversationHistory`),重放出来的是这样一行:
 * `- 甲方：第一句,先忙你的`。宿主启动时那一趟排空叫醒的项目经理如果恰好建在甲方开口之后,
 * 它的任务正文里**也有**这句话 —— 按「出现过」判,假会话会把项目经理那一轮当成甲方触发的
 * 回合挂起来(等一个永远不会来的放行),而它占着这个项目的排空闩 ⇒ 之后每一次敲门都只被
 * 记成「跑完再查一遍」⇒ 业务经理的「带回」回合永远不来(2026-11-28 实测:建会话多了一步
 * 真的读盘,这个原本只差一个微任务的先后就翻了)。
 * 甲方亲口说的那句永远是任务正文的**最后一段**(`runAgentTurn` 把它接在上下文与历史之后)。
 */
const isClientTurn = (text: string): boolean => text.trimEnd().endsWith(TURN_MARKER);

interface Harness {
  /** 每一轮收到的任务正文(按到达顺序)。 */
  prompts: string[];
  /** `steer()` 收到的原话。 */
  steered: string[];
  /** `clearQueue()` 被调了几次。 */
  cleared: number;
  /**
   * 回合走到「这批工具调用跑完」时怎么处理队列:
   *   `true`        —— 把队列里的话逐条送进模型(正常);
   *   `false`       —— 不消费,直接结束(补话和回合结束赛跑);
   *   `"unrelated"` —— 不消费,但先冒出一条**别的**用户消息(回执不许认错人);
   *   `"deliverThenHang"` —— 送进模型之后**再挂住**(送到了、可这一轮随后没走到头)。
   */
  drainSteer: boolean | "unrelated" | "deliverThenHang";
  /** SDK 把几句补话真的送进了模型(发了 `message_start` 用户消息)。 */
  delivered: number;
  /** 排空器叫醒**业务经理**的回合要不要挂起(模拟「对方在跑内部任务」)。 */
  gateTodoTurns: boolean;
  /** 模拟 SDK 对补话文本的展开(`_queueUserInput` 会展开 `/技能名` 与模板)。 */
  expand: ((text: string) => string) | null;
  /** 放行当前挂着的那个回合。 */
  release: () => void;
}

/**
 * 假 SDK 会话(发 **pi 方言**的事件 —— 宿主建出来的会话外面裹着真的适配器)。
 * 队列机制照 SDK 源码写,见文件头。
 */
function makeSession(h: Harness): AgentSession {
  const listeners = new Set<(ev: AgentSessionEvent) => void>();
  /** SDK 的补话队列(展开后的文本)。 */
  const queue: string[] = [];
  let releaseGate: (() => void) | null = null;
  let aborted = false;
  const emit = (ev: AgentSessionEvent): void => { for (const l of [...listeners]) l(ev); };
  const settleOk = (reply: string): void => {
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: reply } } as AgentSessionEvent);
    emit({ type: "agent_settled" } as AgentSessionEvent);
  };
  // ⚠️ abort 可能先于挂起到达 ⇒ 挂起之前与之后各看一次「是不是已经被中止」。
  const gate = (): Promise<void> => new Promise<void>((res) => {
    releaseGate = res;
    if (aborted) res();
  });
  h.release = () => {
    const r = releaseGate;
    releaseGate = null;
    r?.();
  };
  const session = {
    subscribe(fn: (ev: AgentSessionEvent) => void) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    async prompt(text: string) {
      aborted = false;
      h.prompts.push(text);
      if (text.includes("# 工作项 ")) {
        // 执行者的回合:一条工具调用开始之后就一动不动(单个工具卡死的形状,等看门狗)。
        emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "curl 文档" } } as AgentSessionEvent);
        await gate();
        return { messages: [] };
      }
      if (isClientTurn(text)) {
        // 甲方触发的回合:先跑一批工具调用(挂着,等测试放行)……
        emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } } as AgentSessionEvent);
        await gate();
        emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [] }, isError: false } as AgentSessionEvent);
        // ……工具调用跑完 ⇒ SDK 检查补话队列:逐条送进模型。
        if (h.drainSteer === "unrelated") {
          // 一条与补话无关的用户消息先到(正文对不上任何一句补话)。
          emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "系统提醒:时间不多了" }] } } as AgentSessionEvent);
          emit({ type: "queue_update", steering: [...queue], followUp: [] } as AgentSessionEvent);
        } else if (h.drainSteer) {
          while (queue.length > 0) {
            const t = queue.shift()!;
            emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: t }] } } as AgentSessionEvent);
            emit({ type: "queue_update", steering: [...queue], followUp: [] } as AgentSessionEvent);
            h.delivered += 1;
          }
        }
        if (h.drainSteer === "deliverThenHang") {
          // 话送到了,可这一轮随后卡住不动(等测试来中断)。被中止时 SDK 会发收尾信号 —— 照办。
          await gate();
          if (aborted) emit({ type: "agent_settled" } as AgentSessionEvent);
          return { messages: [] };
        }
        settleOk("收到,按你新说的来。");
        return { messages: [] };
      }
      if (h.gateTodoTurns && /你是:.*?\(`business_manager`\)/.test(text)) {
        // 排空器叫醒业务经理的回合(内部任务):挂起,等测试放行。
        await gate();
        settleOk("汇报完毕。");
        return { messages: [] };
      }
      settleOk("好。");
      return { messages: [] };
    },
    async abort() {
      aborted = true;
      releaseGate?.();
    },
    dispose() {},
    async steer(text: string) {
      const expanded = h.expand !== null ? h.expand(text) : text;
      queue.push(expanded);
      h.steered.push(text);
      // ⚠️ 同步广播,然后才返回(与 SDK 的 `_queueSteer` 同序)。
      emit({ type: "queue_update", steering: [...queue], followUp: [] } as AgentSessionEvent);
      return "queued" as const;
    },
    clearQueue() {
      h.cleared += 1;
      queue.length = 0;
      emit({ type: "queue_update", steering: [], followUp: [] } as AgentSessionEvent);
    },
  };
  return session as unknown as AgentSession;
}

let dataDir: string;
let root: string;
let host: PlatformHost | undefined;
let server: Server | undefined;
let wss: WebSocketServer | undefined;
let ws: WebSocket | undefined;
let baseUrl = "";
let h: Harness;
let events: Array<Record<string, unknown>>;
let pid: string;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(label: string, pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(10);
  }
  throw new Error(`等待超时:${label}`);
}

const of = (type: string): Array<Record<string, unknown>> =>
  events.filter((e) => e.type === type);

async function startHost(over: { turnToolMs?: number } = {}): Promise<void> {
  const ps = listProviders().filter((p) => p.models.length > 0 && providerEnvKey(p.id) !== undefined);
  const a = ps[0];
  if (a === undefined || a.models[0] === undefined) {
    throw new Error("内建 provider catalog 是空的 —— 夹具造不出「已配置 provider」的现场");
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(dataDir, "settings.json"),
    JSON.stringify({
      providers: [{
        id: "prov_a", label: "A", provider: a.id, modelId: a.models[0].id,
        apiKey: "key-a-not-used", thinkingLevel: "off",
      }],
      activeProviderId: "prov_a", cwd: root, personaName: "测试",
    }),
    { mode: 0o600 },
  );
  const createSession: CreateSessionFn = async () => ({ session: makeSession(h) });
  host = createPlatformHost({
    dataDir, host: "127.0.0.1", port: 0, version: "test", cwd: root,
    createSession,
    // 定时器关掉:测试**手动**排空。
    dispatchIntervalMs: 0,
    ...over,
  });
  const started = serve({ fetch: host.app.fetch, port: 0, hostname: "127.0.0.1" });
  server = started as unknown as Server;
  await new Promise<void>((r) => started.once("listening", () => r()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("拿不到监听端口");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  wss = attachHub(server, host.hub);
  ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws!.once("open", () => resolve());
    ws!.once("error", reject);
  });
  ws!.on("message", (raw: unknown) => {
    try {
      events.push(JSON.parse(String(raw)) as Record<string, unknown>);
    } catch {
      /* 非 JSON 的帧不是这条测试关心的事 */
    }
  });
}

const send = (cmd: unknown): void => ws!.send(JSON.stringify(cmd));
const db = () => host!.booted.deps.db;

/**
 * **业务经理的「带回」回合**(`answer_client_message`)里,排队清单含 `text` 的任务正文。
 *
 * ⚠️ 只看业务经理、且只看清单那一段:别的角色的新会话会按既有逻辑重放主对话的
 * 最近消息(`renderConversationHistory`),它们的任务正文里本来就有甲方说过的话 ——
 * 用「任何正文里出现这句话」当判据会把那次重放误报成「被回应了两遍」。
 */
const carriedBy = (text: string): string[] =>
  h.prompts.filter((p) => {
    if (!/你是:.*?\(`business_manager`\)/.test(p)) return false;
    const at = p.indexOf("甲方又说了话");
    return at >= 0 && p.slice(at).includes(text);
  });

/** 建项目 + 一个已确认开工、派给执行者的工作项(给「内部任务」那条用)。 */
function seedProject(workId: string | null): void {
  const d = db();
  ensureOrg(d, 1);
  insertProject(d, { id: "p1", name: "p1", client: "甲方", goal: "g", status: "active", createdAt: 1 });
  ensureProjectOrg(d, "p1", 1);
  if (workId !== null) {
    insertWork(d, {
      confirmedAt: 1, id: workId, projectId: "p1", parentWorkId: null, title: workId, goal: "g",
      status: "open", assigneeAgentId: "wk", createdAt: 1, updatedAt: 1,
    });
  }
}

/** 发第一句(占住业务经理的闩),等它的回合真正跑起来。 */
async function startUserTurn(): Promise<void> {
  send({ type: "send", projectId: pid, content: TURN_MARKER });
  // ⚠️ 判「现在说的」而不是「正文里出现过」:启动那一趟排空叫醒的项目经理可能重放了这句话。
  await waitFor("业务经理的甲方回合跑起来", () => h.prompts.some(isClientTurn));
}

/** 放行当前挂着的回合,等它收尾。 */
async function finishTurn(): Promise<void> {
  const before = of("agent_end").length;
  h.release();
  await waitFor("回合收尾(agent_end)", () => of("agent_end").length > before);
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  dataDir = mkdtempSync(join(tmpdir(), "ss-steer-"));
  root = join(dataDir, "ws");
  h = {
    prompts: [], steered: [], delivered: 0, cleared: 0, drainSteer: true, gateTodoTurns: false,
    expand: null, release: () => {},
  };
  events = [];
});

afterEach(async () => {
  ws?.close();
  ws = undefined;
  host?.close();
  host = undefined;
  wss?.close();
  wss = undefined;
  await new Promise<void>((r) => (server !== undefined ? server.close(() => r()) : r()));
  server = undefined;
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("补话 · 端到端", () => {
  it("正样本:同线补进当前这一轮 ⇒ 广播 message_steered(不是 message_queued),看到回执且回合成功 ⇒ 销账", async () => {
    await startHost();
    seedProject(null);
    pid = "p1";
    await startUserTurn();

    send({ type: "send", projectId: pid, content: "等一下,需求改了" });
    await waitFor("message_steered 到达", () => of("message_steered").length > 0);
    expect(of("message_queued"), "补进去了就不该再报排队").toHaveLength(0);
    expect(h.steered).toEqual(["等一下,需求改了"]);
    // 账先记上了(回执可能不来)……
    expect(pendingQueuedClientMessages(db(), pid)).toHaveLength(1);

    await finishTurn();

    // ……回合成功收尾 + 回执已到 ⇒ 账销掉(下一轮不会再答一遍)。
    await waitFor("补话销账", () => pendingQueuedClientMessages(db(), pid).length === 0);
    expect(h.cleared, "送达了的补话不需要清队列").toBe(0);
    const steered = of("message_steered")[0]!;
    expect(steered.sessionId).toBeTruthy();
  }, 20_000);

  it("回合先结束、那句话没送进去 ⇒ 清掉 SDK 里残留的半句;账留着,下一轮把它带上(且只带一次)", async () => {
    await startHost();
    seedProject(null);
    pid = "p1";
    h.drainSteer = false; // 回合不消费队列就结束(补话和回合结束赛跑)
    await startUserTurn();

    send({ type: "send", projectId: pid, content: "这句没赶上" });
    await waitFor("message_steered 到达", () => of("message_steered").length > 0);
    await finishTurn();

    expect(h.cleared, "SDK 队列里残留的那半句必须丢掉(否则下一轮说两遍)").toBe(1);
    // 回合一结束排空器就被叫醒(`handleUserMessage` 末尾那一敲)⇒ 下一轮立刻把它带上。
    // ⚠️ 不能断言「账此刻还在」—— 那和下一轮抢跑;断言的是** durable 的证据**:
    // 这句话恰好进了**一次**任务正文(没被 SDK 残留的那半句再说一遍),之后账销掉。
    await waitFor("下一轮的带回清单里有这句话", () => carriedBy("这句没赶上").length > 0);
    expect(carriedBy("这句没赶上"), "只带一次").toHaveLength(1);
    await waitFor("带上之后销账", () => pendingQueuedClientMessages(db(), pid).length === 0);
  }, 20_000);

  it("原话被 SDK 展开过(以 `/` 开头)⇒ 回执按**展开后的文本**逐字比,照样认得出", async () => {
    await startHost();
    seedProject(null);
    pid = "p1";
    h.expand = (t) => `[已展开] ${t}`;
    await startUserTurn();

    send({ type: "send", projectId: pid, content: "/技能 改需求" });
    await waitFor("message_steered 到达", () => of("message_steered").length > 0);
    await finishTurn();

    // 认不出回执的话,这里会留下账 + 清一次队列(与上一条同形)。
    await waitFor("展开过的补话也销账", () => pendingQueuedClientMessages(db(), pid).length === 0);
    expect(h.cleared).toBe(0);
  }, 20_000);

  it("话**已经送进模型**、可这一轮随后被中断 ⇒ 仍不算「回应过」:账留着、下一轮带上", async () => {
    // 与上一条的区别:回执**到了**。销账要的是「回执 + 这一轮成功收尾」两件都成立 ——
    // 只看回执的话,一次「听到了、还没来得及答就被打断」会被记成「答过了」,那句话就丢了。
    await startHost();
    seedProject(null);
    pid = "p1";
    h.drainSteer = "deliverThenHang";
    await startUserTurn();
    send({ type: "send", projectId: pid, content: "这句送到了但没等到回答" });
    await waitFor("message_steered 到达", () => of("message_steered").length > 0);

    // ① 放行第一道门 ⇒ 假 SDK 把话送进模型(回执到),然后重新挂住。
    h.release();
    await waitFor("话已送进模型(回执已到)", () => h.delivered === 1);
    // ② 此后才中断:回执到了、可这一轮没有成功收尾。
    send({ type: "interrupt", projectId: pid, channel: "client" });
    await waitFor("被中断的回合收尾(清了队列)", () => h.cleared >= 1);

    await waitFor("下一轮的带回清单里有这句话", () => carriedBy("这句送到了但没等到回答").length > 0);
    expect(carriedBy("这句送到了但没等到回答"), "只带一次").toHaveLength(1);
  }, 20_000);

  it("一条**不相关的**用户消息先到 ⇒ 不算送达回执(正文对不上):账留着、队列清掉、下一轮带上", async () => {
    await startHost();
    seedProject(null);
    pid = "p1";
    h.drainSteer = "unrelated";
    await startUserTurn();

    send({ type: "send", projectId: pid, content: "这句还在队列里" });
    await waitFor("message_steered 到达", () => of("message_steered").length > 0);
    await finishTurn();

    expect(h.cleared, "回执没认对 ⇒ 那半句必须丢掉").toBe(1);
    await waitFor("下一轮的带回清单里有这句话", () => carriedBy("这句还在队列里").length > 0);
    expect(carriedBy("这句还在队列里"), "只带一次").toHaveLength(1);
  }, 20_000);

  it("回合被甲方中断 ⇒ 补进去的话不算「回应过」:SDK 队列清掉,下一轮重新带上", async () => {
    await startHost();
    seedProject(null);
    pid = "p1";
    h.drainSteer = false;
    await startUserTurn();
    send({ type: "send", projectId: pid, content: "等等" });
    await waitFor("message_steered 到达", () => of("message_steered").length > 0);

    send({ type: "interrupt", projectId: pid, channel: "client" });
    // ⚠️ 等**这一轮**的收尾信号(清了残留的补话),不是「任何一个 agent_end」——
    // 项目经理的回合也发那个事件,等它会在业务经理还没收尾时就往下断言。
    await waitFor("被中断的回合清掉残留的补话", () => h.cleared >= 1);
    expect(h.cleared).toBeGreaterThanOrEqual(1);
    // 与上一条同理:不断言「账此刻还在」,断言它被**下一轮**带上了(且只一次)。
    await waitFor("下一轮的带回清单里有这句话", () => carriedBy("等等").length > 0);
    expect(carriedBy("等等"), "只带一次").toHaveLength(1);
  }, 20_000);

  it("退回排队:这句话发在**另一条线**上(在跑的回合在主对话)", async () => {
    await startHost();
    seedProject(null);
    pid = "p1";
    const sres = await fetch(`${baseUrl}/api/projects/${pid}/sessions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "追问线" }),
    });
    const threadId = ((await sres.json()) as { sessionId?: string }).sessionId;
    expect(threadId).toBeTruthy();

    await startUserTurn();
    send({ type: "send", projectId: pid, content: "另一条线上的追问", sessionId: threadId });
    await waitFor("message_queued 到达", () => of("message_queued").length > 0);
    expect(of("message_steered")).toHaveLength(0);
    expect(h.steered, "别的线上的话不许补进这一轮").toEqual([]);
    expect(pendingQueuedClientMessages(db(), pid)[0]!.sessionId).toBe(threadId);
    await finishTurn();
  }, 20_000);

  it("退回排队:对方在跑**内部任务**(排空器叫醒的业务经理回合)", async () => {
    // 单工具窗口压到 40ms:执行者那条卡死的工具调用到点 ⇒ 工作项记 failed ⇒ 写出
    // work_failed ⇒ 业务经理被叫醒去汇报。⚠️ 无进展窗口保持缺省(10 分钟)——
    // 挂起的汇报回合一个事件都不发,窗口太短它自己会先被看门狗停掉。
    await startHost({ turnToolMs: 40 });
    seedProject("w1");
    pid = "p1";
    h.gateTodoTurns = true;

    // ⚠️ 不 await 排空:业务经理的汇报回合会一直挂着(直到下面放行),await 会等到超时。
    void host!.dispatchTimer.runNow().catch(() => undefined);
    await waitFor("工作项记 failed", () => getWork(db(), "w1")?.status === "failed");
    await waitFor("业务经理的汇报回合挂起(它在跑内部任务)", () =>
      h.prompts.some((p) => !p.includes("# 工作项 ") && !isClientTurn(p) &&
        /你是:.*?\(`business_manager`\)/.test(p)),
    );

    // 此时甲方说话 ⇒ 不补(往内部任务里插话会混进一件跟它无关的活里)。
    send({ type: "send", projectId: pid, content: "你在忙,这句先排着" });
    await waitFor("message_queued 到达", () => of("message_queued").length > 0);
    expect(of("message_steered")).toHaveLength(0);
    expect(h.steered).toEqual([]);
    h.release();
  }, 20_000);

  it("退回排队:第 4 句(一轮最多补 3 句);前三句不再被下一轮重复问", async () => {
    await startHost();
    seedProject(null);
    pid = "p1";
    await startUserTurn();
    for (let i = 1; i <= 3; i += 1) {
      send({ type: "send", projectId: pid, content: `补话 ${i}` });
      await waitFor(`第 ${i} 句 message_steered`, () => of("message_steered").length >= i);
    }
    send({ type: "send", projectId: pid, content: "第 4 句" });
    await waitFor("第 4 句 message_queued", () => of("message_queued").length > 0);
    expect(h.steered).toEqual(["补话 1", "补话 2", "补话 3"]);
    await finishTurn();

    // 前三句在当前这一轮里就送进模型了 ⇒ 任何一轮的**任务正文**里都不该再有它们
    // (再出现一次 = 同一句话被回应两遍);第 4 句由下一轮带上。
    await waitFor("第 4 句被下一轮带上", () => carriedBy("第 4 句").length > 0);
    expect(carriedBy("第 4 句")).toHaveLength(1);
    // ⚠️ 判的是**业务经理的带回清单**:内部角色(项目经理)的新会话会按既有逻辑重放
    // 主对话的最近消息,它们的任务正文里本来就会有甲方说过的话 —— 那不是「重复回应」。
    for (const t of ["补话 1", "补话 2", "补话 3"]) {
      expect(carriedBy(t), `${t} 在当前这一轮就送进模型了,不许再被下一轮带回`).toHaveLength(0);
    }
    await waitFor("第 4 句销账", () => pendingQueuedClientMessages(db(), pid).length === 0);
  }, 20_000);
});
