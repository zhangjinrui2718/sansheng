/**
 * D1–D4 · **多个项目真正同时推进**
 *
 * ── 这批测试要钉住的性质(每一条都能被一次「改回去」弄红)──────────
 *
 *   ① **并行真的发生了**:两个项目的回合时间**重叠** —— 不是靠日志或计数
 *      推断出来的,是两条 `[startedAt, endedAt]` 区间真的相交。
 *   ② **上界真的生效**:4 个项目同时待排空时,同时在跑的回合数**恰好** 3
 *      (以及 `maxConcurrentProjects: 4` 时它真的能到 4 —— 证明「3」是上界的
 *      功劳,不是别的什么东西在挡)。
 *   ③ **D3:A 排空期间 B 敲门 → B 立刻被处理**,不等下一个定时器 tick
 *      (定时器在这条测试里被挪到一小时之后,所以 B 只有门铃这一条路)。
 *   ④ **`hub.busy` 语义不变**:同一个项目并发两条用户消息,第二条被拒
 *      `code=busy`。
 *   ⑤ **中断仍按项目**:中断 B 不动 A。
 *   ⑥ **D4**:两个项目拿到**各自的**会话 cwd(`<工作根>/projects/<id>`,无条件 ——
 *      `isolateProjectCwd` 开关已随「老数据不要」一起删),而接待会话仍在工作根本身。
 *
 * ── 为什么用假会话 ──────────────────────────────────────────────
 *
 * 这一层要测的是**宿主怎么排期**(谁和谁并行、上界是多少、门铃落在哪个项目),
 * 不是模型怎么说话。真模型那条路由真机端到端覆盖(报告里贴了日志)。
 * 假会话能精确控制「这个回合卡多久」,于是「重叠」这件事可以被**断言**,
 * 而不是被希望。
 *
 * ⚠️ 假会话**不调任何工具**:每次 `drainOne` 只跑一个回合(`maxCascadeRounds: 1`),
 * 于是「哪个项目跑了几个回合」在这些测试里是确定的,不会被「完成工作项 →
 * 冒出质检待办 → 再跑一个回合」这一串副作用搅浑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket, type WebSocketServer } from "ws";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createPlatformHost, type PlatformHost } from "../../src/platform/host/serve.js";
import { attachHub } from "../../src/platform/transport/hub.js";
import { listProviders } from "../../src/platform/infra/providers.js";
import { ensureOrg, ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { insertWork } from "../../src/platform/storage/repo/works.js";
import type { CreateSessionFn } from "../../src/platform/runtime/session.js";

// ── 夹具 ────────────────────────────────────────────────────────

/** 跑完的一个回合。`cwd` 是**建会话时** SDK 拿到的那个(D4 的断言面)。 */
interface Turn {
  readonly projectId: string | null;
  readonly workId: string | null;
  readonly cwd: string;
  readonly startedAt: number;
  readonly endedAt: number;
}

interface Harness {
  readonly turns: Turn[];
  inflight: number;
  maxInflight: number;
  readonly aborts: string[];
  /** 整个项目都卡住(用于 ④ busy:BM 那条聊天回合也要卡) */
  readonly blockedAll: Set<string>;
  /** 只卡某个项目的某一条工作项回合(`projectId → workId`) */
  readonly blockedWork: Map<string, string>;
  readonly releases: Map<string, () => void>;
  /** 每个回合额外空转这么久(用于 ② 的并发观测) */
  spinMs: number;
  /**
   * **按项目**空转(只给某一个项目的回合用)。
   *
   * 它是 ③b 的排序装置:那条测试要求「B 的敲门必须落在 A 那一趟**还没结束**的时候」,
   * 所以 A 的回合要慢、B 的聊天回合要快。用全局 `spinMs` 会把 B 的聊天回合也拖慢,
   * 于是敲门落在那趟之后 —— 而那是**另一条**(不判别 deliberateStop 的)路径。
   */
  readonly spinByProject: Map<string, number>;
  /**
   * 让**第一条项目内的聊天回合**(不是工作项回合)真的调一次 `project_open`,
   * 立起一个**别的**项目 —— 那是「一次状态迁移影响到别的项目」的唯一场合,
   * 也是全局门铃(`nudge()` 无参)唯一的读者。只开一次。
   */
  openProjectOnFirstChat: boolean;
  openedOnce: boolean;
}

function makeHarness(): Harness {
  return {
    turns: [],
    inflight: 0,
    maxInflight: 0,
    aborts: [],
    blockedAll: new Set(),
    blockedWork: new Map(),
    releases: new Map(),
    spinMs: 0,
    spinByProject: new Map(),
    openProjectOnFirstChat: false,
    openedOnce: false,
  };
}

/** `projectContext` 注入的项目行(`runtime/projectContext.ts:104`)。 */
const PROJECT_ID_RE = /项目 ID:`([^`]+)`/;
/** 工作项回合的任务正文(`runtime/execution.ts:210`)。 */
const WORK_ID_RE = /^# 工作项 (\S+)/m;

function makeCreateSession(h: Harness): CreateSessionFn {
  return async (opts) => {
    const listeners = new Set<(ev: AgentSessionEvent) => void>();
    const emit = (ev: AgentSessionEvent): void => {
      for (const l of [...listeners]) l(ev);
    };
    const cwd = opts.cwd ?? "";
    /** 这条会话属于哪个项目 —— `abort()` 没有别的办法知道(它拿不到 prompt)。 */
    let lastProjectId: string | null = null;

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
        const workId = text.match(WORK_ID_RE)?.[1] ?? null;
        lastProjectId = projectId;
        const startedAt = Date.now();
        h.inflight++;
        if (h.inflight > h.maxInflight) h.maxInflight = h.inflight;
        try {
          // 项目内的**聊天**回合(不是工作项回合)里真的调一次 `project_open`。
          // 走 `customTools` 而不是直接 INSERT —— 门铃挂在 `dispatch()` 这个唯一
          // 漏斗上,绕开它就测不到「门铃有没有响」。
          if (h.openProjectOnFirstChat && !h.openedOnce && projectId !== null && workId === null) {
            h.openedOnce = true;
            const open = (opts.customTools ?? []).find((t) => t.name === "project_open");
            if (open !== undefined) {
              // ⚠️ **必须把工具事件也发出来**:`runTurn` 的 `openedProjectIds` 是从
              // `tool_execution_end` 的 `details.data.projectId` 读的,不是从
              // `execute()` 的返回值读的。只调工具不发事件 ⇒ 宿主根本不知道立了项目
              // (第一版就是这么写的,于是这条测试红了 —— 它红得对)。
              emit({
                type: "tool_execution_start", toolCallId: "tc_open",
                toolName: "project_open", args: {},
              } as unknown as AgentSessionEvent);
              const result = await open.execute("tc_open", {
                name: "在项目里立的新项目", client: "甲方", goal: "验证全局门铃",
              });
              emit({
                type: "tool_execution_end", toolCallId: "tc_open", toolName: "project_open",
                result, isError: false,
              } as unknown as AgentSessionEvent);
            }
          }
          const shouldBlock =
            projectId !== null &&
            (h.blockedAll.has(projectId) ||
              (workId !== null && h.blockedWork.get(projectId) === workId));
          if (shouldBlock) {
            await new Promise<void>((r) => {
              h.releases.set(projectId, r);
            });
            h.releases.delete(projectId);
          }
          const spin = Math.max(
            h.spinMs,
            projectId !== null ? (h.spinByProject.get(projectId) ?? 0) : 0,
          );
          if (spin > 0) await new Promise<void>((r) => setTimeout(r, spin));
        } finally {
          h.inflight--;
        }
        h.turns.push({ projectId, workId, cwd, startedAt, endedAt: Date.now() });
        emit({ type: "agent_settled" } as AgentSessionEvent);
      },
      async abort() {
        // SDK 的 `abort()` 让回合收敛;假会话照做 —— 但**只放掉自己那条会话
        // 所属的项目的那个阻塞**,这正是 ⑤ 要验的东西(中断是按项目的)。
        const p = lastProjectId;
        h.aborts.push(p ?? "<unknown>");
        if (p !== null) h.releases.get(p)?.();
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
async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  dataDir = mkdtempSync(join(tmpdir(), "ss-d1d4-"));
  root = join(dataDir, "ws");
  mkdirSync(root, { recursive: true });
  const p = listProviders()[0];
  const model = p?.models[0];
  if (p === undefined || model === undefined) {
    throw new Error("内建 provider catalog 是空的 —— 测试夹具无法造出「已配置 provider」的现场");
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

async function startHost(o: {
  maxConcurrentProjects?: number;
} = {}): Promise<Started> {
  host = createPlatformHost({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    version: "test",
    cwd: root,
    // 定时器挪到一小时之后:这些测试要的是**门铃与显式触发**,不是兜底 tick。
    // ③ 正是靠这一点才成立(它要证明 B 没等下一个 tick)。
    dispatchIntervalMs: 3_600_000,
    maxCascadeRounds: 1,
    ...(o.maxConcurrentProjects !== undefined
      ? { maxConcurrentProjects: o.maxConcurrentProjects }
      : {}),
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
  return {
    send: (cmd) => ws!.send(JSON.stringify(cmd)),
    db: () => captured.booted.deps.db,
    runTimerNow: () => captured.dispatchTimer.runNow(),
  };
}

/** 一个能马上开工的项目:默认组织 + 一条派给 worker 的工作项。 */
function seedProject(
  db: import("better-sqlite3").Database,
  projectId: string,
  workId: string | null,
  createdAt = 1,
): void {
  ensureOrg(db, createdAt);
  insertProject(db, {
    id: projectId, name: projectId, client: "甲方", goal: "g", status: "active", createdAt,
  });
  ensureProjectOrg(db, projectId, createdAt);
  if (workId !== null) {
    insertWork(db, {
      id: workId, projectId, parentWorkId: null, title: workId, goal: "g", status: "open",
      assigneeAgentId: "wk", createdAt, updatedAt: createdAt,
    });
  }
}

/** 一条**终态**工作项 —— 用来让一个项目「已经拆过、但没有可执行的待办」。 */
function seedTerminalWork(
  db: import("better-sqlite3").Database,
  projectId: string,
  workId: string,
  createdAt: number,
): void {
  insertWork(db, {
    id: workId, projectId, parentWorkId: null, title: workId, goal: "g", status: "cancelled",
    assigneeAgentId: "wk", createdAt, updatedAt: createdAt,
  });
}

const workTurns = (projectId: string): Turn[] =>
  h.turns.filter((t) => t.projectId === projectId && t.workId !== null);

const release = (projectId: string): void => {
  h.releases.get(projectId)?.();
};

/** 两条区间真的相交(端点相等的退化情形不算 —— 那是「刚接上」,不是重叠)。 */
function overlaps(a: Turn, b: Turn): boolean {
  return a.startedAt < b.endedAt && b.startedAt < a.endedAt;
}

// ── ① 并行真的发生了 ────────────────────────────────────────────

describe("① 跨项目并行(判据是回合区间真的相交)", () => {
  it("cap=3:A 卡住时 B 的流水线照常推进,两个回合**重叠**", async () => {
    const s = await startHost();
    const db = s.db();
    seedProject(db, "pA", "wkA");
    seedProject(db, "pB", "wkB");
    h.blockedWork.set("pA", "wkA");
    // B 那个回合跑 500ms —— 「重叠」是要**断言**的性质,所以两条区间必须有
    // 一个足够宽的公共窗口,而不是靠「两边都很快」碰运气。
    // (A 卡在阻塞上,它的窗口从开始一直开到 `release`。)
    h.spinMs = 500;

    const pass = s.runTimerNow();
    // A 必须真的卡住了(否则下面的「B 重叠」是一句空话)
    expect(await until(() => h.releases.has("pA"))).toBe(true);
    // A 卡着,B 仍然跑完
    expect(
      await until(() => workTurns("pB").length === 1),
      "A 卡住期间 B 的回合必须已经跑完 —— 顺序实现下这里会超时",
    ).toBe(true);
    expect(workTurns("pA").length, "A 的回合此刻还不该结束(它是被卡住的那个)").toBe(0);

    release("pA");
    await pass;
    const a = workTurns("pA")[0]!;
    const b = workTurns("pB")[0]!;
    expect(overlaps(a, b), "两个项目的回合区间必须相交 —— 这才叫并行").toBe(true);
    expect(h.maxInflight, "同时最多两个回合在跑").toBeGreaterThanOrEqual(2);
    // B 是**在 A 结束之前**就跑完的(A 的窗口一直开到 release,而 release 在 B 之后)
    expect(b.endedAt).toBeLessThan(a.endedAt);
  });

  it("① 负对照:cap=1 时同样的现场**不重叠**(证明上一条有牙)", async () => {
    const s = await startHost({ maxConcurrentProjects: 1 });
    const db = s.db();
    seedProject(db, "pA", "wkA");
    seedProject(db, "pB", "wkB");
    h.blockedWork.set("pA", "wkA");

    const pass = s.runTimerNow();
    expect(await until(() => h.releases.has("pA"))).toBe(true);
    // 上界是 1 ⇒ B 抢不到许可,必须等 A 跑完
    await sleep(200);
    expect(workTurns("pB").length, "cap=1 时 B 不该在 A 卡住期间跑起来").toBe(0);

    release("pA");
    await pass;
    expect(workTurns("pA").length).toBe(1);
    expect(workTurns("pB").length).toBe(1);
    expect(overlaps(workTurns("pA")[0]!, workTurns("pB")[0]!)).toBe(false);
    expect(h.maxInflight, "cap=1 ⇒ 从来没有两个回合同时在跑").toBe(1);
  });
});

// ── ② 并发上限是硬上界 ──────────────────────────────────────────

describe("② 并发上限 N(默认 3)是硬上界", () => {
  it("4 个项目同时待排空 → 同时在跑的回合数**恰好** 3,且 4 个最终都跑到", async () => {
    const s = await startHost();
    const db = s.db();
    for (const id of ["p1", "p2", "p3", "p4"]) seedProject(db, id, `wk_${id}`);
    h.spinMs = 150;

    await s.runTimerNow();

    expect(h.maxInflight, "上限是 3:第 4 个项目必须等一个许可空出来").toBe(3);
    for (const id of ["p1", "p2", "p3", "p4"]) {
      expect(workTurns(id).length, `${id} 最终必须跑到(上界不能变成「丢掉」)`).toBe(1);
    }
  });

  it("② 对照:把上限设成 4 时它真的到 4(证明「3」是上界的功劳)", async () => {
    const s = await startHost({ maxConcurrentProjects: 4 });
    const db = s.db();
    for (const id of ["p1", "p2", "p3", "p4"]) seedProject(db, id, `wk_${id}`);
    h.spinMs = 150;

    await s.runTimerNow();

    expect(h.maxInflight).toBe(4);
  });
});

// ── ③ D3:排空期间另一个项目敲门不被吞掉 ────────────────────────

describe("③ D3:A 排空期间 B 敲门 → B 立刻被处理(不等下一个 tick)", () => {
  it("B 的工作项在 A 还卡着的时候就跑完了(定时器在一小时之后)", async () => {
    const s = await startHost();
    const db = s.db();
    // B 起手**没有**工作项 —— 这样第一趟排空不会顺手把 B 做掉,
    // 「B 被处理」只可能来自那次敲门。
    seedProject(db, "pA", "wkA");
    seedProject(db, "pB", null);
    h.blockedWork.set("pA", "wkA");

    const pass = s.runTimerNow();
    expect(await until(() => h.releases.has("pA"))).toBe(true);
    // B 这一趟是空转(没有待办)—— 确认现场成立
    expect(workTurns("pB").length).toBe(0);

    // ① 有人(外部 / 另一个驱动者)在 B 里造出一条工作项
    insertWork(db, {
      id: "wkB", projectId: "pB", parentWorkId: null, title: "wkB", goal: "g", status: "open",
      assigneeAgentId: "wk", createdAt: 2, updatedAt: 2,
    });
    // ② 从**真链路**敲 B 的门:用户对 B 说一句话 → 回合结束 → `nudge(pB)`
    s.send({ type: "send", projectId: "pB", content: "开工" });

    expect(
      await until(() => workTurns("pB").length === 1),
      "B 必须在 A 还卡着的时候被处理 —— 旧实现会把这次敲门存进全局标记,等 A 跑完才动",
    ).toBe(true);
    // 关键:B 跑完的那一刻 A 仍然卡着(A 的回合一次都没结束过)
    expect(workTurns("pA").length, "B 被处理时 A 还没结束").toBe(0);

    release("pA");
    await pass;
    expect(workTurns("pA").length).toBe(1);
  });

  it("③b 旧实现真正的吞法:A **故意停下**(max_rounds)时 B 的敲门不许被一起丢掉", async () => {
    const s = await startHost(); // maxCascadeRounds = 1
    const db = s.db();
    // ⚠️ **次序是这条测试的关键。** `listProjects` 是 `created_at DESC` ⇒ B 比 A 新
    // ⇒ **B 先被扫过**。旧实现的吞法正是「B 已经被扫过(那会儿它没待办)→ A 卡住
    // → 敲门进来 → A 撞上界置 `deliberateStop`(当时是**全局**的)→ while 直接退出
    // ⇒ 那次敲门再也没人读」。B 排在 A 后面的话,for 循环会顺手把 B 补上,洞就不显形了。
    seedProject(db, "pA", "wkA1", 1);
    insertWork(db, {
      id: "wkA2", projectId: "pA", parentWorkId: null, title: "wkA2", goal: "g", status: "open",
      assigneeAgentId: "wk", createdAt: 1, updatedAt: 1,
    }); // A 有两条 ⇒ maxRounds=1 时**必定**故意停下
    seedProject(db, "pB", null, 2);
    seedTerminalWork(db, "pB", "wkB_terminal", 2); // B 起手没有可执行待办(不是「零工作项」)
    // A 的回合慢、B 的聊天回合快 —— 这样「敲门落在 A 那一趟之内」是**结构保证**,
    // 不是靠 sleep 赌(第一版用固定 blocked + 立刻 release,敲门落在了那一趟**之后**,
    // 于是旧实现也会绿 —— 一条没有牙的测试,已实跑确认)。
    h.spinByProject.set("pA", 500);

    const pass = s.runTimerNow();
    expect(await until(() => h.inflight > 0)).toBe(true); // A 的回合起来了
    expect(
      h.turns.filter((t) => t.projectId === "pB").length,
      "B 在这一趟里已经被扫过了(它那会儿确实没有待办 —— 次序由 created_at DESC 保证)",
    ).toBe(0);

    // B 现在才长出待办,并从真链路敲门(用户对 B 说一句话 → 回合结束 → `nudge(pB)`)
    insertWork(db, {
      id: "wkB2", projectId: "pB", parentWorkId: null, title: "wkB2", goal: "g", status: "open",
      assigneeAgentId: "wk", createdAt: 3, updatedAt: 3,
    });
    s.send({ type: "send", projectId: "pB", content: "开工" });
    // 等那条聊天回合(敲门就是它结束时敲的),再让出一个 macrotask —— 门铃是
    // `runAgentTurn` 返回之后的微任务链,不能让 `await pass` 抢在它前面。
    expect(
      await until(() => h.turns.some((t) => t.projectId === "pB" && t.workId === null)),
    ).toBe(true);
    await sleep(30);
    expect(h.turns.filter((t) => t.projectId === "pA").length, "A 那 500ms 还没跑完").toBe(0);

    await pass; // 这一趟在这里结束 —— 旧实现就是在这个点上把 B 的敲门丢掉的
    // ⚠️ 必须 `until` 而不是同步断言:那一趟跑完 ≠ 敲门那条链也跑完了。
    expect(
      await until(() => h.turns.some((t) => t.projectId === "pB" && t.workId === "wkB2")),
      "A 撞上界只该停 A;B 的敲门必须照跑(定时器在一小时之后,没有第二条路)",
    ).toBe(true);
    // 而且它是在 A 那一趟**之内**跑的(不是等 A 结束后补的)
    const a = h.turns.find((t) => t.projectId === "pA" && t.workId === "wkA1")!;
    const b2 = h.turns.find((t) => t.projectId === "pB" && t.workId === "wkB2")!;
    expect(b2.startedAt).toBeLessThan(a.endedAt);
  });
});

// ── ④ hub.busy 语义不变 ─────────────────────────────────────────

describe("④ hub.busy 语义不变:同一个项目并发两条用户消息被拒 code=busy", () => {
  it("第二条 `send` 收到 busy,且**只有一条** BM 回合被建起来", async () => {
    const s = await startHost();
    const db = s.db();
    seedProject(db, "pA", null);
    h.blockedAll.add("pA");

    s.send({ type: "send", projectId: "pA", content: "第一条" });
    expect(await until(() => h.inflight > 0)).toBe(true);
    s.send({ type: "send", projectId: "pA", content: "第二条" });

    expect(
      await until(() => events.some((e) => (e.error as { code?: string } | undefined)?.code === "busy")),
      "同一个项目并发两条消息必须被 `code=busy` 拒掉",
    ).toBe(true);
    // 拒绝必须是**第二条**,不是把第一条也拒了
    const busy = events.filter((e) => (e.error as { code?: string } | undefined)?.code === "busy");
    expect(busy.length).toBe(1);
    expect((busy[0]!.projectId as string)).toBe("pA");

    release("pA");
    expect(await until(() => h.turns.filter((t) => t.projectId === "pA").length === 1)).toBe(true);
    // 另一条消息没有跑成第二个回合
    await sleep(150);
    expect(h.turns.filter((t) => t.projectId === "pA").length).toBe(1);
  });
});

// ── ⑤ 中断仍按项目 ──────────────────────────────────────────────

describe("⑤ 中断按项目:onInterrupt(B) 不动 A", () => {
  it("中断 B 后 A 的回合照常跑完,且 A 的会话没有被 abort 过", async () => {
    const s = await startHost();
    const db = s.db();
    seedProject(db, "pA", "wkA");
    seedProject(db, "pB", "wkB");
    h.blockedWork.set("pA", "wkA");
    h.blockedWork.set("pB", "wkB");

    const pass = s.runTimerNow();
    expect(await until(() => h.releases.has("pA") && h.releases.has("pB"))).toBe(true);

    s.send({ type: "interrupt", projectId: "pB" });

    expect(await until(() => workTurns("pB").length === 1)).toBe(true);
    expect(h.aborts).toEqual(["pB"]);
    // A 一点没被碰:还在卡着,B 的中断没有把它放掉
    expect(h.releases.has("pA"), "A 的阻塞不该被 B 的中断放掉").toBe(true);
    expect(workTurns("pA").length).toBe(0);

    release("pA");
    await pass;
    expect(workTurns("pA").length).toBe(1);
    expect(h.aborts, "A 从来没被 abort 过").toEqual(["pB"]);
  });
});

// ── ⑥ D4:每项目独立 cwd(**无条件**,开关已删)──────────────────

describe("⑥ D4:每项目独立 cwd(无条件)", () => {
  it("两个项目拿到各自的工作根子目录,同一个相对路径落在不同绝对路径", async () => {
    const s = await startHost();
    const db = s.db();
    seedProject(db, "pA", "wkA");
    seedProject(db, "pB", "wkB");

    await s.runTimerNow();

    const a = workTurns("pA")[0]!;
    const b = workTurns("pB")[0]!;
    expect(a.cwd).toBe(join(resolve(root), "projects", "pA"));
    expect(b.cwd).toBe(join(resolve(root), "projects", "pB"));
    expect(a.cwd).not.toBe(b.cwd);
    // 目录必须真的存在 —— SDK 的 `bash` 会 `fsAccess(cwd)` 并在缺失时报错
    expect(existsSync(a.cwd)).toBe(true);
    expect(existsSync(b.cwd)).toBe(true);
    // 同一个相对路径 ⇒ **不同**绝对路径(跨项目耦合被拆掉:这正是 D4 的语义)
    expect(resolve(a.cwd, "src/x.ts")).not.toBe(resolve(b.cwd, "src/x.ts"));
  });

  it("**接待会话**仍然用工作根本身(它不属于任何项目,也不建仓)", async () => {
    const s = await startHost();
    s.send({ type: "send", projectId: null, content: "我想做个东西" });
    expect(await until(() => h.turns.length === 1)).toBe(true);
    const t = h.turns[0]!;
    expect(t.projectId).toBeNull();
    expect(t.cwd).toBe(resolve(root));
    // ⚠️ 接待会话**不建仓**:立项之前没有项目,给它建一个仓等于凭空造一个仓库。
    expect(existsSync(join(resolve(root), ".git"))).toBe(false);
  });
});

// ── ⑦ 项目内立项:全局门铃那条路的唯一读者 ──────────────────────

describe("⑦ 项目内 `project_open`:新项目不能只等下一个 tick", () => {
  it("在项目里立起的新项目**当场**被排空捡起来(定时器在一小时之后)", async () => {
    const s = await startHost();
    const db = s.db();
    seedProject(db, "pA", null);
    h.openProjectOnFirstChat = true;

    s.send({ type: "send", projectId: "pA", content: "顺带开一个调研项目" });

    expect(
      await until(() => (db.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as { n: number }).n === 2),
      "`project_open` 必须真的立起了第二个项目(否则下面的断言是空谈)",
    ).toBe(true);
    const newId = (
      db.prepare(`SELECT id FROM projects WHERE id <> 'pA' LIMIT 1`).get() as { id: string }
    ).id;

    // 门铃按项目敲 —— 新项目**不在** pA 那条门铃的范围内。它被捡起来只能靠
    // `handleUserMessage` 末尾那一次**全局**扫(`nudge()` 无参)。
    expect(
      await until(() => h.turns.some((t) => t.projectId === newId)),
      "新项目必须当场被排空(定时器在一小时之后 ⇒ 拿不到它就说明全局门铃没响)",
    ).toBe(true);
  });
});
