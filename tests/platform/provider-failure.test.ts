/**
 * provider 故障(限流 / 断网 / 5xx / 额度)的**接线**回归(2026-10-22 批次)
 *
 * ── 这一批要钉住的是「接线」,不是「分类」 ────────────────────────────
 *
 * 分类器在 `tests/platform/provider-failure-classify.test.ts` 里(已提交、已绿),
 * 本文件**不重写**它。本文件钉的是三件事:
 *
 *   ① **看得见**:provider 把一次请求拒了(429 / 断网 / 5xx),平台这一侧
 *      **不许静默**。pi 把这类故障变成一条 `stopReason:"error"` 的 assistant
 *      消息(**不抛异常**)⇒ 「会话建不出来 / 抛错」那两条判据都不成立 ⇒
 *      此前平台上**什么都不报** —— 甲方看到的是「他答完了,然后就没有然后了」。
 *   ② **降级**:能换一家 provider 就换,别让一次外部抖动把一条活打死。
 *   ③ **不给「叫人用」的限流烧钱**:那个 3 次预算数的是「**组织试过了但没进展**」,
 *      provider 故障是「**外面在拒绝**」—— 三次抖动就能把一条**一次都没真跑过**
 *      的活推进 `exhausted`。
 *
 * ── 每条都有正样本 + 负样本,并做变异自检 ────────────────────────────
 *
 * ⚠️ 一个**什么都排除**的检查会让负样本绿、正样本红,方向相反的错法同理 ——
 * 所以每条负样本都必须是「**看起来像**那一类,但判据说不是」。
 * ⚠️ 变异自检不是「断言代码是这样写的」,而是**把判据改坏一遍**再断言它变红。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createPlatformHost, decideFailover, type PlatformHost } from "../../src/platform/host/serve.js";
import { attachHub } from "../../src/platform/transport/hub.js";
import { listProviders } from "../../src/platform/infra/providers.js";
import { ensureOrg, ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { getWork, insertWork } from "../../src/platform/storage/repo/works.js";
import { listSessions, listSessionMessages } from "../../src/platform/storage/repo/sessions.js";
import { listAttempts } from "../../src/platform/storage/repo/dispatch.js";
import { runTurn, type TurnResult } from "../../src/platform/runtime/turn.js";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertSession } from "../../src/platform/storage/repo/sessions.js";
import { addMember } from "../../src/platform/storage/repo/projects.js";
import {
  collectTodos, drainProject, type DrainTurnReport,
} from "../../src/platform/runtime/dispatcher.js";
import type { CreateSessionFn } from "../../src/platform/runtime/session.js";

/** 限流原文(逐字 —— 改了就测不到真机那一形态)。 */
const RATE_LIMIT_TEXT = "429 Too Many Requests — rate limit exceeded";
/** 额度原文:真机那条(分类成 quota ⇒ **不可重试** ⇒ 不降级)。 */
const QUOTA_TEXT =
  '{"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"}}';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询直到条件成立(真机链路是异步的,固定 sleep 会假绿也会假红)。 */
async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

// ══════════════════════════════════════════════════════════════════
// ① turn 层:provider 故障被记下来(看得见的第一半)
// ══════════════════════════════════════════════════════════════════

describe("① runTurn · provider 故障要留下现场", () => {
  let db: ReturnType<typeof openPlatformMemoryDb>;

  beforeEach(() => {
    db = openPlatformMemoryDb();
    insertAgent(db, { id: "bm", role: "business_manager", specialization: null, displayName: "业务经理", createdAt: 1 });
    insertProject(db, { id: "p1", name: "测试", client: "甲", goal: "g", status: "active", createdAt: 1 });
    addMember(db, "p1", "bm", 1);
    insertSession(db, { id: "s1", projectId: "p1", createdAt: 1, channel: "internal" });
  });
  afterEach(() => db.close());

  function fakeSession(
    script: (emit: (ev: AgentSessionEvent) => void) => void,
  ): { session: AgentSession; prompts: string[] } {
    const listeners: Array<(ev: AgentSessionEvent) => void> = [];
    const prompts: string[] = [];
    const session = {
      subscribe(fn: (ev: AgentSessionEvent) => void) {
        listeners.push(fn);
        return () => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      async prompt(text: string) {
        prompts.push(text);
        const emit = (ev: AgentSessionEvent) => { for (const l of [...listeners]) l(ev); };
        script(emit);
        emit({ type: "agent_settled" } as AgentSessionEvent);
        return { messages: [] };
      },
      async abort() {},
      dispose() {},
    };
    return { session: session as unknown as AgentSession, prompts };
  }

  /** provider 把这条 assistant 消息拒了(pi 的形状:`stopReason:"error"` + `errorMessage`)。 */
  const providerErrorMessage = (errorMessage: string) =>
    ({
      type: "message_end",
      message: {
        role: "assistant", model: "fake-model",
        stopReason: "error", errorMessage,
        usage: { input: 3, output: 0, cacheRead: 0 },
      },
    }) as unknown as AgentSessionEvent;

  const textDelta = (delta: string) =>
    ({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta } }) as unknown as AgentSessionEvent;

  async function turn(script: Parameters<typeof fakeSession>[0]): Promise<TurnResult> {
    const fake = fakeSession(script);
    return runTurn({
      session: fake.session, db, agentId: "bm", projectId: "p1",
      message: "做点事", timeoutMs: 2000,
    });
  }

  it("正样本:provider 拒了 ⇒ `providerError` 有值,kind 与状态码都对", async () => {
    const r = await turn((emit) => { emit(providerErrorMessage(RATE_LIMIT_TEXT)); });
    expect(r.providerError).toBeDefined();
    expect(r.providerError?.kind).toBe("rate_limit");
    expect(r.providerError?.status).toBe(429);
    // 可重试的故障才谈得上「换一家再试」。
    expect(r.providerError?.retryable).toBe(true);
    // 原文要留着 —— 它是「当时到底发生了什么」的唯一现场。
    expect(r.providerError?.message).toContain("rate limit");
  });

  it("负样本:正常答完 ⇒ `providerError` 是空的(不是「永远有值」)", async () => {
    const r = await turn((emit) => { emit(textDelta("这是答复。")); });
    expect(r.providerError).toBeUndefined();
  });

  it("额度(真机那条)判成 `quota` 且**不可重试** —— 换 provider 治不了", async () => {
    const r = await turn((emit) => { emit(providerErrorMessage(QUOTA_TEXT)); });
    expect(r.providerError?.kind).toBe("quota");
    expect(r.providerError?.retryable).toBe(false);
  });

  it("有 provider 故障时**不**判「没下文」(同一个故障报两次 = 报多了就没人看)", async () => {
    // 没有正文 + provider 拒了 —— 两条判据都成立。
    // ⚠️ 这里断言的是**抑制**:provider 故障走 `provider_error` 那条通道。
    const r = await turn((emit) => { emit(providerErrorMessage(RATE_LIMIT_TEXT)); });
    expect(r.providerError).toBeDefined();
    expect(r.unanswered, "provider 故障不许再报一次「没下文」").toBeNull();
  });

  it("负样本:没有 provider 故障时,「没下文」照旧要报(判据没被改坏)", async () => {
    const r = await turn(() => { /* 一句话都没说 */ });
    expect(r.providerError).toBeUndefined();
    expect(r.unanswered?.kind).toBe("no_text");
  });
});

// ══════════════════════════════════════════════════════════════════
// ② 降级判据(纯函数):六条纪律,每条都有正负样本
// ══════════════════════════════════════════════════════════════════

describe("② decideFailover · 降级判据的六条纪律", () => {
  const rateLimit = {
    kind: "rate_limit" as const, retryable: true,
    message: RATE_LIMIT_TEXT, status: 429,
  };
  const quota = {
    kind: "quota" as const, retryable: false,
    message: QUOTA_TEXT, status: 429,
  };
  const ok = {
    failure: rateLimit, toolCalls: 0, timedOut: false, aborted: false,
    hasBackup: true, otherTurnRunning: false,
  };

  it("正样本:一切就绪 ⇒ 降级", () => {
    expect(decideFailover(ok).degrade).toBe(true);
  });

  it("①额度/凭据类故障不可重试 ⇒ **不**降级(负样本:它长得像限流)", () => {
    // ⚠️ 真机那条 provider 自报 `rate_limit_error`,真实语义是账户级额度耗尽 ——
    // 判成可重试就会去换一家,而换一家也一样。
    expect(decideFailover({ ...ok, failure: quota }).degrade).toBe(false);
    expect(decideFailover({ ...ok, failure: quota }).reason).toContain("不可重试");
  });

  it("②本回合干过活 ⇒ **不**降级(有副作用,重跑不安全)", () => {
    expect(decideFailover({ ...ok, toolCalls: 1 }).degrade).toBe(false);
    expect(decideFailover({ ...ok, toolCalls: 1 }).reason).toContain("干过活");
  });

  it("③回合超时 ⇒ **不**降级(重跑只是再买一遍卡死行为)", () => {
    expect(decideFailover({ ...ok, timedOut: true }).degrade).toBe(false);
  });

  it("④回合被中断 ⇒ **不**降级(那是用户的决定,不是故障)", () => {
    expect(decideFailover({ ...ok, aborted: true }).degrade).toBe(false);
  });

  it("⑤没有备用 provider ⇒ **不**降级", () => {
    expect(decideFailover({ ...ok, hasBackup: false }).degrade).toBe(false);
  });

  it("⑥还有别的回合在跑 ⇒ **不**降级(换 provider 要改进程级 env)", () => {
    expect(decideFailover({ ...ok, otherTurnRunning: true }).degrade).toBe(false);
    expect(decideFailover({ ...ok, otherTurnRunning: true }).reason).toContain("别的回合");
  });
});

// ══════════════════════════════════════════════════════════════════
// ③④ 宿主:聊天路径与工作路径
// ══════════════════════════════════════════════════════════════════

interface Harness {
  /** 每一轮(按 prompt 解析出来的身份)。 */
  readonly turns: Array<{ projectId: string | null; role: string | null; workId: string | null }>;
  /** 这一轮 provider 原文 —— 夹具可换(限流 / 额度)。 */
  errorText: string;
  /** 这一轮要不要先跑一次工具(模拟「已经干过活」)。 */
  useTool: boolean;
  db: import("better-sqlite3").Database | null;
}

const PROJECT_ID_RE = /项目 ID:`([^`]+)`/;
const ROLE_RE = /你是:.*?\(`([a-z_]+)`\)/;
const WORK_ID_RE = /^# 工作项 (\S+)/m;

function makeHarness(): Harness {
  return { turns: [], errorText: RATE_LIMIT_TEXT, useTool: false, db: null };
}

function makeCreateSession(h: Harness): CreateSessionFn {
  return async () => {
    const listeners = new Set<(ev: AgentSessionEvent) => void>();
    const emit = (ev: AgentSessionEvent): void => {
      for (const l of [...listeners]) l(ev);
    };
    const session = {
      subscribe(fn: (ev: AgentSessionEvent) => void) {
        listeners.add(fn);
        return () => { listeners.delete(fn); };
      },
      async prompt(payload?: unknown) {
        const text = typeof payload === "string" ? payload : "";
        const projectId = text.match(PROJECT_ID_RE)?.[1] ?? null;
        const role = text.match(ROLE_RE)?.[1] ?? null;
        const workId = text.match(WORK_ID_RE)?.[1] ?? null;
        h.turns.push({ projectId, role, workId });
        if (h.useTool) {
          // ⚠️ 「已经干过活」的现场:一次工具调用(可能已有副作用 ⇒ 不许重跑)。
          emit({
            type: "tool_execution_start", toolCallId: "t1", toolName: "board_write", args: {},
          } as unknown as AgentSessionEvent);
          emit({
            type: "tool_execution_end", toolCallId: "t1", toolName: "board_write",
            result: { content: [{ text: "ok" }] }, isError: false,
          } as unknown as AgentSessionEvent);
        }
        // provider 把这一轮拒了。
        emit({
          type: "message_end",
          message: {
            role: "assistant", model: "fake-model",
            stopReason: "error", errorMessage: h.errorText,
            usage: { input: 3, output: 0, cacheRead: 0 },
          },
        } as unknown as AgentSessionEvent);
        emit({ type: "agent_settled" } as AgentSessionEvent);
        return { messages: [] };
      },
      async abort() {},
      dispose() {},
    } as unknown as AgentSession;
    return { session };
  };
}

let dataDir: string;
let root: string;
let host: PlatformHost | undefined;
let server: Server | undefined;
let wss: WebSocketServer | undefined;
let ws: WebSocket | undefined;
let h: Harness;
let events: Array<Record<string, unknown>>;

/** 写一份 settings:一个或两个 provider。 */
function writeSettings(opts: { backup: boolean }): void {
  const ps = listProviders();
  const a = ps.find((p) => p.models.length > 0);
  const b = ps.find((p) => p.id !== a?.id && p.models.length > 0);
  if (a === undefined || a.models[0] === undefined) {
    throw new Error("内建 provider catalog 是空的 —— 夹具造不出「已配置 provider」的现场");
  }
  const providers = [
    {
      id: "prov_a", label: "A", provider: a.id, modelId: a.models[0]!.id,
      apiKey: "key-a-not-used", thinkingLevel: "off",
    },
  ];
  if (opts.backup && b !== undefined && b.models[0] !== undefined) {
    providers.push({
      id: "prov_b", label: "B", provider: b.id, modelId: b.models[0]!.id,
      apiKey: "key-b-not-used", thinkingLevel: "off",
    });
  }
  writeFileSync(
    join(dataDir, "settings.json"),
    JSON.stringify({
      providers, activeProviderId: "prov_a", cwd: root, personaName: "测试",
    }),
    { mode: 0o600 },
  );
}

async function startHost(o: {
  backup: boolean; maxCascadeRounds?: number;
} = { backup: false }): Promise<void> {
  writeSettings({ backup: o.backup });
  host = createPlatformHost({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    version: "test",
    cwd: root,
    // 定时器挪到一小时之后:这里要的是**显式触发**,不是兜底 tick。
    dispatchIntervalMs: 3_600_000,
    maxCascadeRounds: o.maxCascadeRounds ?? 1,
    createSession: makeCreateSession(h),
  });
  server = createServer();
  wss = attachHub(server, host.hub);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("拿不到监听端口");
  ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  ws.on("message", (raw: unknown) => {
    try {
      events.push(JSON.parse(String(raw)) as Record<string, unknown>);
    } catch {
      /* 非 JSON 不入账 */
    }
  });
  await new Promise<void>((res, rej) => {
    ws!.once("open", () => res());
    ws!.once("error", rej);
  });
  h.db = host.booted.deps.db;
}

/** 建项目 + 一条派给执行角色的工作项。 */
function seedProject(workId: string | null): void {
  const db = h.db!;
  ensureOrg(db, 1);
  insertProject(db, {
    id: "p1", name: "p1", client: "甲方", goal: "g", status: "active", createdAt: 1,
  });
  ensureProjectOrg(db, "p1", 1);
  if (workId !== null) {
    insertWork(db, {
      id: workId, projectId: "p1", parentWorkId: null, title: workId, goal: "g",
      status: "open", assigneeAgentId: "wk", createdAt: 1, updatedAt: 1,
    });
  }
}

const errorEvents = (code: string): Array<Record<string, unknown>> =>
  events.filter((e) => (e.error as { code?: string } | undefined)?.code === code);

/** 项目内部会话里那条 `⚠️ 供应商` 平台通知。 */
function failoverNotices(): string[] {
  const db = h.db!;
  const out: string[] = [];
  for (const s of listSessions(db, "p1")) {
    for (const m of listSessionMessages(db, s.id)) {
      if (m.kind === "system" && m.content.startsWith("⚠️ 供应商")) out.push(m.content);
    }
  }
  return out;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  dataDir = mkdtempSync(join(tmpdir(), "ss-providerfail-"));
  root = join(dataDir, "ws");
  mkdirSync(root, { recursive: true });
  h = makeHarness();
  events = [];
});

afterEach(async () => {
  await sleep(10);
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

// ── ③ 聊天路径 ──────────────────────────────────────────────────

describe("③ 宿主 · 聊天路径:provider 故障要上屏", () => {
  it("正样本:广播 `error` / code `provider_error`,且消息说清「怎么办」", async () => {
    await startHost({ backup: true });
    seedProject(null);
    ws!.send(JSON.stringify({ type: "send", projectId: "p1", content: "在吗" }));
    await until(() => errorEvents("provider_error").length > 0);
    const evs = errorEvents("provider_error");
    expect(evs.length, "provider 故障必须上屏 —— 此前它什么都不报").toBeGreaterThan(0);
    const msg = String((evs[0]!.error as { message?: string }).message ?? "");
    // 分类的中文说法 + HTTP 状态码 + provider 原文 + 已重试次数 + 可执行的下一步。
    expect(msg).toContain("供应商限流");
    expect(msg).toContain("429");
    expect(msg).toContain("rate limit");
    expect(msg).toContain("重试");
  });

  it("负样本:provider 故障时**不**广播 `unanswered_turn`(限流不是「模型没说话」)", async () => {
    await startHost({ backup: true });
    seedProject(null);
    ws!.send(JSON.stringify({ type: "send", projectId: "p1", content: "在吗" }));
    await until(() => errorEvents("provider_error").length > 0);
    expect(errorEvents("unanswered_turn").length, "同一个故障报两次 = 报多了就没人看").toBe(0);
  });
});

// ── ④ 工作路径 ──────────────────────────────────────────────────

describe("④ 宿主 · 工作路径:降级 / 终态", () => {
  it("正样本:没有备用 provider ⇒ 工作项记 `failed`,并写出 `work_failed` 事件", async () => {
    await startHost({ backup: false });
    seedProject("w1");
    await host!.dispatchTimer.runNow();
    await until(() => getWork(h.db!, "w1")?.status === "failed");
    expect(getWork(h.db!, "w1")?.status).toBe("failed");
    // `updateWorkStatus` 是唯一写口,它自动写出 `work_failed` outbox 事件 ——
    // 没有它,业务经理永远不知道这条活死了。
    const rows = h.db!
      .prepare(`SELECT kind FROM dispatch_events WHERE project_id = 'p1' AND kind = 'work_failed'`)
      .all() as Array<{ kind: string }>;
    expect(rows.length, "`failed` 必须留一条工作记录,否则它就是静默的死").toBeGreaterThan(0);
  });

  it("正样本:有备用 provider + 本回合没干过活 ⇒ **降级**,工作项**不**记 failed", async () => {
    await startHost({ backup: true, maxCascadeRounds: 1 });
    seedProject("w1");
    await host!.dispatchTimer.runNow();
    await until(() => failoverNotices().length > 0);
    const notices = failoverNotices();
    expect(notices.length, "降级必须落一条平台通知(前端原样渲染)").toBeGreaterThan(0);
    expect(notices[0]).toContain("⚠️ 供应商");
    // 降级成功 ⇒ 这条活**原封不动**地等着(仍是 `in_progress`),排空器下一轮重派。
    expect(getWork(h.db!, "w1")?.status).not.toBe("failed");
    expect(getWork(h.db!, "w1")?.status).toBe("in_progress");
  });

  it("负样本:本回合**跑过工具** ⇒ **不**降级 ⇒ 工作项记 `failed`", async () => {
    await startHost({ backup: true, maxCascadeRounds: 1 });
    h.useTool = true;
    seedProject("w1");
    await host!.dispatchTimer.runNow();
    await until(() => getWork(h.db!, "w1")?.status === "failed");
    // 有工具调用就可能已有副作用(写文件 / 发消息 / 提交)⇒ 重跑不安全。
    expect(failoverNotices().length, "已经干过活的回合不许重跑").toBe(0);
    expect(getWork(h.db!, "w1")?.status).toBe("failed");
  });

  it("负样本:额度耗尽(不可重试)⇒ **不**降级 ⇒ 工作项记 `failed`", async () => {
    await startHost({ backup: true, maxCascadeRounds: 1 });
    h.errorText = QUOTA_TEXT;
    seedProject("w1");
    await host!.dispatchTimer.runNow();
    await until(() => getWork(h.db!, "w1")?.status === "failed");
    expect(failoverNotices().length, "额度是账号级的,换一家治不了").toBe(0);
    expect(getWork(h.db!, "w1")?.status).toBe("failed");
  });

  it("负样本:还有别的回合在跑 ⇒ **不**降级(换 provider 要改进程级 env)", async () => {
    await startHost({ backup: true, maxCascadeRounds: 1 });
    seedProject("w1");
    // 占用**另一个角色**的忙闩 ⇒ 换 provider 会打到它。
    // ⚠️ 占的必须是**排空器不会去等**的那个角色(质检)—— 占住项目经理的话,
    // 排空器自己会卡在忙闩上等它,那一轮就变成「测试超时」而不是「不降级」。
    host!.hub.setBusy("p1", "qc", true, { kind: "user" });
    await host!.dispatchTimer.runNow();
    await until(() => getWork(h.db!, "w1")?.status === "failed");
    expect(failoverNotices().length, "别的回合正跑时换 provider 会误伤它们").toBe(0);
    expect(getWork(h.db!, "w1")?.status).toBe("failed");
    host!.hub.setBusy("p1", "qc", false);
  });
});

// ══════════════════════════════════════════════════════════════════
// ⑤ dispatcher:provider 故障不烧「叫人用」的预算
// ══════════════════════════════════════════════════════════════════

describe("⑤ dispatcher · 降级成功 ⇒ 尝试预算归零", () => {
  let db: ReturnType<typeof openPlatformMemoryDb>;
  const T0 = 1_700_000_000_000;

  beforeEach(() => {
    db = openPlatformMemoryDb();
    insertProject(db, {
      id: "p1", name: "语音机器人调研", client: "甲方",
      goal: "给出三条技术路线的对比与选型建议", status: "active", createdAt: T0,
    });
    ensureProjectOrg(db, "p1", T0);
    insertWork(db, {
      id: "R", projectId: "p1", parentWorkId: null, title: "根", goal: "结论",
      status: "done", assigneeAgentId: "wk", createdAt: T0, updatedAt: T0,
    });
    db.prepare(`UPDATE works SET review_state = 'done' WHERE id = 'R'`).run();
  });
  afterEach(() => db.close());

  const okTurn: DrainTurnReport = { aborted: false, timedOut: false, text: "好了", toolCalls: [] };

  /** 「整合」这条待办的 `targetState` 不动 ⇒ 预算真的会���烧掉。 */
  const integrateTodo = (): boolean =>
    collectTodos({ db, projectId: "p1", now: T0 }).runnable.some((t) => t.kind === "integrate");

  it("正样本:降级成功 ⇒ 下一轮**又**派发了同一条待办(预算没被烧掉)", async () => {
    expect(integrateTodo(), "夹具前提:「整合」这条待办得在").toBe(true);
    const deps = {
      db, projectId: "p1", now: () => T0, log: () => {}, maxAttemptsPerTodo: 1, reportBatchSize: 1,
      maxRounds: 3,
      runAgentTurn: async () => ({ ...okTurn, providerFailed: true }),
      runWork: async () => { throw new Error("这一串里没有工作项要执行"); },
    };
    const first = await drainProject(deps);
    // ⚠️ **这就是「预算归零」的可观测面**:预算只有 1 次。provider 故障把它清零,
    // 于是这条待办每一轮都还能被叫醒(3 轮上限 ⇒ 叫醒 3 次)。
    expect(
      first.visited.filter((v) => v.kind === "integrate").length,
      "provider 故障不该烧掉那个「叫人用」的预算",
    ).toBe(3);
    // 账本上也看得见:预算被清零(不是 1、不是 3)。
    const ledger = [...listAttempts(db, "p1").values()].find((a) => a.todoKey.startsWith("integrate"));
    expect(ledger?.attempts, "预算要归零").toBe(0);
  });

  it("负样本:普通的失败**照旧**烧预算(判据没被改坏)", async () => {
    const deps = {
      db, projectId: "p1", now: () => T0, log: () => {}, maxAttemptsPerTodo: 1, reportBatchSize: 1,
      maxRounds: 3,
      runAgentTurn: async () => ({ ...okTurn, failed: true }),
      runWork: async () => { throw new Error("这一串里没有工作项要执行"); },
    };
    const first = await drainProject(deps);
    expect(first.visited.filter((v) => v.kind === "integrate").length).toBe(1);
    // 预算没被重置 ⇒ 第二轮已经用尽 ⇒ 不再派发。
    const ledger = [...listAttempts(db, "p1").values()].find((a) => a.todoKey.startsWith("integrate"));
    expect(ledger?.attempts, "普通的失败就该烧预算 —— 否则「叫醒三次就停」那条纪律没了").toBe(1);
  });

  it("仓库层:`resetAttempt` 把预算归零、`notified_at` 清空", async () => {
    const { bumpAttempt, resetAttempt } = await import("../../src/platform/storage/repo/dispatch.js");
    expect(bumpAttempt(db, { projectId: "p1", todoKey: "k", targetState: null, at: T0 })).toBe(1);
    expect(bumpAttempt(db, { projectId: "p1", todoKey: "k", targetState: null, at: T0 })).toBe(2);
    expect(listAttempts(db, "p1").get("k")?.attempts).toBe(2);
    resetAttempt(db, "p1", "k");
    expect(listAttempts(db, "p1").get("k")?.attempts).toBe(0);
    // ⚠️ `notified_at` 也得清:它非空 = 「平台真的停在那里并播报过」。
    expect(listAttempts(db, "p1").get("k")?.notifiedAt).toBeNull();
    // 归零之后下一次 bump 从 1 重新数。
    expect(bumpAttempt(db, { projectId: "p1", todoKey: "k", targetState: null, at: T0 })).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
// ⑥ 变异自检:把判据改坏,检查必须当场变红
// ══════════════════════════════════════════════════════════════════

describe("⑥ 变异自检 · 判据没有静默失效", () => {
  /**
   * **真的把源码改坏一遍**,再跑同一批断言。
   *
   * ⚠️ 只断言「源码里有这句」是不够的:一个写坏的模式会返回 0 命中,而那看起来
   * 像「判据没了」。所以这里**真的改坏真的源码**(写成一份同目录的副本)、
   * **真的重新 import 它**、**真的跑一遍行为断言** —— 判据改坏之后,那些断言
   * 必须当场变红。
   *
   * ⚠️ 副本必须放在**同一个目录**里:它有相对 import(`../infra/providers.js`),
   * 放到别处会解析不到。
   */
  const serveSource = (): string =>
    readFileSync(join(import.meta.dirname, "../../src/platform/host/serve.ts"), "utf8");

  const MUTANT_DIR = join(import.meta.dirname, "../../src/platform/host");
  let mutantSeq = 0;

  /** 把源码按 `mutations` 改坏,写成副本,重新 import,拿回 `decideFailover`。 */
  async function mutatedDecideFailover(
    mutations: Array<[RegExp, string]>,
  ): Promise<typeof import("../../src/platform/host/serve.js").decideFailover> {
    let src = serveSource();
    for (const [re, to] of mutations) {
      expect(src, `变异点没找到(源码已经变了):${re}`).toMatch(re);
      src = src.replace(re, to);
    }
    // ⚠️ **每次用不同的文件名**:模块加载器按路径缓存,同一个路径的第二次
    // import 拿到的可能是**上一次**那份(⇒ 变异 ② 拿到变异 ① 的代码,
    // 而那条断言「恰好」红着 —— 一个看起来很真的假信号)。
    const file = join(MUTANT_DIR, `serve.__mutant__${++mutantSeq}__.ts`);
    writeFileSync(file, src, "utf8");
    try {
      vi.resetModules();
      const mod = (await import(file)) as typeof import("../../src/platform/host/serve.js");
      return mod.decideFailover;
    } finally {
      rmSync(file, { force: true });
    }
  }

  const rateLimit = { kind: "rate_limit" as const, retryable: true, message: RATE_LIMIT_TEXT };
  const quota = { kind: "quota" as const, retryable: false, message: QUOTA_TEXT };
  const base = {
    toolCalls: 0, timedOut: false, aborted: false,
    hasBackup: true, otherTurnRunning: false,
  };

  it("变异 ①:去掉「本回合干过活就不降级」⇒ **降级发生了** ⇒ 真断言必须变红", async () => {
    // 真判据:干过活 ⇒ 不降级。
    expect(decideFailover({ failure: rateLimit, ...base, toolCalls: 1 }).degrade).toBe(false);
    // 改坏:判据去掉 ⇒ 干过活也降级 ⇒ 上面那条断言当场变红。
    const broken = await mutatedDecideFailover([
      [/if \(input\.toolCalls > 0\) \{/, "if (false) {"],
    ]);
    expect(broken({ failure: rateLimit, ...base, toolCalls: 1 }).degrade).toBe(true);
  });

  it("变异 ②:去掉「不可重试就不降级」⇒ **额度也降级了** ⇒ 真断言必须变红", async () => {
    // 真判据:额度 ⇒ 不降级(额度是账号级的,换 provider 治不了)。
    expect(decideFailover({ failure: quota, ...base }).degrade).toBe(false);
    const broken = await mutatedDecideFailover([
      [/if \(!input\.failure\.retryable\) \{/, "if (false) {"],
    ]);
    expect(broken({ failure: quota, ...base }).degrade).toBe(true);
  });

  it("变异 ③:去掉「还有别的回合在跑就不降级」⇒ **误伤别的回合** ⇒ 真断言必须变红", async () => {
    expect(decideFailover({ failure: rateLimit, ...base, otherTurnRunning: true }).degrade).toBe(false);
    const broken = await mutatedDecideFailover([
      [/if \(input\.otherTurnRunning\) \{/, "if (false) {"],
    ]);
    expect(broken({ failure: rateLimit, ...base, otherTurnRunning: true }).degrade).toBe(true);
  });
});
