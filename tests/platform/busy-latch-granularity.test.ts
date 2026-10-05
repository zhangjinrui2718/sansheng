/**
 * 忙闩的粒度:**`(项目)` → `(项目, agent)`**
 *
 * ── 这批测试钉的是什么 ──────────────────────────────────────────
 *
 * 受保护的资源是 **per `(上下文, agent)` 的常驻会话**(四个角色各一条:工具面 /
 * 提示词不同),而旧闩按**项目**记 ⇒ worker 在排空里跑的时候,甲方**发不出话**,
 * 尽管他要找的业务经理那条会话根本没被占。真机现场:一次级联最多 8 回合、
 * 18 分钟,而这 18 分钟里「业务经理」这个通道是关着的 —— 用户的原话是
 * 「业务经理是我和业务经理双向沟通的通道……我需要能随时跟业务经理说话」。
 *
 * 每一条判据都能被一次「改回按项目记」弄红:
 *
 *   ① worker 在跑时甲方**能发出去**(而不是 `code=busy`),且两条回合真的**重叠**
 *   ② 业务经理自己正在回你时再发一条 → **仍然被拒**(负样本:证明不是什么都不拦)
 *   ③ 同项目两个角色同时在跑时,一次中断**两个都停**(负样本:只停最后一个)
 *   ④ 排空并发上界不变 —— 那几条由 `d1-d4-parallel-projects.test.ts` 钉着
 *   ⑤ 同项目**同 agent** 并发两条 → 恰好一条被拒
 *   ⑥ R1 的雷 (a):`getOrCreateSession` 的 check-then-act —— 同一个
 *      `(上下文, agent)` 不许建出两条会话(忙闩在建会话**之前**占用)
 *   ⑦ R1 的雷 (b):排空的回合撞上甲方那条路时**排队等**,不是并排写同一条会话
 *
 * ── 夹具的两个要点(第一版写错过,记在这里)───────────────────────
 *
 *   1. **假会话必须能分辨角色。** 一个项目里**好几条**聊天回合(业务经理的、
 *      项目经理拆解的、质检的)在 `workId === null` 上长得一样 —— 只按
 *      「聊天 / 工作项」分类会把它们混成一锅。判据取**注入的项目上下文**里那句
 *      `你是:…(\`role\`)`(`runtime/projectContext.ts`),与 `PROJECT_ID_RE`
 *      同一个来源。
 *   2. **要观测的并发必须靠「卡住」制造。** 不卡的假回合整个 `prompt()` 是同步
 *      跑完的(`inflight` 根本来不及被看到 > 0),所以每条并发断言前面都先
 *      `hasWaiter(...)` 等到那个回合真的挂在那里。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type WebSocketServer } from "ws";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createPlatformHost, type PlatformHost } from "../../src/platform/host/serve.js";
import { attachHub } from "../../src/platform/transport/hub.js";
import { listProviders } from "../../src/platform/infra/providers.js";
import { ensureOrg, ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import {
  getWork, insertWork, isTerminalWorkStatus, updateWorkStatus,
} from "../../src/platform/storage/repo/works.js";
import { insertAsk } from "../../src/platform/storage/repo/asks.js";
import type { CreateSessionFn } from "../../src/platform/runtime/session.js";

/**
 * 这批用例里**故意卡住回合**是常态:套件的默认 5 秒上界会抢在断言之前触发,
 * 于是失败长相是「Test timed out」而不是那条断言的现场(诊断过一次)。
 * 给足余量,失败就把 `until()` 的那条现场报出来。
 */
const itT = (name: string, fn: () => Promise<void>): void => {
  it(name, fn, 30_000);
};

// ── 夹具 ────────────────────────────────────────────────────────

interface Turn {
  readonly projectId: string | null;
  /** 这个回合是**哪个角色**的(从注入的项目上下文里读;接待会话没有上下文 ⇒ null) */
  readonly role: string | null;
  readonly workId: string | null;
  readonly text: string;
  readonly startedAt: number;
  readonly endedAt: number;
}

interface Harness {
  readonly turns: Turn[];
  /** 宿主那个库(假 worker 干完活要经过**唯一写口**把工作项置终态) */
  db: import("better-sqlite3").Database | null;
  /** 夹具自己没做成的动作(不静默 —— 它会出现在每条断言的现场里) */
  readonly problems: string[];
  inflight: number;
  maxInflight: number;
  /**
   * **每个 `(上下文, 角色)` 里同时在飞的回合数** —— 直接对应「一条常驻会话」。
   * 正确实现下它的最大值**永远恰好 1**;任何 >1 都是「两条流打进同一条会话」。
   */
  readonly perSession: Map<string, number>;
  maxPerSession: number;
  readonly aborts: string[];
  /** 只卡某个项目的**聊天**回合(甲方找业务经理那条路) */
  readonly blockedRole: Set<string>;
  /** 只卡某个项目的某一条工作项回合(`项目 → 工作项`) */
  readonly blockedWork: Map<string, string>;
  /** 接待会话的回合也卡住(它没有 projectId 可用) */
  blockIntake: boolean;
  /** 卡住的回合:键 → 等待者 FIFO */
  readonly waiters: Map<string, Array<() => void>>;
  /** 每个回合都发一条带 usage 的 `message_end`(活 2 的接线证据) */
  emitUsage: boolean;
  /**
   * `createAgentSession` 的耗时(毫秒)。
   *
   * 它是**雷 (a) 的显微镜**:`getOrCreateSession` 是 check-then-act
   * (`sessions.get` → `await createPlatformSession` → `sessions.set`),窗口就是这个
   * await。把它撑开到几十毫秒,「两条路各自建出一条会话」才**可被观测** ——
   * 否则窗口小到测试永远撞不上,那条断言会是一条没有牙的绿灯。
   */
  sessionCreateMs: number;
  /**
   * `createAgentSession` **被调用了几次**。
   *
   * ⚠️ 这是「有没有建重」的**唯一**可见面 —— `PlatformHost.sessionCount()` 是会话池
   * `Map.size`,而同一个键建出两条时后一次 `sessions.set` 会**覆盖**前一条,
   * 于是 size 仍然是 1(实测:把 `withTurnLatch` 关掉、故意制造 check-then-act,
   * size 依然是 2 —— 那是一条**看不见泄漏**的断言)。
   */
  sessionCreations: number;
}

/** 常驻会话的键 ——「一个角色一条」的那把键。 */
const sessionKeyOf = (projectId: string | null, role: string | null): string =>
  `${projectId ?? "<intake>"}|${role ?? "?"}`;
/** 等待/释放的键:工作项回合按工作项分,聊天回合按**角色**分。 */
const turnKeyOf = (projectId: string | null, role: string | null, workId: string | null): string =>
  workId !== null ? `${projectId ?? "<intake>"}|work:${workId}` : sessionKeyOf(projectId, role);
const turnLabelOf = (projectId: string | null, role: string | null, workId: string | null): string =>
  workId !== null ? `${sessionKeyOf(projectId, role)}#${workId}` : sessionKeyOf(projectId, role);

function makeHarness(): Harness {
  return {
    turns: [],
    db: null,
    problems: [],
    inflight: 0,
    maxInflight: 0,
    perSession: new Map(),
    maxPerSession: 0,
    aborts: [],
    blockedRole: new Set(),
    blockedWork: new Map(),
    blockIntake: false,
    waiters: new Map(),
    emitUsage: false,
    sessionCreateMs: 0,
    sessionCreations: 0,
  };
}

function hasWaiter(h: Harness, projectId: string | null, role: string | null, workId: string | null): boolean {
  return (h.waiters.get(turnKeyOf(projectId, role, workId))?.length ?? 0) > 0;
}

/** 放掉一个卡住的回合(FIFO)。 */
function releaseTurn(h: Harness, projectId: string | null, role: string | null, workId: string | null): void {
  const key = turnKeyOf(projectId, role, workId);
  const q = h.waiters.get(key);
  const r = q?.shift();
  if (q !== undefined && q.length === 0) h.waiters.delete(key);
  r?.();
}

/** 放掉全部(测试收尾用 —— 否则一个卡住的回合会把进程留在那儿)。 */
function releaseAll(h: Harness): void {
  for (const q of h.waiters.values()) for (const r of q) r();
  h.waiters.clear();
}

/** 注入的项目行(`runtime/projectContext.ts`)。 */
const PROJECT_ID_RE = /项目 ID:`([^`]+)`/;
/** 注入的「你是:<名字>(`role`)」行 —— 假会话靠它分辨角色。 */
const ROLE_RE = /你是:.*?\(`([a-z_]+)`\)/;
/** 工作项回合的任务正文(`runtime/execution.ts`)。 */
const WORK_ID_RE = /^# 工作项 (\S+)/m;

function makeCreateSession(h: Harness): CreateSessionFn {
  return async () => {
    // 这一行的读者只有一个:**测试**。生产里没有这个计数器,所以它是夹具的眼。
    h.sessionCreations++;
    if (h.sessionCreateMs > 0) await sleep(h.sessionCreateMs);
    const listeners = new Set<(ev: AgentSessionEvent) => void>();
    const emit = (ev: AgentSessionEvent): void => {
      for (const l of [...listeners]) l(ev);
    };
    /** 这一条会话**当前那一个**回合的唤醒函数(一条会话同时至多一个回合)。 */
    let releaseSelf: (() => void) | undefined;
    let currentLabel = "<unknown>";

    const session = {
      subscribe(fn: (ev: AgentSessionEvent) => void) {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      async prompt(payload?: unknown) {
        const text = typeof payload === "string" ? payload : "";
        const projectId = text.match(PROJECT_ID_RE)?.[1] ?? null;
        const role = text.match(ROLE_RE)?.[1] ?? null;
        const workId = text.match(WORK_ID_RE)?.[1] ?? null;
        const isChat = workId === null;
        const sKey = sessionKeyOf(projectId, role);
        currentLabel = turnLabelOf(projectId, role, workId);
        const startedAt = Date.now();
        h.inflight++;
        if (h.inflight > h.maxInflight) h.maxInflight = h.inflight;
        const n = (h.perSession.get(sKey) ?? 0) + 1;
        h.perSession.set(sKey, n);
        if (n > h.maxPerSession) h.maxPerSession = n;
        try {
          const shouldBlock =
            (projectId === null && h.blockIntake) ||
            (projectId !== null &&
              (h.blockedRole.has(sKey) ||
                (workId !== null && h.blockedWork.get(projectId) === workId)));
          if (shouldBlock) {
            // **一次性**:这一条卡住之后,同一个键的下一个回合照常跑。
            // 测试要观测的是「两条回合同时在飞」,不是「这个回合永远卡着」——
            // 卡着不放会让排空的下一个回合永远挂在那里(第一版就是这样超时的)。
            h.blockIntake = false;
            h.blockedRole.delete(sKey);
            if (projectId !== null) h.blockedWork.delete(projectId);
            const key = turnKeyOf(projectId, role, workId);
            await new Promise<void>((res) => {
              const q = h.waiters.get(key) ?? [];
              q.push(res);
              h.waiters.set(key, q);
              releaseSelf = res;
            });
            releaseSelf = undefined;
          }
          if (h.emitUsage) {
            emit({
              type: "message_end",
              message: {
                role: "assistant", model: "fake-model",
                usage: { input: 7, output: 3, cacheRead: 5 },
              },
            } as unknown as AgentSessionEvent);
          }
        } finally {
          h.inflight--;
          h.perSession.set(sKey, (h.perSession.get(sKey) ?? 1) - 1);
        }
        // 假 worker「干完了活」:经**唯一写口**把工作项置终态。不这么做的话
        // `execute_work` 每回合都会重新出现,一趟排空把同一条活叫醒 3 次(实测)。
        //
        // ⚠️ 判据是「**还没到终态**」而不是「status === open」:`runWorkItem` 在
        // 调 `prompt()` **之前**已经把工作项置成 `in_progress`(execution.ts:277),
        // 所以按 `open` 判会让这段静默不执行(第一版就是这样,3 个回合原地打转)。
        if (workId !== null && h.db !== null) {
          const row = getWork(h.db, workId);
          if (row !== null && !isTerminalWorkStatus(row.status)) {
            const r = updateWorkStatus(h.db, workId, "done", Date.now());
            if (!r.ok) {
              // 不静默:夹具自己没做成的动作会让「工作项只执行一次」那条断言
              // 变成一句无法解释的红(diag 会把它贴出来)
              h.problems.push(`夹具没能把 ${workId} 置终态(${r.reason ?? "?"})`);
            }
          } else if (row === null) {
            h.problems.push(`getWork(${workId}) 是 null`);
          }
        }
        h.turns.push({ projectId, role, workId, text, startedAt, endedAt: Date.now() });
        emit({ type: "agent_settled" } as AgentSessionEvent);
      },
      async abort() {
        // 每条会话只放掉**自己**那个回合 —— 这正是「两个角色分别被中断」的现场。
        h.aborts.push(currentLabel);
        const r = releaseSelf;
        releaseSelf = undefined;
        r?.();
        emit({ type: "agent_settled" } as AgentSessionEvent);
      },
      dispose() {
        /* 无需清理 */
      },
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询直到条件成立(真机链路是异步的,固定 sleep 会假绿也会假红)。 */
async function until(cond: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

const busyErrors = (): Array<Record<string, unknown>> =>
  events.filter((e) => (e.error as { code?: string } | undefined)?.code === "busy");

/** 失败时贴出来的现场(不然只有一句 `expected false to be true`)。 */
const diag = (): string =>
  `turns=${JSON.stringify(h.turns.map((t) => [t.projectId, t.role, t.workId]))} ` +
  `events=${JSON.stringify(events.map((e) => (e.error !== undefined ? e.error : e.type)))} ` +
  `sessions=${host?.sessionCount() ?? -1} creations=${h.sessionCreations} maxPerSession=${h.maxPerSession}` +
  (h.problems.length > 0 ? ` ⚠️夹具问题=${JSON.stringify(h.problems)}` : "");

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  dataDir = mkdtempSync(join(tmpdir(), "ss-busylatch-"));
  root = join(dataDir, "ws");
  mkdirSync(root, { recursive: true });
  const p = listProviders()[0];
  const model = p?.models[0];
  if (p === undefined || model === undefined) {
    throw new Error("内建 provider catalog 是空的 —— 夹具造不出「已配置 provider」的现场");
  }
  writeFileSync(
    join(dataDir, "settings.json"),
    JSON.stringify({
      providers: [
        {
          id: "prov_test", label: "test", provider: p.id, modelId: model.id,
          apiKey: "test-key-not-used", thinkingLevel: "off",
        },
      ],
      activeProviderId: "prov_test",
      cwd: root,
      personaName: "测试",
    }),
    { mode: 0o600 },
  );
  h = makeHarness();
  events = [];
});

afterEach(async () => {
  releaseAll(h); // 卡住的回合必须先放掉,否则 close() 会等它们
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

interface Started {
  readonly send: (cmd: unknown) => void;
  readonly db: () => import("better-sqlite3").Database;
  readonly runTimerNow: () => Promise<void>;
}

async function startHost(o: { maxCascadeRounds?: number } = {}): Promise<Started> {
  host = createPlatformHost({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    version: "test",
    cwd: root,
    // 定时器挪到一小时之后:这里要的是**门铃与显式触发**,不是兜底 tick
    dispatchIntervalMs: 3_600_000,
    maxCascadeRounds: o.maxCascadeRounds ?? 3,
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

  const captured = host;
  h.db = captured.booted.deps.db;
  return {
    send: (cmd) => ws!.send(JSON.stringify(cmd)),
    db: () => captured.booted.deps.db,
    runTimerNow: () => captured.dispatchTimer.runNow(),
  };
}

function seedProject(
  db: import("better-sqlite3").Database,
  projectId: string,
  workId: string | null,
): void {
  ensureOrg(db, 1);
  insertProject(db, {
    id: projectId, name: projectId, client: "甲方", goal: "g", status: "active", createdAt: 1,
  });
  ensureProjectOrg(db, projectId, 1);
  if (workId !== null) {
    insertWork(db, {
      id: workId, projectId, parentWorkId: null, title: workId, goal: "g", status: "open",
      assigneeAgentId: "wk", createdAt: 1, updatedAt: 1,
    });
  }
}

const BM = "business_manager";
/**
 * 被卡住的「执行那条路」= `execute_work`(worker)。
 *
 * ⚠️ 两条踩过的坑,记在这里免得下次再踩:
 *   1. **只有 `execute_work` 走 `runWork`**(提示词以 `# 工作项 <id>` 开头);
 *      其余待办(含 `review_work`)走 `runAgentTurn` —— 提示词里**没有**那一行,
 *      `workId` 解析出来是 null。第一版拿 `review_work` 当「工作回合」,于是
 *      「卡住」的判据根本没命中,回合一路跑完。
 *   2. `execute_work` 的待办在工作项没有终态时会**每次都重新出现**(一趟排空把
 *      同一条活叫醒 3 次)。所以假会话在回合结束时**把工作项置 `done`**
 *      (`markWorkDone` 那段)—— 真 worker 干完活也是这么做的。
 */
const WK = "worker";

const workTurns = (projectId: string): Turn[] =>
  h.turns.filter((t) => t.projectId === projectId && t.workId !== null);
/** **业务经理**在一个项目里的回合(甲方那句消息的落点)。 */
const bmTurns = (projectId: string): Turn[] =>
  h.turns.filter((t) => t.projectId === projectId && t.role === BM);

// ── A · 忙闩本身的形状(不建回合)────────────────────────────────

describe("A · 忙闩按 `(上下文, agent)` 记", () => {
  itT("同一个项目里 `wk` 忙 ≠ `bm` 忙;不给 agent 时是「任一角色」的保守判据", async () => {
    await startHost();
    const hub = host!.hub;

    hub.setBusy("pA", "wk", true, { kind: "user" });
    expect(hub.isBusy("pA", "wk"), "占了的那个角色要读到忙").toBe(true);
    expect(hub.isBusy("pA", "bm"), "**另一个角色不许被连坐** —— 这条就是整个任务").toBe(false);
    expect(hub.isBusy("pA"), "不给 agent 是「这个上下文里还有活」的保守判据").toBe(true);
    expect(hub.isBusy("pB", "wk"), "别的项目不受影响").toBe(false);
    // 登记里带着「这一轮跑了多久 / 为什么存在」—— 成员页的「正在做什么」读它。
    const busy = hub.runningTurns();
    expect(busy.length, "占着的回合要被 `runningTurns()` 数到").toBe(1);
    expect(busy[0]?.agentId).toBe("wk");
    expect(busy[0]?.trigger).toEqual({ kind: "user" });
    hub.setBusy("pA", "wk", false);
    expect(hub.isBusy("pA")).toBe(false);
    expect(hub.runningTurns().length, "释放之后不许留下幽灵回合").toBe(0);
  });

  itT("`acquireTurn` 在闩被占时**等**(闩不放空),释放时**交班**给队首", async () => {
    await startHost();
    const hub = host!.hub;
    const todo = { kind: "todo", todoKind: "execute_work" } as const;
    hub.setBusy("pA", "bm", true, { kind: "user" });

    let acquired = false;
    const pending = hub.acquireTurn("pA", "bm", todo).then((release) => {
      acquired = true;
      return release;
    });
    await sleep(30);
    expect(acquired, "闩还占着 —— 排队者不许抢跑").toBe(false);
    expect(hub.isBusy("pA", "bm"), "排队期间闩**不许放空**(放空 = 甲方可以插队把排空饿死)").toBe(true);

    hub.setBusy("pA", "bm", false);
    const release = await pending;
    expect(acquired).toBe(true);
    expect(hub.isBusy("pA", "bm"), "交班之后队首仍然持有它").toBe(true);
    // 交班时登记要换成**新回合自己那一份**:沿用上一个回合的 `startedAt` 会把
    // 「已跑多久」算成两段之和,而 `trigger` 会显示成上一轮的原因(两句都是假话)。
    const handed = hub.runningTurns();
    expect(handed.length).toBe(1);
    expect(handed[0]?.trigger).toEqual(todo);
    release();
    expect(hub.isBusy("pA", "bm")).toBe(false);
  });
});

// ── ① worker 在跑时甲方发得出话 ────────────────────────────────

describe("① 排空在跑 worker 时,甲方对业务经理说的话**发得出去**", () => {
  itT("不被 `code=busy` 拒,且业务经理那条回合与 worker 那条**重叠**", async () => {
    const s = await startHost();
    const db = s.db();
    seedProject(db, "pA", "wkA");
    h.blockedWork.set("pA", "wkA");
    h.blockedRole.add(sessionKeyOf("pA", BM)); // 业务经理那条也要能被观测(它得真的跑起来)

    const pass = s.runTimerNow();
    expect(
      await until(() => hasWaiter(h, "pA", WK, "wkA")),
      `worker 的回合必须先真的在跑 —— ${diag()}`,
    ).toBe(true);
    expect(host!.hub.isBusy("pA", "wk"), "worker 占着的是**它自己**那把闩").toBe(true);
    expect(host!.hub.isBusy("pA", "bm"), "业务经理那把闩此时是空的").toBe(false);

    s.send({ type: "send", projectId: "pA", content: "在吗" });

    expect(
      await until(() => hasWaiter(h, "pA", BM, null)),
      `甲方那条消息必须**跑到业务经理那里**(旧实现这里会吃到 code=busy,根本不建回合)—— ${diag()}`,
    ).toBe(true);
    expect(busyErrors(), `**一条 busy 都不该有** —— ${diag()}`).toEqual([]);
    expect(h.maxInflight, "worker ⊥ 业务经理两条回合必须真的同时在飞").toBeGreaterThanOrEqual(2);
    expect(h.maxPerSession, "同一个 `(上下文, 角色)` 里从来没有两条回合同时在飞").toBe(1);

    releaseTurn(h, "pA", WK, "wkA");
    releaseTurn(h, "pA", BM, null);
    await pass;
    const mine = (): Turn[] => bmTurns("pA").filter((t) => t.text.includes("在吗"));
    expect(await until(() => mine().length === 1), diag()).toBe(true);
    expect(workTurns("pA").length, `工作项只执行了一次(终态之后不再出现)—— ${diag()}`).toBe(1);
    const w = workTurns("pA")[0]!;
    const c = mine()[0]!;
    expect(c.startedAt < w.endedAt && w.startedAt < c.endedAt, "两条区间必须相交").toBe(true);
  });

  itT("① 负样本:排空**没**在跑时,甲方那条消息同样发得出去(证明上一条的红不是别的东西造成的)", async () => {
    const s = await startHost();
    const db = s.db();
    seedProject(db, "pA", null);
    s.send({ type: "send", projectId: "pA", content: "在吗" });
    expect(await until(() => bmTurns("pA").length === 1), diag()).toBe(true);
    expect(busyErrors(), diag()).toEqual([]);
  });
});

// ── ② 业务经理正在回你时仍然被拒(负样本)──────────────────────

describe("② 业务经理自己正在回你时,再发一条**仍然被拒** `code=busy`", () => {
  itT("恰好一条被拒,且被拒的不是第一条(它照常跑完)", async () => {
    const s = await startHost();
    const db = s.db();
    seedProject(db, "pA", null);
    h.blockedRole.add(sessionKeyOf("pA", BM));

    s.send({ type: "send", projectId: "pA", content: "第一条" });
    expect(
      await until(() => hasWaiter(h, "pA", BM, null)),
      `第一条必须真的进了业务经理那个回合 —— ${diag()}`,
    ).toBe(true);
    s.send({ type: "send", projectId: "pA", content: "第二条" });

    expect(
      await until(() => busyErrors().length === 1),
      `业务经理那条会话正被占用 ⇒ 第二条必须拿 \`code=busy\` —— ${diag()}`,
    ).toBe(true);
    expect(busyErrors()[0]!.projectId).toBe("pA");

    releaseTurn(h, "pA", BM, null);
    expect(await until(() => bmTurns("pA").length === 1), diag()).toBe(true);
    await sleep(150);
    expect(bmTurns("pA").length, "第二条没有跑成第二个回合").toBe(1);
    expect(busyErrors().length, "拒绝必须只有一次").toBe(1);
    expect(h.maxPerSession).toBe(1);
  });
});

// ── ③ 中断:同项目两角色并发,两个都停 ─────────────────────────

describe("③ 同一项目里两个角色同时在跑时,一次中断**两个都停**", () => {
  itT("worker ⊥ 业务经理两条回合都收到 abort;别的项目一点没被碰", async () => {
    const s = await startHost();
    const db = s.db();
    seedProject(db, "pA", "wkA");
    seedProject(db, "pB", "wkB");
    h.blockedWork.set("pA", "wkA");
    h.blockedWork.set("pB", "wkB");
    h.blockedRole.add(sessionKeyOf("pA", BM));

    const pass = s.runTimerNow();
    expect(
      await until(() => hasWaiter(h, "pA", WK, "wkA") && hasWaiter(h, "pB", WK, "wkB")),
      `两个项目的 worker 回合都要先在跑 —— ${diag()}`,
    ).toBe(true);

    // 甲方对 pA 说一句话 ⇒ 同一个项目里第二个角色(业务经理)也跑起来
    s.send({ type: "send", projectId: "pA", content: "顺便问一句" });
    expect(await until(() => hasWaiter(h, "pA", BM, null)), diag()).toBe(true);
    expect(h.maxInflight).toBeGreaterThanOrEqual(3);
    expect(h.maxPerSession, "两条回合是**两个不同角色** ⇒ 各自一条会话,互不重叠").toBe(1);

    s.send({ type: "interrupt", projectId: "pA" });

    // 旧的按项目记的 `inflight` 会让后登记的覆盖前一个 ⇒ 这里只会有 **1** 条 abort
    expect(
      await until(() => h.aborts.length === 2),
      `同项目两个回合必须**各自**收到中断(旧键下只有一个到得了)—— ${diag()}`,
    ).toBe(true);
    expect(h.aborts.slice().sort()).toEqual([
      sessionKeyOf("pA", BM), `${sessionKeyOf("pA", WK)}#wkA`,
    ]);
    expect(h.aborts.some((a) => a.includes("pB")), "pB 的中断不该被 pA 的中断带出来").toBe(false);

    releaseTurn(h, "pB", WK, "wkB");
    await pass;
    expect(workTurns("pB").length, `pB 照常跑完 —— ${diag()}`).toBe(1);
    expect(h.aborts.some((a) => a.includes("pB")), "pB 从来没被 abort 过").toBe(false);
  });
});

// ── ⑤ 同项目同 agent 并发两条 → 恰好一条被拒 ───────────────────

describe("⑤ 同一个 `(项目, agent)` 并发两条 → 恰好一条被拒", () => {
  itT("接待会话(projectId null)上也是同一条规矩", async () => {
    const s = await startHost();
    const db = s.db();
    seedProject(db, "pA", null);
    h.blockIntake = true;

    // 接待会话走的是 `(null, 业务经理)` 那把闩 —— 与项目内是同一个键空间里的两条
    s.send({ type: "send", projectId: null, content: "我想做个东西" });
    expect(
      await until(() => hasWaiter(h, null, null, null)),
      `接待会话那条回合必须先在跑 —— ${diag()}`,
    ).toBe(true);
    s.send({ type: "send", projectId: null, content: "再补一句" });

    expect(await until(() => busyErrors().length === 1), diag()).toBe(true);
    expect(busyErrors()[0]!.projectId, "接待会话的那条错误也带 projectId: null").toBeNull();

    releaseTurn(h, null, null, null);
    expect(
      await until(() => h.turns.filter((t) => t.projectId === null).length === 1),
      diag(),
    ).toBe(true);
    await sleep(150);
    expect(h.turns.filter((t) => t.projectId === null).length).toBe(1);
  });
});

// ── ⑥/⑦ R1 的两条雷 ────────────────────────────────────────────

describe("⑥ R1 的雷 (a):同一个 `(上下文, agent)` 不许建出两条会话", () => {
  itT("worker ⊥ 业务经理并发之后,常驻会话数 = 两个角色各一条(不是三条、也不漏)", async () => {
    const s = await startHost();
    const db = s.db();
    seedProject(db, "pA", "wkA");
    h.blockedWork.set("pA", "wkA");
    h.blockedRole.add(sessionKeyOf("pA", BM));

    const pass = s.runTimerNow();
    expect(await until(() => hasWaiter(h, "pA", WK, "wkA")), diag()).toBe(true);
    expect(h.sessionCreations, "worker 那条会话已建(计的是**真的建了几次**)").toBe(1);

    s.send({ type: "send", projectId: "pA", content: "在吗" });
    expect(await until(() => hasWaiter(h, "pA", BM, null)), diag()).toBe(true);
    // **判据面是 `getOrCreateSession` 的 check-then-act**:忙闩在**建会话之前**
    // 占用 ⇒ 同一个键不可能有两个创建同时在飞 ⇒ 每个角色恰好一条。
    expect(h.sessionCreations, "两个角色 = 建两条会话(第三条就是被覆盖的泄漏)").toBe(2);
    expect(h.maxPerSession, "一条会话同时只有一个回合在飞").toBe(1);

    releaseTurn(h, "pA", WK, "wkA");
    releaseTurn(h, "pA", BM, null);
    await pass;
    await sleep(50);
    // **判据面**:每个跑过回合的 `(上下文, 角色)` 恰好一条常驻会话 —— 多出来的
    // 那一条就是 `getOrCreateSession` 的 check-then-act 建重了、且永远不会被回收的那条。
    const keys = new Set(h.turns.map((t) => sessionKeyOf(t.projectId, t.role)));
    expect(keys.size, "现场至少要有两个角色,否则这条断言是空的").toBeGreaterThanOrEqual(2);
    expect(h.sessionCreations, `跑过 ${keys.size} 个 (上下文, 角色) ⇒ 只许建 ${keys.size} 条`).toBe(keys.size);
  });
});

describe("⑦ R1 的雷 (b):排空的回合撞上甲方那条路时**排队等**", () => {
  itT("业务经理那条常驻会话上**同时只有一个回合在飞**", async () => {
    const s = await startHost();
    const db = s.db();
    seedProject(db, "pA", "wkA");
    h.blockedWork.set("pA", "wkA");
    h.blockedRole.add(sessionKeyOf("pA", BM));

    // 第 1 回合:worker 执行(卡住)
    const pass = s.runTimerNow();
    expect(await until(() => hasWaiter(h, "pA", WK, "wkA")), diag()).toBe(true);

    // 甲方那条路同时起来(业务经理被占用,卡住)
    s.send({ type: "send", projectId: "pA", content: "在吗" });
    expect(await until(() => hasWaiter(h, "pA", BM, null)), diag()).toBe(true);

    // 给业务经理造一条**排在审查之后**的待办:有人问它(`answer_ask`,最高优先级)。
    // ⚠️ 用 ask 而不是 outbox 的 `report_downstream`:后者优先级最低(10),而终态
    // 工作项会让 `integrate`(8)每回合都成立并反复叫醒项目经理 —— 汇报永远排不上。
    insertAsk(db, {
      id: "ask1", projectId: "pA", fromAgentId: "pm", toAgentId: "bm",
      question: "这条产出算验收了吗?", hypothesis: "我猜算,但需要你确认",
      createdAt: 2,
    });

    // 放掉 worker ⇒ 排空立刻想叫醒业务经理,而甲方那条路还占着
    releaseTurn(h, "pA", WK, "wkA");
    await sleep(250);

    expect(
      h.perSession.get(sessionKeyOf("pA", BM)) ?? 0,
      `排空那条汇报回合必须**等**甲方那条说完 —— 两条流打进同一条会话就是真竞态 —— ${diag()}`,
    ).toBe(1);
    expect(h.maxPerSession, "整个测试里 `(pA, business_manager)` 从来没有两条回合同时在飞").toBe(1);
    expect(bmTurns("pA").length, "两个回合都还卡着 ⇒ **一个都还没跑完**").toBe(0);

    // 甲方那条说完 ⇒ 排队的那一回合立刻接上(闩交班,不是等下一个 tick)
    releaseTurn(h, "pA", BM, null);
    expect(
      await until(() => bmTurns("pA").length >= 2),
      `闩一空出来,排空的汇报回合必须**当场**跑,而不是等下一个定时器 tick —— ${diag()}`,
    ).toBe(true);
    await pass;
    expect(h.maxPerSession).toBe(1);
  });
});

describe("⑧ 雷 (a):排空正在唤醒业务经理时,甲方那条消息**不许与它各自建出一条会话**", () => {
  itT("会话创建的窗口被撑到 60ms:第二条路必须拿到 `code=busy`,而不是一起进 `getOrCreateSession`", async () => {
    const s = await startHost();
    const db = s.db();
    seedProject(db, "pA", null);
    // `answer_ask` 优先级最高(0)⇒ 排空**第一个**回合就是业务经理那条
    insertAsk(db, {
      id: "ask0", projectId: "pA", fromAgentId: "pm", toAgentId: "bm",
      question: "这条产出算验收了吗?", hypothesis: "我猜算,但需要你确认",
      createdAt: 1,
    });
    h.sessionCreateMs = 60; // 撑开 check-then-act 的窗口(`sessions.get` → await → `set`)

    const pass = s.runTimerNow();
    // 排空同步握住 `(pA, bm)` 那把闩,然后卡在 `await createPlatformSession` 里
    await sleep(30);
    s.send({ type: "send", projectId: "pA", content: "在吗" });
    const busy = await until(() => busyErrors().length === 1, 3000);

    await pass;
    await sleep(200);
    // **这一条就是雷 (a) 的判据**:每个 `(上下文, 角色)` 恰好一条常驻会话。
    // 关掉 `withTurnLatch` 时这里是 3 而 keys.size 是 2 —— 两条路都读到
    // `sessions.get() === undefined`,各建一条,后一次 `set` 覆盖前一条,
    // 被覆盖的那条永远不会被 `disposeSessionsFor` 回收。
    const keys = new Set(h.turns.map((t) => sessionKeyOf(t.projectId, t.role)));
    expect(keys.size, "现场至少要有业务经理那条,否则断言是空的").toBeGreaterThanOrEqual(1);
    expect(
      h.sessionCreations,
      `跑过 ${keys.size} 个 (上下文, 角色) ⇒ 只许建 ${keys.size} 条会话` +
        `(建多了就是两条路各自读到 sessions.get()===undefined)—— ${diag()}`,
    ).toBe(keys.size);
    expect(busy, `闩在排空手里 ⇒ 甲方这条必须被拒(而不是并排进 getOrCreateSession)—— ${diag()}`).toBe(true);
  });
});

// ── 活 2:usage 的两行接线 ───────────────────────────────────────

describe("活 2 · usage 接线(`turn_usage.session_id` + `usage_recorded`)", () => {
  itT("项目内回合:session_id **非 NULL** 且指向那个项目的那条会话;WS 收到 `usage_recorded`", async () => {
    const s = await startHost();
    const db = s.db();
    seedProject(db, "pA", null);
    h.emitUsage = true;

    s.send({ type: "send", projectId: "pA", content: "你好" });
    expect(await until(() => bmTurns("pA").length === 1), diag()).toBe(true);
    expect(await until(() => (
      db.prepare(`SELECT COUNT(*) AS n FROM turn_usage WHERE agent_id = 'bm'`).get() as { n: number }
    ).n === 1), diag()).toBe(true);

    const row = db
      .prepare(`SELECT project_id, session_id, input_tokens, output_tokens, cache_read
                FROM turn_usage WHERE agent_id = 'bm'`)
      .get() as {
        project_id: string | null; session_id: string | null;
        input_tokens: number; output_tokens: number; cache_read: number;
      };
    expect(row.project_id).toBe("pA");
    expect(row.session_id, "**这一条就是接线之前会落 NULL 的那个字段**").not.toBeNull();
    // 它必须指向**这个项目里真有的那一条会话**,而不是随便一个 id。
    // ⚠️ 此刻通道是 `internal` 而**不是** `client`:交付对话还没开出来,而
    // `ensureSession` 的 `client` 有一条明确回退(见它的注视)—— 这条断言把
    // 那个回退一起钉住,免得「session_id 有值」被误读成「交付对话已经开了」。
    const session = db
      .prepare(`SELECT id, project_id, channel FROM project_sessions WHERE id = ?`)
      .get(row.session_id) as
      { id: string; project_id: string | null; channel: string } | undefined;
    expect(session, "session_id 必须能在 `project_sessions` 里查到那一行").toBeTruthy();
    expect(session!.project_id).toBe("pA");
    expect(session!.channel, "交付对话未开 ⇒ 落在项目内部会话(client 通道的唯一回退)").toBe("internal");
    expect([row.input_tokens, row.output_tokens, row.cache_read]).toEqual([7, 3, 5]);

    // ⚠️ WS 那一跳是**异步**的(库里的行已经落了,包还在路上)—— 不能用同步断言:
    // 第一版就是这么写的一次假红(`emitUsageRecorded` 之前零调用方,expected 0 to be greater than 0)。
    expect(
      await until(() => events.some((e) => e.type === "usage_recorded")),
      `\`emitUsageRecorded\` 之前**零调用方** —— 一个包都不该少 —— ${diag()}`,
    ).toBe(true);
    const usageEvents = events.filter((e) => e.type === "usage_recorded");
    expect(usageEvents[0]!.projectId).toBe("pA");
    const usage = usageEvents[0]!.usage as
      { input?: number; sessionId?: string | null } | undefined;
    expect(usage?.input).toBe(7);
    expect(usage?.sessionId, "事件里也带那条会话 —— 与库里那一行同一件事").toBe(row.session_id);
  });

  itT("接待会话回合:project_id 为 NULL;`session_id` 的实际取值**如实钉住**", async () => {
    const s = await startHost();
    const db = s.db();
    ensureOrg(db, 1); // 接待会话也要有组织(否则会话建不出来)
    h.emitUsage = true;

    s.send({ type: "send", projectId: null, content: "我想做个东西" });
    expect(await until(() => h.turns.filter((t) => t.projectId === null).length === 1), diag()).toBe(true);
    expect(await until(() => (
      db.prepare(`SELECT COUNT(*) AS n FROM turn_usage`).get() as { n: number }
    ).n >= 1), diag()).toBe(true);

    const row = db
      .prepare(`SELECT project_id, session_id FROM turn_usage WHERE agent_id = 'bm'`)
      .get() as { project_id: string | null; session_id: string | null };
    expect(row.project_id, "接待会话的真语义:还没有项目").toBeNull();
    // ⚠️ **实测**:接待会话在回合开始**之前**就已经有会话行了(`handleUserMessage`
    // 先 `ensureSession` 再跑回合),所以按「宿主两处调用点各传一个 sessionId」接线
    // 之后,这一格**不是** NULL —— 而是**那条接待会话自己的 id**。
    // 也就是说 018 注释里的「NULL = 接待会话(还没有会话行)」在今天的接线之后
    // **不再由接待会话产生**;NULL 只剩「调用方没传」(已不存在)与「那条会话已被删」
    // (无外键,值不会被抹掉 —— 只会留一个指向已删行的 id)。
    // 这条断言钉的是**事实**,不是期望:要它变成 NULL 得改接线(见报告)。
    const intakeSession = (
      db.prepare(`SELECT id FROM project_sessions WHERE project_id IS NULL`).get() as
        | { id: string } | undefined
    )?.id;
    expect(intakeSession, "接待会话行真的存在 —— 这就是 session_id 非 NULL 的原因").toBeTruthy();
    expect(row.session_id).toBe(intakeSession);
  });
});
