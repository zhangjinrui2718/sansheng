/**
 * 忙时排队(036,2026-11-22)· 回归
 *
 * ── 它守着的缺陷 ────────────────────────────────────────────────
 *
 * 此前甲方在业务经理正跑回合时再发一句,`transport/hub.ts` 的 `send` 直接回
 * `code:"busy"` —— ① 那句话**哪儿都没落**(用户以为说过了);② 服务端指的
 * 路(「先中断」)在界面上可能根本没有入口(批次 32 的现场)。
 *
 * 现在:消息照常落库 + 记排队账 + 广播 `message_queued`;排空器的
 * `answer_client_message` 待办在收件人空出来时把**同一条线上**排队的所有话
 * 一并带上(multica 的 "joined this run" 语义)。
 *
 * 端到端走**真 WS + 真宿主 + 注入的假 SDK 会话**(与 `interrupt.test.ts` 同一
 * 套 DI seam):忙闩占着 ⇒ 发第二句 ⇒ 不拒收、账落了、事件发了 ⇒ 释放闩 ⇒
 * 手动排空 ⇒ 假会话收到的 prompt 里**带着那句话**、账被消费。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type WebSocketServer } from "ws";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createPlatformHost, type PlatformHost } from "../../src/platform/host/serve.js";
import { attachHub } from "../../src/platform/transport/hub.js";
import { listProviders } from "../../src/platform/runtime/agentRuntime/pi/providers.js";
import type { CreateSessionFn } from "../../src/platform/runtime/agentRuntime/pi/session.js";
import { pendingQueuedClientMessages } from "../../src/platform/storage/repo/queuedClientMessages.js";
import { consumeQueuedClientMessages, insertQueuedClientMessage } from "../../src/platform/storage/repo/queuedClientMessages.js";
import { openPlatformMemoryDb, openPlatformDb } from "../../src/platform/storage/index.js";
import { insertSession, appendSessionMessage } from "../../src/platform/storage/repo/sessions.js";
import type Database from "better-sqlite3";

// ── 单元部分:仓储的幂等 ─────────────────────────────────────────

describe("queued_client_messages 仓储", () => {
  let db: ReturnType<typeof openPlatformMemoryDb>;
  beforeEach(() => {
    db = openPlatformMemoryDb();
    db.prepare(
      `INSERT INTO projects (id, name, client, goal, status, created_at)
       VALUES ('p1', 't', '甲', 'g', 'active', 1)`,
    ).run();
  });
  afterEach(() => db.close());

  it("pending 只看未消费;消费幂等(第二次消费不重复计)", () => {
    // `message_id` 有外键 —— 账引用的那条消息必须真实存在(正文只存那一处)。
    insertSession(db, { id: "s1", projectId: "p1", createdAt: 1, channel: "internal" });
    appendSessionMessage(db, {
      id: "m1", sessionId: "s1", agentId: null, kind: "user",
      content: "在忙吗", createdAt: 10, originSource: "turn", triggerKind: "user",
    });
    appendSessionMessage(db, {
      id: "m2", sessionId: "s1", agentId: null, kind: "user",
      content: "还在忙吗", createdAt: 20, originSource: "turn", triggerKind: "user",
    });
    insertQueuedClientMessage(db, {
      id: "qm1", projectId: "p1", sessionId: "s1", messageId: "m1",
      createdAt: 10, consumedAt: null,
    });
    insertQueuedClientMessage(db, {
      id: "qm2", projectId: "p1", sessionId: "s1", messageId: "m2",
      createdAt: 20, consumedAt: null,
    });
    expect(pendingQueuedClientMessages(db, "p1").map((r) => r.id)).toEqual(["qm1", "qm2"]);

    expect(consumeQueuedClientMessages(db, ["qm1", "qm2"], 30)).toBe(2);
    expect(pendingQueuedClientMessages(db, "p1")).toHaveLength(0);
    // at-least-once 的重放安全:已消费的再消费是 no-op。
    expect(consumeQueuedClientMessages(db, ["qm1"], 40)).toBe(0);
  });
});

// ── 端到端部分:真 WS + 真宿主 + 可门控的假会话 ───────────────────

let dataDir: string;
let readDb: Database.Database | undefined;
let host: PlatformHost | undefined;
let server: Server | undefined;
let wss: WebSocketServer | undefined;
let ws: WebSocket | undefined;

/** 可门控的假会话:prompt 挂起直到测试放行(模拟「正在跑的回合」)。 */
function makeGatedSession(): {
  session: AgentSession;
  prompts: string[];
  release: () => void;
} {
  const listeners = new Set<(ev: AgentSessionEvent) => void>();
  const prompts: string[] = [];
  let releaseTurn: (() => void) | null = null;
  const settle = () => {
    for (const l of [...listeners]) l({ type: "agent_settled" } as AgentSessionEvent);
  };
  const session = {
    subscribe(fn: (ev: AgentSessionEvent) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async prompt(text: string) {
      prompts.push(text);
      await new Promise<void>((r) => {
        releaseTurn = r;
      });
      settle();
      return { messages: [] };
    },
    async abort() {
      settle();
    },
    dispose() {},
  } as unknown as AgentSession;
  return {
    session,
    prompts,
    release: () => {
      const r = releaseTurn;
      releaseTurn = null;
      r?.();
    },
  };
}

beforeEach(() => {
  if (!process.env.SS_VERBOSE_HOST_LOGS) {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  }
  dataDir = mkdtempSync(join(tmpdir(), "ss-busyqueue-"));
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
      cwd: dataDir,
      personaName: "测试",
    }),
    { mode: 0o600 },
  );
});

afterEach(async () => {
  ws?.close();
  ws = undefined;
  readDb?.close();
  readDb = undefined;
  host?.close();
  host = undefined;
  wss?.close();
  wss = undefined;
  await new Promise<void>((r) => (server !== undefined ? server.close(() => r()) : r()));
  server = undefined;
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface Harness {
  /** 第二条连接到宿主那个库文件(只读用;WAL 下多连接安全)。 */
  db: Database.Database;
  sessions: ReturnType<typeof makeGatedSession>[];
  send: (cmd: unknown) => void;
  events: unknown[];
  drainNow: () => void;
  baseUrl: string;
  /**
   * 放行**所有**挂着的回合。宿主启动时会做一次初始排空(项目经理的拆解
   * 回合也会被叫醒)—— 它同样被门控挂起,不清掉会占住它那个 `(项目, 角色)`
   * 的闩,把后面的排空堵在 FIFO 里。
   */
  releaseAll: () => void;
}

async function startHost(): Promise<Harness> {
  const sessions: ReturnType<typeof makeGatedSession>[] = [];
  const events: unknown[] = [];
  const createSession: CreateSessionFn = async () => {
    const s = makeGatedSession();
    sessions.push(s);
    return { session: s.session };
  };
  host = createPlatformHost({
    dataDir, host: "127.0.0.1", port: 0, version: "test",
    createSession,
    // 定时器关掉:测试**手动**排空,不与 fixed-delay 竞态。
    dispatchIntervalMs: 0,
  });
  const started = serve({ fetch: host.app.fetch, port: 0, hostname: "127.0.0.1" });
  server = started as unknown as Server;
  await new Promise<void>((r) => started.once("listening", () => r()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("拿不到监听端口");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  wss = attachHub(server, host.hub);
  ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws!.once("open", () => resolve());
    ws!.once("error", reject);
  });
  ws!.on("message", (raw) => {
    try {
      events.push(JSON.parse(String(raw)));
    } catch {
      /* 非 JSON 的帧不是这条测试关心的事 */
    }
  });
  const drainNow = () => {
    void (host as unknown as {
      dispatchTimer: { runNow: (why: string) => Promise<unknown> };
    }).dispatchTimer.runNow("test");
  };
  readDb = openPlatformDb(join(dataDir, "sansheng.db"));
  return {
    db: readDb,
    sessions,
    send: (cmd) => ws!.send(JSON.stringify(cmd)),
    events,
    drainNow,
    baseUrl,
    releaseAll: () => {
      // 多放几次:释放一轮后排空器可能接着叫醒下一个回合(拆解后执行…),
      // 测试只关心「排队被带上」那条链,把沿途叫醒的回合都放行掉。
      for (let i = 0; i < 3; i++) {
        setTimeout(() => {
          for (const s of sessions) s.release();
        }, i * 30);
      }
    },
  };
}

async function waitFor(label: string, pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`等待超时:${label}`);
}

describe("忙时排队 · 端到端(036)", () => {
  it("忙时发第二句:不拒收、落库排队、广播 message_queued;释放后下一轮带上并消费", async () => {
    const h = await startHost();
    const res = await fetch(`${h.baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "排队测试", goal: "g" }),
    });
    const body = (await res.json()) as { project: { id: string } };
    const pid = body.project.id;

    // ① 第一句:占住业务经理的闩(prompt 挂起中)。
    // ⚠️ 按**内容**找会话:宿主启动的初始排空会把项目经理也叫醒(它的 prompt
    // 不是这句话),按「第一个有 prompt 的会话」找会拿错人。
    h.send({ type: "send", projectId: pid, content: "第一句,先忙你的" });
    await waitFor("业务经理接到第一句", () =>
      h.sessions.some((s) => s.prompts.some((p) => p.includes("第一句,先忙你的"))),
    );

    // ② 忙时发第二句 —— 旧行为是 code:"busy";现在必须**不拒收**。
    const errorsBefore = h.events.filter(
      (e) => (e as { type?: string }).type === "error",
    ).length;
    h.send({ type: "send", projectId: pid, content: "趁你在忙:别忘了问 CI/CD" });
    await waitFor("message_queued 事件到达", () =>
      h.events.some((e) => (e as { type?: string }).type === "message_queued"),
    );
    // 没有新的 busy 错误(排队不是错误)。
    expect(
      h.events.filter((e) => (e as { type?: string }).type === "error").length,
    ).toBe(errorsBefore);

    // 账在库里:一条 pending。
    const qm = h.db;
    await waitFor("排队账落库", () => pendingQueuedClientMessages(qm, pid).length === 1);
    expect(pendingQueuedClientMessages(qm, pid)[0]!.sessionId).toBeTruthy();

    // ③ 释放第一回合(连同初始排空挂着的那些)⇒ 排空 ⇒ 下一轮 prompt 带上那句话。
    h.releaseAll();
    await waitFor("第一回合收尾", () =>
      h.events.some((e) => (e as { type?: string }).type === "agent_end"),
    );
    h.drainNow();
    await waitFor("排队的下一轮 prompt 到达", () =>
      h.sessions.some((s) => s.prompts.some((p) => p.includes("趁你在忙"))),
    );
    // 甲方原话必须**原样**进任务正文(renderTask 的例外:不靠模型自己去找)。
    const answerSession = h.sessions.find((s) =>
      s.prompts.some((p) => p.includes("趁你在忙")),
    )!;
    expect(answerSession.prompts.some((p) => p.includes("别忘了问 CI/CD"))).toBe(true);
    answerSession.release();
    await waitFor("排队账被消费(回合成功结束后)", () =>
      pendingQueuedClientMessages(qm, pid).length === 0,
    );
  }, 20_000);

  it("排队在交付线上 ⇒ 回应回合跑在那条线(不是主对话)", async () => {
    const h = await startHost();
    const res = await fetch(`${h.baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "跨线排队", goal: "g" }),
    });
    const pid = ((await res.json()) as { project: { id: string } }).project.id;

    // 建第二条线(kind='thread')。
    const sres = await fetch(`${h.baseUrl}/api/projects/${pid}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "追问线" }),
    });
    const sbody = (await sres.json()) as { sessionId?: string };
    const threadId = sbody.sessionId;
    expect(threadId, "建线端点要交回 sessionId").toBeTruthy();

    // 占闩:主对话上发第一句(prompt 挂起)。按内容找会话(初始排空也叫醒过别人)。
    h.send({ type: "send", projectId: pid, content: "主对话的第一句" });
    await waitFor("业务经理接到主对话的第一句", () =>
      h.sessions.some((s) => s.prompts.some((p) => p.includes("主对话的第一句"))),
    );
    const mainSession = h.sessions.find((s) =>
      s.prompts.some((p) => p.includes("主对话的第一句")),
    )!;

    // 忙时往**另一条线**发第二句 ⇒ 排队必须记在那条线上。
    h.send({ type: "send", projectId: pid, content: "这条线上的追问", sessionId: threadId });
    await waitFor("排队账落在这条线上", () => {
      const qm = h.db;
      const pending = pendingQueuedClientMessages(qm, pid);
      return pending.length === 1 && pending[0]!.sessionId === threadId;
    });

    // 释放 ⇒ 排空 ⇒ 回应必须开在**那条线自己的常驻会话**上
    //(会话池键 = (项目, 会话, 角色) ⇒ 另一个假会话)。
    h.releaseAll();
    await waitFor("第一回合收尾", () =>
      h.events.some((e) => (e as { type?: string }).type === "agent_end"),
    );
    h.drainNow();
    await waitFor("那条线上的回应回合被叫醒", () =>
      h.sessions.some(
        (s) => s !== mainSession && s.prompts.some((p) => p.includes("这条线上的追问")),
      ),
    );
    // 主对话那条会话**没有**收到这句(说对地方比说了更重要)。
    expect(mainSession.prompts.some((p) => p.includes("这条线上的追问"))).toBe(false);
  }, 20_000);
});
