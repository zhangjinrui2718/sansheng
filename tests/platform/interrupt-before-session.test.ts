/**
 * 「停止」落在**建会话**那段时间里 —— 这一轮必须**不跑**
 *
 * ── 现场 ────────────────────────────────────────────────────────
 *
 * 用户按下「■ 中断」,而服务端此刻正在**建会话**(新会话要起 SDK 会话、加载模型,
 * 实测可达数秒)。中断登记若放在 `getOrCreateSession` **之后**,那一次「停止」就
 * **落到空气上**:服务端日志写着「没有正在跑的回合」,而屏幕上那盏灯还亮着 ——
 * 用户看到的就是「按了没反应」。
 *
 * ── 这一份钉的那条纪律 ──────────────────────────────────────────
 *
 * **中断意图必须登记在第一次 await 之前**,而且登记的是**意图**而不是一次
 * `abort()` 调用:会话还没建出来时无从 abort ⇒ 意图先记着,会话一建好就兑现,
 * 而**兑现的方式是「这一轮根本不要跑」**(不发模型请求、不花 token、不留副作用)。
 *
 * ⚠️ 与 `tests/platform/interrupt.test.ts` 的分工:那一份钉的是「回合**已经在跑**
 * 的时候按停止 ⇒ `abort()` 被调到」;这一份钉的是「按停止时回合**还没开始**」。
 * 两格都得有 —— 只钉后一格,「按了没反应」会从另一个门回来。
 *
 * 用到一处已成型的 DI seam(`ServeOptions.createSession`):把它做成慢的,
 * 「停止」就必然落在建会话那段时间里(不靠 sleep 撞运气)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type WebSocketServer } from "ws";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createPlatformHost, type PlatformHost } from "../../src/platform/host/serve.js";
import { attachHub } from "../../src/platform/transport/hub.js";
import { listProviders } from "../../src/platform/infra/providers.js";
import type { CreateSessionFn } from "../../src/platform/runtime/agentRuntime/pi/session.js";

let dataDir: string;
let host: PlatformHost | undefined;
let server: Server | undefined;
let wss: WebSocketServer | undefined;
let ws: WebSocket | undefined;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  dataDir = mkdtempSync(join(tmpdir(), "ss-interrupt2-"));
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
          id: "prov_test",
          label: "test",
          provider: p.id,
          modelId: model.id,
          apiKey: "test-key-not-used",
          thinkingLevel: "off",
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
  host?.close();
  host = undefined;
  wss?.close();
  wss = undefined;
  await new Promise<void>((r) => (server !== undefined ? server.close(() => r()) : r()));
  server = undefined;
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 假会话:记录 prompt / abort 被调了几次。 */
function makeFakeSession(): {
  session: AgentSession;
  state: { promptCalls: number; abortCalls: number };
} {
  const listeners = new Set<(ev: AgentSessionEvent) => void>();
  const state = { promptCalls: 0, abortCalls: 0 };
  const session = {
    subscribe(fn: (ev: AgentSessionEvent) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async prompt() {
      state.promptCalls += 1;
    },
    async abort() {
      state.abortCalls += 1;
      for (const l of [...listeners]) l({ type: "agent_settled" } as AgentSessionEvent);
    },
    dispose() {
      /* 常驻会话:中断不是结束会话 */
    },
  } as unknown as AgentSession;
  return { session, state };
}

/**
 * 起宿主 + 真 WS 服务。`sessionDelayMs` 让**建会话**变慢 ——
 * 「停止」于是必然落在建会话那段时间里。
 */
async function startHost(options: { sessionDelayMs: number }): Promise<{
  fake: ReturnType<typeof makeFakeSession>;
  send: (cmd: unknown) => void;
  events: () => ReadonlyArray<{ type: string }>;
}> {
  const fake = makeFakeSession();
  const seen: Array<{ type: string }> = [];
  const createSession: CreateSessionFn = async () => {
    if (options.sessionDelayMs > 0) {
      await new Promise((r) => setTimeout(r, options.sessionDelayMs));
    }
    return { session: fake.session };
  };
  host = createPlatformHost({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    version: "test",
    createSession,
  });
  server = createServer();
  wss = attachHub(server, host.hub);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("拿不到监听端口");

  ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws!.once("open", () => resolve());
    ws!.once("error", reject);
  });
  ws!.on("message", (data: unknown) => {
    try {
      seen.push(JSON.parse(String(data)) as { type: string });
    } catch {
      /* 非 JSON 帧不是这一份要断言的东西 */
    }
  });
  return {
    fake,
    send: (cmd: unknown) => ws!.send(JSON.stringify(cmd)),
    events: () => seen,
  };
}

/** 轮询式等待(不用固定 sleep —— 那会让测试在慢机器上假红)。 */
async function waitFor(label: string, pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`等待超时:${label}`);
}

describe("中断 · 落在建会话那段时间里的「停止」", () => {
  it("这一轮**不跑**(不发模型请求、不花 token),而 `agent_end` 照发(前端要把灯收回)", async () => {
    const { fake, send, events } = await startHost({ sessionDelayMs: 600 });

    send({ type: "send", projectId: null, content: "你好" });
    // 会话还在建(服务端已经占上忙闩)⇒ 此刻按「停止」。
    await waitFor("回合已经起来(会话在建)", () => host!.hub.isBusy(null) === true);
    send({ type: "interrupt", projectId: null });

    // 回合收尾:忙闩放开。
    await waitFor("回合收尾(busy=false)", () => host!.hub.isBusy(null) === false);

    // ⚠️ **这一轮根本没有跑**:不发模型请求、不花 token。
    expect(fake.state.promptCalls).toBe(0);
    // 当时还没有会话 ⇒ 无从 `abort()`(意图是「不跑」,不是「跑一半再扔」)。
    expect(fake.state.abortCalls).toBe(0);

    // 前端要靠 `agent_end` 把「推演中」那盏灯收回 —— 不发它,界面会一直亮着。
    await waitFor("agent_end 事件到了前端", () => events().some((e) => e.type === "agent_end"));
  });

  it("⚠️ **负样本**:没有按下停止时,那一轮**照跑**(别把「建会话慢」当成「不跑」)", async () => {
    const { fake, send } = await startHost({ sessionDelayMs: 200 });
    send({ type: "send", projectId: null, content: "你好" });
    await waitFor("回合真的跑起来(prompt 被调用)", () => fake.state.promptCalls === 1);
  });
});
