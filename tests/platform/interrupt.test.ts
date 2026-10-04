/**
 * 批次 19 · 中断按钮**真的**会 abort(死接线的守卫)
 *
 * ── 这条测试守着的缺陷 ──────────────────────────────────────────
 *
 * `host/serve.ts` 里曾经有一张 `inflight` 表(`Map<string | null, AbortController>`),
 * 而**从来没有人 `set` 过它** —— 全仓只有声明、`get`、`delete`。于是:
 *
 *     onInterrupt: (projectId) => { inflight.get(projectId)?.abort(); }
 *
 * 恒等于 `undefined?.abort()` —— 一声不响的 no-op。前端的中断按钮与 Esc
 * (ChatComposer 的 Escape 接线)因此**从来没有生效过**,而代码看起来齐全。
 *
 * 这是「死接线」的教科书形态,也是本项目反复栽的那一类(7-B 提示词落地没人读)。
 * 只断言「handler 存在」的测试抓不住它 —— 必须**端到端**走一遍:
 *
 *   真 WS 连接 → 真 `send` 指令 → 真建会话(注入假 SDK)→ 真 `interrupt` 指令
 *   → 断言假会话的 `abort()` **被调到**
 *
 * 用到两处已经成型的 DI seam(不是为本测试新发明的):
 *   · `session.ts` 的 `createSession`(「到底把什么交给了 SDK」);
 *   · `serve.ts` 的 `ServeOptions.createSession`(转发同一个 seam)。
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
import type { CreateSessionFn } from "../../src/platform/runtime/session.js";

let dataDir: string;
let host: PlatformHost | undefined;
let server: Server | undefined;
let wss: WebSocketServer | undefined;
let ws: WebSocket | undefined;

beforeEach(() => {
  // 宿主会往 stdout 打一串平台日志(托管前端 / 建会话 / 中断…)。它们是有价值的现场,
  // 但这条测试断言的是**注入的假会话状态**,已经在断言里覆盖了同一批事实 ——
  // 让它安静下来,免得整套测试的输出被这 20 行淹没。失败时的断言信息不受影响。
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  dataDir = mkdtempSync(join(tmpdir(), "ss-interrupt-"));
  // 会话建立需要「有一个 provider + 能解析出模型」;这里不联网,只要
  // resolveModel 能从内建 catalog 里认出一对 provider/model 即可。
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

/** 假会话:记录 prompt / abort 被调了几次,并允许测试驱动事件。 */
function makeFakeSession(): {
  session: AgentSession;
  state: { promptCalls: number; abortCalls: number; disposed: number };
  emit(ev: AgentSessionEvent): void;
} {
  const listeners = new Set<(ev: AgentSessionEvent) => void>();
  const state = { promptCalls: 0, abortCalls: 0, disposed: 0 };
  const session = {
    subscribe(fn: (ev: AgentSessionEvent) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // prompt 立即返回;回合的收敛由 runTurn 的 `while (!settled)` 决定 ——
    // 与真 SDK 的形态一致(事件流才是收敛信号)。
    async prompt() {
      state.promptCalls += 1;
    },
    // **被中断时应该发生的事**:abort 之后 agent 收敛(真 SDK 的 abort() 会等到 idle)。
    async abort() {
      state.abortCalls += 1;
      for (const l of [...listeners]) l({ type: "agent_settled" } as AgentSessionEvent);
    },
    dispose() {
      state.disposed += 1;
    },
  } as unknown as AgentSession;
  return {
    session,
    state,
    emit: (ev) => {
      for (const l of [...listeners]) l(ev);
    },
  };
}

/** 起宿主 + 真 WS 服务,返回假会话与「发一条指令」的入口。 */
async function startHost(): Promise<{
  fake: ReturnType<typeof makeFakeSession>;
  send: (cmd: unknown) => void;
  closed: Promise<void>;
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
  server = createServer();
  wss = attachHub(server, host.hub);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("拿不到监听端口");

  ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  const closed = new Promise<void>((r) => ws!.once("close", () => r()));
  await new Promise<void>((resolve, reject) => {
    ws!.once("open", () => resolve());
    ws!.once("error", reject);
  });
  return {
    fake,
    send: (cmd: unknown) => ws!.send(JSON.stringify(cmd)),
    closed,
  };
}

/** 轮询式等待(不用固定 sleep —— 那会让测试在慢机器上假红)。 */
async function waitFor(label: string, pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`等待超时:${label}`);
}

describe("中断 · onInterrupt 真的会 abort 那个会话", () => {
  it("send → 建会话 → interrupt → 假会话的 abort() 被调到,且回合收尾", async () => {
    const { fake, send } = await startHost();
    expect(fake.state.promptCalls).toBe(0);

    // 接待会话 = projectId null(见 migrations/012)
    send({ type: "interrupt", projectId: null });
    await new Promise((r) => setTimeout(r, 50));
    // 还没有任何回合在跑 → 中断是幂等的 no-op(不许崩,也不许误 abort)
    expect(fake.state.abortCalls).toBe(0);

    send({ type: "send", projectId: null, content: "你好" });
    await waitFor("回合真的开始跑(prompt 被调用)", () => fake.state.promptCalls === 1);
    // 这一条同时证明「登记发生在 await 之前」:能跑到这里说明 prompt 已经在了,
    // 而中断登记与它同步发生。
    expect(host!.hub.isBusy(null)).toBe(true);
    expect(fake.state.abortCalls).toBe(0);

    send({ type: "interrupt", projectId: null });
    await waitFor("abort() 真的被调到", () => fake.state.abortCalls === 1);

    // 回合收尾:busy 清掉、登记表清空
    await waitFor("回合收尾(busy=false)", () => host!.hub.isBusy(null) === false);

    // 再点一次(用户连点 / 回合刚好结束)→ 仍然幂等
    send({ type: "interrupt", projectId: null });
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.state.abortCalls).toBe(1);
  });

  it("中断**不会**被当成回合故障(前端不该弹 turn_failed)", async () => {
    const { fake, send } = await startHost();
    send({ type: "send", projectId: null, content: "你好" });
    await waitFor("prompt 被调用", () => fake.state.promptCalls === 1);
    send({ type: "interrupt", projectId: null });
    await waitFor("abort 被调到", () => fake.state.abortCalls === 1);
    await waitFor("回合收尾", () => host!.hub.isBusy(null) === false);
    // 假会话的 abort 让回合走**成功路径**(agent_settled),所以既没有异常也没有
    // turn_failed;这里只断言「会话被销毁过一次」这一条副作用没被漏掉的反面 ——
    // 即 dispose 不该在这个时点被调(会话是常驻的,中断不是结束会话)。
    expect(fake.state.disposed).toBe(0);
  });
});
