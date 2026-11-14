/**
 * 「停止对话」的**服务端那一半** —— 运行态快照与中断必须**对得上**
 *
 * ── 为什么要有这一份(前端那一半修的是「看不见入口」,这里是「入口背后的事实」)──
 *
 * 2026-11-10 用户报:「和业务经理聊天的时候 没有停止对话的能力」。
 *
 * 前端那一侧的修法是:中断入口的可见性改读**服务端那份运行态**
 * (`GET /api/intake/live` / `GET /live`)。⇒ **这条链子的服务端那一端必须真的成立**:
 *
 *   ① 甲方那条消息真的让业务经理跑起来时,`/live` 必须**报出**这一轮
 *      (带 `trigger: {kind:"user"}` —— 前端靠它分「甲方通道」与「内部」);
 *   ② 中断之后,这一轮必须**从快照里消失**(闩释放了)——
 *      否则界面会一直亮着「■ 中断」,而按下去什么也不会发生
 *      (**自信的假话**:看起来能停,其实停不了)。
 *
 * ⚠️ 这两条**不是**读实现自己的中间变量算出来的:这里走**真 HTTP 端点**
 * (`GET /api/intake/live`)与**真 WS 指令**(`interrupt`),中间只假了 SDK 会话
 * (假会话不自己收敛 —— 它只在 `abort()` 时收敛,于是那一轮会一直「在跑」,
 * 正好是本文件要观察的现场)。
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
import type { IntakeLiveView } from "@shared/types/platform.js";

let dataDir: string;
let host: PlatformHost | undefined;
let server: Server | undefined;
let wss: WebSocketServer | undefined;
let ws: WebSocket | undefined;
let baseUrl = "";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  dataDir = mkdtempSync(join(tmpdir(), "ss-interrupt-live-"));
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

/**
 * 假会话:**它自己不会收敛** —— 只有 `abort()` 才让它收敛。
 *
 * ⇒ 那一轮会一直「在跑」,正好是本文件要观察的现场
 * (真机上的长回合就是这个形状:业务经理在跑一个很长的工具链)。
 */
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
      // ⚠️ **故意不发 `agent_settled`** —— 回合停在「在跑」,直到被中断。
    },
    async abort() {
      state.abortCalls += 1;
      for (const l of [...listeners]) l({ type: "agent_settled" } as AgentSessionEvent);
    },
    dispose() {
      /* 常驻会话,中断不等于销毁 */
    },
  } as unknown as AgentSession;
  return { session, state };
}

/** 起宿主(HTTP + WS),返回假会话与几个入口。 */
async function startHost(): Promise<{
  fake: ReturnType<typeof makeFakeSession>;
  send: (cmd: unknown) => void;
  live: () => Promise<IntakeLiveView>;
}> {
  const fake = makeFakeSession();
  const createSession: CreateSessionFn = async () => ({ session: fake.session });
  host = createPlatformHost({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    version: "test",
    createSession,
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
  return {
    fake,
    send: (cmd: unknown) => ws!.send(JSON.stringify(cmd)),
    live: async () => {
      const res = await fetch(`${baseUrl}/api/intake/live`);
      const body = (await res.json()) as { live: IntakeLiveView };
      return body.live;
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

describe("中断 · 运行态快照与它必须对得上", () => {
  it("甲方那条消息真的跑起来 ⇒ `/live` 报出这一轮(带 `trigger: {kind:\"user\"}`)", async () => {
    const { fake, send, live } = await startHost();

    // 起点:一个人都没在跑(快照是**读到了**的 0,不是「读不到」)
    const before = await live();
    expect(before.runtime).toBe("host");
    expect(before.turns).toEqual([]);

    send({ type: "send", projectId: null, content: "你好" });
    await waitFor("回合真的开始跑", () => fake.state.promptCalls === 1);

    const during = await live();
    expect(during.runtime).toBe("host");
    expect(during.runningTurns).toBe(1);
    expect(during.turns).toHaveLength(1);
    // ⚠️ `trigger` 是前端分「甲方通道 / 内部」的那一位 —— 缺了它,
    // 前端会把业务经理这一轮读成「内部在跑」,中断入口就不出现。
    expect(during.turns[0]!.trigger).toEqual({ kind: "user" });
    expect(during.turns[0]!.agentId).toBe("bm");
  });

  it("中断之后 ⇒ 这一轮**从快照里消失**(否则界面一直亮着一个按了没用的按钮)", async () => {
    const { fake, send, live } = await startHost();
    send({ type: "send", projectId: null, content: "你好" });
    await waitFor("回合真的开始跑", () => fake.state.promptCalls === 1);
    expect((await live()).turns).toHaveLength(1);

    send({ type: "interrupt", projectId: null });
    await waitFor("abort() 真的被调到", () => fake.state.abortCalls === 1);

    // 闩释放之后,快照必须回到「一个人都没在跑」
    await waitFor("快照里那一轮消失", async () => true);
    for (let i = 0; i < 200; i++) {
      const now = await live();
      if (now.turns.length === 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("中断之后,快照里那一轮始终没消失");
  });
});
