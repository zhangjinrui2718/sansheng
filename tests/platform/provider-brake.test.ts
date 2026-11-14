/**
 * provider 故障「全局刹车」+ 预算恢复(批次 31)。
 *
 * 用户需求:项目没完结,但网络抖动 / 限流把所有员工打停了 —— 平台要能
 * **周期性自愈**,而不是等甲方来推。
 *
 * 判据落点:
 * - 刹车本体:`src/platform/runtime/providerBrake.ts`(进程级内存;限流,不是判据);
 * - 宿主接线:`serve.ts` 的 `drainProjectLoop`(退避期内不叫醒任何人)、
 *   `runAgentTurn` / `runWorkInSession` 的刹车分支 + 成功清零;
 * - 预算恢复:`dispatcher.ts` 的 `brakePaused ⇒ resetAttempt`(那 3 次是给人用的限流)。
 *
 * 每条测试**前后都要清刹车状态** —— 它是进程级内存,文件里的测试共享同一份
 * 模块状态;上一条测试留下的 30 秒退避期会把这一条的派发静默挡住
 * (症状是「turns 不增长」,看起来像判据坏了,其实是夹具互相污染)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createPlatformHost, type PlatformHost } from "../../src/platform/host/serve.js";
import { attachHub } from "../../src/platform/transport/hub.js";
import { listProviders, providerEnvKey } from "../../src/platform/infra/providers.js";
import {
  brakeStateForTest,
  clear as clearProviderBrake,
  configureProviderBrake,
  isBraked as providerBrakeIsBraked,
  noteProviderFailure,
} from "../../src/platform/runtime/providerBrake.js";
import { ensureOrg, ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { getWork, insertWork } from "../../src/platform/storage/repo/works.js";
import { listSessions, listSessionMessages } from "../../src/platform/storage/repo/sessions.js";
import { listAttempts } from "../../src/platform/storage/repo/dispatch.js";
import type { CreateSessionFn } from "../../src/platform/runtime/session.js";

/** 限流原文(逐字 —— 改了就测不到真机那一形态)。 */
const RATE_LIMIT_TEXT = "429 Too Many Requests — rate limit exceeded";
/** 额度原文:真机那条(分类成 quota ⇒ 2026-11-14 起**进长轴刹车**,探测式恢复)。 */
const QUOTA_TEXT =
  '{"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"}}';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

// ══════════════════════════════════════════════════════════════════
// ⓪ 纯函数:哪些 kind 刹车、退避档位、清零、配置校验
// ══════════════════════════════════════════════════════════════════

describe("⓪ providerBrake 纯函数", () => {
  beforeEach(() => {
    clearProviderBrake();
    // 恢复默认档位(上一条测试可能用 ServeOptions 覆盖过进程级常量)。
    configureProviderBrake({ baseCooldownMs: 30_000, maxCooldownMs: 480_000 });
    configureProviderBrake({ quotaBaseCooldownMs: 30 * 60_000, quotaMaxCooldownMs: 24 * 60 * 60_000 });
  });

  it("可重试的三类(rate_limit / network / server)刹车;第一次失败 = 新 episode", () => {
    const note = noteProviderFailure("rate_limit", 1000);
    expect(note.episode).toBe(true);
    expect(note.cooldownMs).toBe(30_000);
    expect(providerBrakeIsBraked(1000)).toBe(true);
    expect(providerBrakeIsBraked(1000 + 30_000)).toBe(false);
  });

  it("quota 进**长轴**刹车(2026-11-14 双轴化):30min → 2h → 8h → 24h 封顶", () => {
    // 用户裁决(2026-11-14):额度是账户级的,但充值/计费周期滚动后**会恢复** ——
    // 所以额度不该把工作项记成 failed(终态没人再唤起),该停下来等恢复;
    // 恢复信号 = 冷却到期后放行的**探测回合**成功 ⇒ 清刹车全部续跑。
    const note = noteProviderFailure("quota", 1000);
    expect(note.axis).toBe("quota");
    expect(note.episode).toBe(true);
    expect(note.cooldownMs).toBe(30 * 60_000);
    expect(providerBrakeIsBraked(1001)).toBe(true);
    expect(providerBrakeIsBraked(1000 + 30 * 60_000)).toBe(false);
    // 长轴退避(episode 内 streak 不清零,与短轴同一形状)
    expect(noteProviderFailure("quota", 1001).cooldownMs).toBe(2 * 60 * 60_000);
    expect(noteProviderFailure("quota", 1002).cooldownMs).toBe(8 * 60 * 60_000);
    expect(noteProviderFailure("quota", 1003).cooldownMs).toBe(24 * 60 * 60_000);
    expect(noteProviderFailure("quota", 1004).cooldownMs).toBe(24 * 60 * 60_000);
  });

  it("鉴权(auth)任何轴都不刹车 —— 配置问题等不好,烧预算→升级才是对的", () => {
    expect(noteProviderFailure("auth", 1001).cooldownMs).toBe(0);
    expect(providerBrakeIsBraked(1001)).toBe(false);
  });

  it("两条轴相互独立:短轴刹车不影响 quota 计数;成功一起清零", () => {
    noteProviderFailure("rate_limit", 2000); // 短轴:30s
    const q = noteProviderFailure("quota", 2001); // 长轴:30min
    expect(q.axis).toBe("quota");
    expect(providerBrakeIsBraked(2002)).toBe(true);
    const st = brakeStateForTest();
    expect(st.failureStreak).toBe(1);
    expect(st.quotaFailureStreak).toBe(1);
    clearProviderBrake();
    expect(brakeStateForTest().failureStreak).toBe(0);
    expect(brakeStateForTest().quotaFailureStreak).toBe(0);
    expect(providerBrakeIsBraked(2003)).toBe(false);
  });

  it("退避档位 30s → 2min → 8min,封顶 8 分钟(episode 内 streak 不清零)", () => {
    expect(noteProviderFailure("network", 0).cooldownMs).toBe(30_000);
    expect(noteProviderFailure("network", 1).cooldownMs).toBe(120_000);
    expect(noteProviderFailure("network", 2).cooldownMs).toBe(480_000);
    // 再来一次:还是 480_000(封顶),不会无限翻倍。
    expect(noteProviderFailure("network", 3).cooldownMs).toBe(480_000);
  });

  it("刹车期内再次失败 = 同一段(不重播)", () => {
    const first = noteProviderFailure("server", 1000);
    expect(first.episode).toBe(true);
    // 刹车期内(1000 + 30_000 之内)⇒ 延长,不重播。
    expect(noteProviderFailure("server", 2000).episode).toBe(false);
  });

  it("过期之后再失败 = 新 episode(要重播);streak 没被清 ⇒ 冷却接着涨(防抖动循环)", () => {
    noteProviderFailure("server", 0);
    const later = noteProviderFailure("server", 30_000 + 1);
    expect(later.episode).toBe(true);
    expect(later.cooldownMs).toBe(120_000);
  });

  it("clear() 清零:下一次故障从第一档重新退避", () => {
    noteProviderFailure("rate_limit", 0);
    noteProviderFailure("rate_limit", 1);
    noteProviderFailure("rate_limit", 2);
    clearProviderBrake();
    expect(providerBrakeIsBraked(3)).toBe(false);
    expect(noteProviderFailure("rate_limit", 4).cooldownMs).toBe(30_000);
  });

  it("configure 的非法值被忽略(max < base / 非正数)—— 坏参数不许把刹车变成永不派发", () => {
    configureProviderBrake({ baseCooldownMs: 1000, maxCooldownMs: 500 });
    expect(noteProviderFailure("rate_limit", 0).cooldownMs).toBe(30_000);
    configureProviderBrake({ baseCooldownMs: -1 });
    expect(noteProviderFailure("rate_limit", 1).cooldownMs).toBe(120_000);
    // 合法的整组覆盖生效(两个数一起给)。
    configureProviderBrake({ baseCooldownMs: 40, maxCooldownMs: 80 });
    expect(noteProviderFailure("rate_limit", 2).cooldownMs).toBe(80);
    expect(noteProviderFailure("rate_limit", 3).cooldownMs).toBe(80);
  });

  it("退避封顶:第 3 档起冷却停在 8min —— 不封顶的话抖动循环能把退避推到小时级", () => {
    // now=0,1,2… 都在同一窗内 ⇒ 同一段;streak 1..5 ⇒ 30s/120s/480s/cap/cap。
    const notes = [0, 1, 2, 3, 4].map((t) => noteProviderFailure("server", t));
    expect(notes.map((n) => n.cooldownMs)).toEqual([
      30_000, 120_000, 480_000, 480_000, 480_000,
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════
// 宿主夹具(仿 provider-failure.test.ts,加了 okMode)
// ══════════════════════════════════════════════════════════════════

interface Harness {
  readonly turns: Array<{ projectId: string | null; role: string | null; workId: string | null }>;
  /** 这一轮 provider 原文 —— 夹具可换(限流 / 额度)。 */
  errorText: string;
  /** true ⇒ 之后的回合成功收尾(模拟 provider 恢复)。 */
  okMode: boolean;
  /** abort() 时要不要伪造一条 provider 错误(测「超时不触发刹车」这条守卫)。 */
  abortWithError: boolean;
  /** true ⇒ 失败前先来一次工具调用(toolCalls>0 ⇒ 副作用回合不许进刹车)。 */
  useTool: boolean;
  db: import("better-sqlite3").Database | null;
}

const PROJECT_ID_RE = /项目 ID:`([^`]+)`/;
const ROLE_RE = /你是:.*?\(`([a-z_]+)`\)/;
const WORK_ID_RE = /^# 工作项 (\S+)/m;

function makeHarness(): Harness {
  return { turns: [], errorText: RATE_LIMIT_TEXT, okMode: false, abortWithError: false, useTool: false, db: null };
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
        h.turns.push({
          projectId: text.match(PROJECT_ID_RE)?.[1] ?? null,
          role: text.match(ROLE_RE)?.[1] ?? null,
          workId: text.match(WORK_ID_RE)?.[1] ?? null,
        });
        if (h.okMode) {
          emit({
            type: "message_update",
            message: {},
            assistantMessageEvent: { type: "text_delta", delta: "这是答复。" },
          } as unknown as AgentSessionEvent);
          emit({ type: "agent_settled" } as AgentSessionEvent);
          return { messages: [] };
        }
        if (h.abortWithError) {
          // abort() 由平台的墙钟定时器触发(见「超时不触发刹车」那条)。
          // 真实 pi 在打断时给 stopReason:"aborted" 而不是 error;这里故意
          // 伪造 error 信封,去钉「timedOut ⇒ 不刹车」那条守卫。
          await sleep(200);
          emit({
            type: "message_end",
            message: {
              role: "assistant", model: "fake-model",
              stopReason: "error", errorMessage: RATE_LIMIT_TEXT,
              usage: { input: 3, output: 0, cacheRead: 0 },
            },
          } as unknown as AgentSessionEvent);
          emit({ type: "agent_settled" } as AgentSessionEvent);
          return { messages: [] };
        }
        // 「已经干过活」的现场:一次工具调用 ⇒ 可能有副作用 ⇒ 自动重跑不安全。
        if (h.useTool) {
          emit({
            type: "tool_execution_start", toolCallId: "t1", toolName: "board_write", args: {},
          } as unknown as AgentSessionEvent);
          emit({
            type: "tool_execution_end", toolCallId: "t1", toolName: "board_write",
            result: { content: [{ text: "ok" }] }, isError: false,
          } as unknown as AgentSessionEvent);
        }
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
      async abort() {
        if (!h.abortWithError) emit({ type: "agent_settled" } as AgentSessionEvent);
      },
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

function writeSettings(): void {
  // 只挑有 env 映射的 provider(凭据只走 env 通道 —— 见 AGENTS.md「provider 故障」)。
  // 这里**永远只配一个**:刹车测的是「降不了级」的那一侧,备用 provider 会让
  // 降级路径抢先,刹车根本轮不到。
  const ps = listProviders().filter((p) => p.models.length > 0 && providerEnvKey(p.id) !== undefined);
  const a = ps[0];
  if (a === undefined || a.models[0] === undefined) {
    throw new Error("内建 provider catalog 是空的 —— 夹具造不出「已配置 provider」的现场");
  }
  writeFileSync(
    join(dataDir, "settings.json"),
    JSON.stringify({
      providers: [
        {
          id: "prov_a", label: "A", provider: a.id, modelId: a.models[0]!.id,
          apiKey: "key-a-not-used", thinkingLevel: "off",
        },
      ],
      activeProviderId: "prov_a", cwd: root, personaName: "测试",
    }),
    { mode: 0o600 },
  );
}

async function startHost(o: {
  brakeBaseMs?: number;
  brakeMaxMs?: number;
  quotaBrakeBaseMs?: number;
  turnWallClockMs?: number;
  maxRounds?: number;
  useTool?: boolean;
} = {}): Promise<void> {
  writeSettings();
  if (o.useTool !== undefined) h.useTool = o.useTool;
  host = createPlatformHost({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    version: "test",
    cwd: root,
    // 定时器挪到一小时之后:这里要的是**显式触发**(dispatchTimer.runNow)。
    dispatchIntervalMs: 3_600_000,
    maxCascadeRounds: o.maxRounds ?? 8,
    ...(o.turnWallClockMs !== undefined ? { turnWallClockMs: o.turnWallClockMs } : {}),
    ...(o.brakeBaseMs !== undefined || o.brakeMaxMs !== undefined
      ? {
          providerBrakeBaseCooldownMs: o.brakeBaseMs,
          providerBrakeMaxCooldownMs: o.brakeMaxMs,
        }
      : {}),
    ...(o.quotaBrakeBaseMs !== undefined
      ? { providerQuotaBrakeBaseCooldownMs: o.quotaBrakeBaseMs }
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

/** 项目内部会话里那条 `⚠️ 供应商` 平台通知(刹车 + 降级共用这个前缀)。 */
function providerNotices(): string[] {
  const db = h.db!;
  const out: string[] = [];
  for (const s of listSessions(db, "p1")) {
    for (const m of listSessionMessages(db, s.id)) {
      if (m.kind === "system" && m.content.startsWith("⚠️ 供应商")) out.push(m.content);
    }
  }
  return out;
}

/** 刹车通知 = 「已暂停」;降级通知 = 「已切换」。同一前缀,按内容分。 */
const brakeNotices = (): string[] => providerNotices().filter((c) => c.includes("已暂停"));

const workLedger = (): { attempts: number; notifiedAt: number | null } | undefined =>
  [...listAttempts(h.db!, "p1").values()].find((a) => a.todoKey === "execute_work:w1");

const workFailedEvents = (): number =>
  (h.db!
    .prepare(`SELECT kind FROM dispatch_events WHERE project_id = 'p1' AND kind = 'work_failed'`)
    .all() as unknown[]).length;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  // 刹车是进程级内存状态 —— 不清的话,上一条测试的退避期会挡住这一条的派发。
  clearProviderBrake();
  configureProviderBrake({ baseCooldownMs: 30_000, maxCooldownMs: 480_000 });
  dataDir = mkdtempSync(join(tmpdir(), "ss-providerbrake-"));
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
  clearProviderBrake();
  vi.restoreAllMocks();
});

// ══════════════════════════════════════════════════════════════════
// ① 刹车启动 + 冷却期内不派发、不烧预算
// ══════════════════════════════════════════════════════════════════

describe("① 刹车启动:冷却期内 drainAll 不派发", () => {
  it("rate_limit + 没有备用 ⇒ 第一次 tick 派发并刹车;冷却期内再 tick **不再派发**", async () => {
    await startHost();
    seedProject("w1");
    await host!.dispatchTimer.runNow();
    expect(h.turns.length, "第一次派发真的发生了").toBe(1);
    expect(providerBrakeIsBraked(Date.now()), "刹车已启动(默认冷却 30s)").toBe(true);
    expect(brakeNotices().length, "episode 第一次 ⇒ 播一条暂停通知").toBe(1);

    // 冷却期内(默认 30s,测试跑得再慢也在窗内)再排一轮:必须被闸住。
    await host!.dispatchTimer.runNow();
    expect(h.turns.length, "刹车期内不许再叫醒任何人").toBe(1);
  });

  it("刹车期内 dispatcher 不烧预算:账本没有 +1(attempts 停在 reset 后的 0)", async () => {
    await startHost();
    seedProject("w1");
    await host!.dispatchTimer.runNow();
    // 派发时 bumpAttempt(+1),刹车路径把它归零(provider 故障不烧「叫人用」的预算)。
    expect(workLedger()?.attempts, "刹车路径要重置尝试预算").toBe(0);
    await host!.dispatchTimer.runNow();
    expect(workLedger()?.attempts, "刹车期内连 bump 都不该发生").toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// ② 冷却结束自动恢复(冷却常量经 ServeOptions 调到几十 ms)
// ══════════════════════════════════════════════════════════════════

describe("② 冷却到期自动恢复派发(不需要任何人动手)", () => {
  // 冷却档位(1s/2s)必须比**一个回合的耗时**长(回合里有 git housekeeping,
  // 几十 ms 起)—— 窗口比回合短的话,同一轮排空的下一个 round 就已经过期,
  // 「turns 不增长」这类精确断言就不成立了。
  it("到期后下一次 tick 重新派发;过期后的失败开新 episode 并重播通知", async () => {
    await startHost({ brakeBaseMs: 1000, brakeMaxMs: 2000 });
    seedProject("w1");
    await host!.dispatchTimer.runNow();
    expect(h.turns.length).toBe(1);
    expect(brakeNotices().length).toBe(1);

    // 等第一档冷却(1s)过去 —— 轮询 isBraked,不猜固定 sleep。
    expect(await until(() => !providerBrakeIsBraked(Date.now()))).toBe(true);
    await host!.dispatchTimer.runNow();
    expect(h.turns.length, "到期后定时器自然重派(自愈,无需人工)").toBe(2);
    expect(brakeNotices().length, "过期后的失败 = 新 episode ⇒ 新通知").toBe(2);
    expect(providerBrakeIsBraked(Date.now()), "刹车重新亮起(streak 接着涨 ⇒ 2s 档)").toBe(true);

    expect(await until(() => !providerBrakeIsBraked(Date.now()))).toBe(true);
    await host!.dispatchTimer.runNow();
    expect(h.turns.length, "第二档冷却到期后照旧恢复").toBe(3);
  });
});

// ══════════════════════════════════════════════════════════════════
// ③ quota 走**长轴**(2026-11-14 双轴化)—— 不记 failed、预算不烧、
//   探测式恢复:冷却到期放行一次探测,通了清刹车全部续跑,没通退避加档。
//   (旧行为「quota 记 failed 烧预算」随用户裁决废除 —— 终态没人再唤起,
//   与「额度恢复以后这些任务还都能唤起来」直接矛盾。)
// ══════════════════════════════════════════════════════════════════

describe("③ quota 长轴:先停下来,恢复后自动续跑", () => {
  it("quota ⇒ 不记 failed、预算清零、播「额度已用完」、派发暂停", async () => {
    await startHost({ quotaBrakeBaseMs: 3_600_000 }); // 长轴第一档 1 小时:测试内不等到期
    h.errorText = QUOTA_TEXT;
    seedProject("w1");
    await host!.dispatchTimer.runNow();
    await until(() => brakeNotices().some((c) => c.includes("额度已用完")));
    expect(getWork(h.db!, "w1")?.status, "长轴路径不记 failed(终态没人唤起)").toBe("in_progress");
    expect(providerBrakeIsBraked(Date.now()), "quota 进长轴 ⇒ 在刹车").toBe(true);
    expect(workFailedEvents(), "长轴路径不许写 work_failed").toBe(0);
    expect(workLedger()?.attempts, "刹车 ⇒ 预算重置(attempts=0)").toBe(0);
    // 还在刹车窗内 ⇒ 下一轮 runNow 不派发
    const before = h.turns.length;
    await host!.dispatchTimer.runNow();
    expect(h.turns.length, "刹车期内不许派发").toBe(before);
  });

  it("探测式恢复:到期放行探测 ⇒ 仍失败退避加档 ⇒ 恢复后清刹车全部续跑", async () => {
    await startHost({ quotaBrakeBaseMs: 200 });
    h.errorText = QUOTA_TEXT;
    seedProject("w1");
    await host!.dispatchTimer.runNow(); // 第一枪:quota 失败 ⇒ 长轴 200ms
    expect(getWork(h.db!, "w1")?.status).toBe("in_progress");
    await sleep(250); // 过第一档冷却
    await host!.dispatchTimer.runNow(); // **探测**:仍 quota ⇒ streak+1,退避加档(800ms)
    expect(providerBrakeIsBraked(Date.now()), "探测仍失败 ⇒ 退避加档").toBe(true);
    const turnsAfterProbe = h.turns.length;
    await host!.dispatchTimer.runNow(); // 刹车窗内 ⇒ 不派发
    expect(h.turns.length, "加档期内不许派发").toBe(turnsAfterProbe);
    await sleep(850); // 过第二档
    h.errorText = ""; // **额度恢复了**
    await host!.dispatchTimer.runNow(); // 探测成功 ⇒ 清刹车
    expect(providerBrakeIsBraked(Date.now()), "成功 ⇒ 刹车解除").toBe(false);
    await host!.dispatchTimer.runNow(); // 续跑:正常回合照常派发
    expect(h.turns.length, "恢复后活儿自动续上").toBeGreaterThan(turnsAfterProbe);
    expect(getWork(h.db!, "w1")?.status, "恢复 ⇒ 不停在 failed").not.toBe("failed");
  });
});

// ══════════════════════════════════════════════════════════════════
// ④ 成功回合清零刹车(聊天路径不受刹车影响 —— 它是甲方在说话)
// ══════════════════════════════════════════════════════════════════

describe("④ 成功回合清零刹车", () => {
  const agentEnds = (): number => events.filter((e) => e.type === "agent_end").length;

  it("provider 恢复后(聊天成功一轮)⇒ 刹车立即解除,排空器恢复派发", async () => {
    await startHost();
    seedProject("w1");
    await host!.dispatchTimer.runNow();
    expect(providerBrakeIsBraked(Date.now())).toBe(true);

    // 聊天路径不受刹车闸 —— 甲方此刻正在说话。这一轮成功收尾。
    h.okMode = true;
    const before = agentEnds();
    ws!.send(JSON.stringify({ type: "send", projectId: "p1", content: "在吗" }));
    await until(() => agentEnds() > before);
    expect(
      providerBrakeIsBraked(Date.now()),
      "一次成功收尾的回合 ⇒ 刹车立即清零(不等 30s 冷却)",
    ).toBe(false);

    // 成功的假回合会把整条流水线跑通(wk→质检→整合…),所以这里断言
    // 「派发恢复且不止一次」,不锁精确值。
    const turnsBeforeTick = h.turns.length;
    await host!.dispatchTimer.runNow();
    expect(
      h.turns.length,
      "刹车清了 ⇒ 排空器立刻恢复派发",
    ).toBeGreaterThan(turnsBeforeTick);
  });

  it("负样本:聊天那轮**也失败**(限流还在)⇒ 刹车不清零,排空器仍然被闸住", async () => {
    await startHost();
    seedProject("w1");
    await host!.dispatchTimer.runNow();
    const before = agentEnds();
    ws!.send(JSON.stringify({ type: "send", projectId: "p1", content: "在吗" }));
    await until(() => agentEnds() > before);
    expect(providerBrakeIsBraked(Date.now()), "失败的回合不清刹车").toBe(true);
    // ⚠️ h.turns 含聊天那一轮(bm),所以快照要在 tick 之前取。
    const turnsBeforeTick = h.turns.length;
    await host!.dispatchTimer.runNow();
    expect(h.turns.length, "刹车还在 ⇒ 不派发").toBe(turnsBeforeTick);
  });
});

// ══════════════════════════════════════════════════════════════════
// ⑤ 可见性:暂停通知落内部会话,同一段刹车只播一条
// ══════════════════════════════════════════════════════════════════

describe("⑤ 刹车通知:⚠️ 供应商 · 同一段只播一条", () => {
  it("第一次生效播一条;冷却期内再派发被闸住也不重播", async () => {
    // 冷却 1s:保证两次 tick 都落在同一段刹车窗内(不靠运气)。
    await startHost({ brakeBaseMs: 1000, brakeMaxMs: 2000 });
    seedProject("w1");
    await host!.dispatchTimer.runNow();
    expect(brakeNotices().length).toBe(1);
    expect(brakeNotices()[0]).toContain("⚠️ 供应商");
    expect(brakeNotices()[0]).toContain("已暂停");

    await host!.dispatchTimer.runNow();
    expect(brakeNotices().length, "同一段刹车不许重播(每 10s 一条就是静默)").toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
// ⑥ 工作路径:provider 失败不记 failed、预算重置(变异点)
// ══════════════════════════════════════════════════════════════════

describe("⑥ 工作路径:provider 失败 ⇒ 不记 failed + 预算重置", () => {
  it("rate_limit + 无备用 ⇒ 工作项留在 in_progress、无 work_failed 事件、attempts 归零", async () => {
    await startHost();
    seedProject("w1");
    await host!.dispatchTimer.runNow();
    expect(getWork(h.db!, "w1")?.status, "刹车路径不许把工作项记成终态").toBe("in_progress");
    expect(workFailedEvents(), "不写 work_failed(它没死,只是外面在拒绝)").toBe(0);
    expect(workLedger()?.attempts, "尝试预算被重置(provider 故障不烧它)").toBe(0);
    expect(workLedger()?.notifiedAt, "重置连「已播报过」的灯一起清").toBeNull();
  });

  it("超时不算 provider 故障:即使打断瞬间带着 error 信封,也不刹车、照旧记 failed", async () => {
    // maxRounds 收到 2:超时回合每个要 200ms(墙钟 50ms + 开销),链路会
    // 反复叫醒(超时 ⇒ work_failed ⇒ 汇报待办),不收的话这一条要跑好几秒。
    await startHost({ turnWallClockMs: 50, maxRounds: 2 });
    h.abortWithError = true;
    seedProject("w1");
    await host!.dispatchTimer.runNow();
    await until(() => getWork(h.db!, "w1")?.status === "failed");
    expect(getWork(h.db!, "w1")?.status, "超时 ⇒ 照旧终态(不许装忙)").toBe("failed");
    expect(providerBrakeIsBraked(Date.now()), "超时不触发刹车(重跑卡死行为不是等能治的)").toBe(false);
    expect(brakeNotices().length, "超时不播刹车通知").toBe(0);
  });

  it("有副作用的回合(toolCalls>0)不进刹车 ⇒ 照旧记 failed(自动重跑不安全)", async () => {
    // ⚠️ 这条是「零工具调用」守卫的负样本:工具已跑过 ⇒ 可能有副作用 ⇒
    // 「留在 in_progress 等自动重派」的那个安全性不成立 ⇒ 必须走终态分支。
    // ⚠️ 断言只落在终态分支的可观察面:后续 BM 的汇报回合也是零工具调用的
    // 限流失败 ⇒ 它自己会合法地触发刹车 —— 那不是工作回合进错了分支。
    await startHost({ useTool: true });
    seedProject("w1");
    await host!.dispatchTimer.runNow();
    expect(
      await until(() => getWork(h.db!, "w1")?.status === "failed"),
      "副作用回合 ⇒ 终态(不许装忙);若错误地进了刹车分支,这里会超时",
    ).toBe(true);
    expect(workFailedEvents(), "终态分支 ⇒ work_failed 事件照写").toBeGreaterThan(0);
  });
});
