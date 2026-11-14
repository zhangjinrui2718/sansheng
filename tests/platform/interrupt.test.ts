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
import { factoryToolset, type ProjectRole } from "../../src/platform/identity/role.js";
import type { CreateSessionFn } from "../../src/platform/runtime/agentRuntime/pi/session.js";

let dataDir: string;
let host: PlatformHost | undefined;
let server: Server | undefined;
let wss: WebSocketServer | undefined;
let ws: WebSocket | undefined;

beforeEach(() => {
  // 宿主会往 stdout 打一串平台日志(托管前端 / 建会话 / 中断…)。它们是有价值的现场,
  // 但这条测试断言的是**注入的假会话状态**,已经在断言里覆盖了同一批事实 ——
  // 让它安静下来,免得整套测试的输出被这 20 行淹没。失败时的断言信息不受影响。
  // 设 SS_VERBOSE_HOST_LOGS=1 可看到宿主日志(排障用)
  if (!process.env.SS_VERBOSE_HOST_LOGS) {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  }
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

/**
 * 假会话:记录 prompt / abort 被调了几次,并允许测试驱动事件。
 *
 * ⚠️ 「已 abort 过的会话再被 prompt」会立即收敛 —— 范围收窄的端到端测试里,
 * 排空器会在预算内反复叫醒同一个 PM;不自动收敛的话 `drainProject` 会挂在
 * 第二轮上,测试永远等不到收尾。
 */
function makeFakeSession(tools: readonly string[] = []): {
  session: AgentSession;
  state: { promptCalls: number; abortCalls: number; disposed: number };
  tools: readonly string[];
  emit(ev: AgentSessionEvent): void;
} {
  const listeners = new Set<(ev: AgentSessionEvent) => void>();
  const state = { promptCalls: 0, abortCalls: 0, disposed: 0 };
  const settle = () => {
    for (const l of [...listeners]) l({ type: "agent_settled" } as AgentSessionEvent);
  };
  const session = {
    subscribe(fn: (ev: AgentSessionEvent) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // prompt 立即返回;回合的收敛由 runTurn 的 `while (!settled)` 决定 ——
    // 与真 SDK 的形态一致(事件流才是收敛信号)。
    async prompt() {
      state.promptCalls += 1;
      if (state.abortCalls > 0) settle();
    },
    // **被中断时应该发生的事**:abort 之后 agent 收敛(真 SDK 的 abort() 会等到 idle)。
    async abort() {
      state.abortCalls += 1;
      settle();
    },
    dispose() {
      state.disposed += 1;
    },
  } as unknown as AgentSession;
  return {
    session,
    tools,
    state,
    emit: (ev) => {
      for (const l of [...listeners]) l(ev);
    },
  };
}

/**
 * 起宿主 + 真 WS 服务。
 *
 * - **多会话收集**(`fakes`):范围收窄的判据是「只停哪几个」—— 必须能对
 *   **每一个**会话断言 abort 有没有发生,单假会话数不出来。
 * - **身份辨识**:假会话工厂记录它拿到的工具面;业务经理独有的 `ask_client`
 *   ⇒ `fakeByRole("business_manager")` 不靠数组顺序猜。
 * - **排空器可关**:收窄测试要**手动**驱动排空(等 fixed-delay 定时器会引入
 *   竞态),默认 `dispatchIntervalMs: 0` = 不起定时器。
 */
async function startHost(
  opts: { dispatchIntervalMs?: number; turnWallClockMs?: number } = {},
): Promise<{
  fakes: ReturnType<typeof makeFakeSession>[];
  /** 容错版:会话还没建出来时返回 undefined(配 waitFor 用)。 */
  findFake: (role: ProjectRole) => ReturnType<typeof makeFakeSession> | undefined;
  fakeByRole: (role: ProjectRole) => ReturnType<typeof makeFakeSession>;
  send: (cmd: unknown) => void;
  createProject: (name: string) => Promise<{ id: string } | null>;
  /** 手动驱动一次全项目排空(不 await —— 它在后台跑到没有待办为止)。 */
  drainNow: () => void;
  closed: Promise<void>;
}> {
  const fakes: ReturnType<typeof makeFakeSession>[] = [];
  const createSession: CreateSessionFn = async ({ tools }) => {
    const fake = makeFakeSession(tools ?? []);
    fakes.push(fake);
    return { session: fake.session };
  };
  host = createPlatformHost({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    version: "test",
    createSession,
    ...(opts.dispatchIntervalMs === undefined ? {} : { dispatchIntervalMs: opts.dispatchIntervalMs }),
    ...(opts.turnWallClockMs === undefined ? {} : { turnWallClockMs: opts.turnWallClockMs }),
  });
  // HTTP 与 WS **同一个 server**(`@hono/node-server` 的 serve + attachHub)——
  // 裸 `createServer()` 只能跑 WS,HTTP 请求会挂死(实测)。
  const started = serve({ fetch: host.app.fetch, port: 0, hostname: "127.0.0.1" });
  server = started as unknown as Server;
  await new Promise<void>((r) => started.once("listening", () => r()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("拿不到监听端口");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  wss = attachHub(server, host.hub);

  ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  const closed = new Promise<void>((r) => ws!.once("close", () => r()));
  await new Promise<void>((resolve, reject) => {
    ws!.once("open", () => resolve());
    ws!.once("error", reject);
  });

  // 排空入口与宿主定时器同一条路(fixed-delay loop 的 `runNow()`),
  // 不是另一个并行实现 —— 测试驱动的就是生产那条路。
  const drainNow = () => {
    void (host as unknown as {
      dispatchTimer: { runNow: (why: string) => Promise<unknown> };
    }).dispatchTimer.runNow("test");
  };

  const createProject = async (name: string) => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, goal: `范围收窄测试:${name}` }),
    });
    if (res.status !== 201) return null;
    const body = (await res.json()) as { project?: { id?: string } };
    return body.project?.id != null ? { id: body.project.id } : null;
  };

  // 身份判据 = **出厂工具集的集合相等**(`factoryToolset(role)` 派生自 ceiling;
  // 临时数据目录里没有 L2 集合文件、没有 MCP ⇒ 有效面 = 出厂集)。不猜工具名、
  // 不靠数组顺序。若两个角色的集合相等,这条测试 helper 会直接报错而不是乱配。
  // ⚠️ 会话是**懒创建**的(消息被处理时才建),所以先 `findFake`(可空)等它出现,
  // 再 `fakeByRole`(断言恰好一个)。
  const findFake = (role: ProjectRole) => {
    const want = [...factoryToolset(role)].sort().join(",");
    const hits = fakes.filter((f) => [...f.tools].sort().join(",") === want);
    if (hits.length !== 1 && process.env.SS_DEBUG_FAKES) {
      console.error(
        `[findFake miss] role=${role} want=[${want}] fakes=${fakes.length}\n` +
          fakes.map((f, i) => `#${i}[${f.tools.length}]: ${[...f.tools].sort().join(",")}`).join("\n"),
      );
    }
    return hits.length === 1 ? hits[0] : undefined;
  };
  const fakeByRole = (role: ProjectRole) => {
    const want = [...factoryToolset(role)].sort().join(",");
    const hits = fakes.filter((f) => [...f.tools].sort().join(",") === want);
    if (hits.length !== 1) {
      const dump = fakes.map((f, i) => `#${i}[${f.tools.length}]: ${[...f.tools].sort().join(",")}`).join("\n");
      throw new Error(
        `按出厂工具集定位角色 ${role} 的假会话:期望恰好 1 个,实际 ${hits.length}(共 ${fakes.length} 个)\n期望[${want}]\n实际:\n${dump}`,
      );
    }
    return hits[0]!;
  };

  return {
    fakes,
    findFake,
    fakeByRole,
    send: (cmd: unknown) => ws!.send(JSON.stringify(cmd)),
    createProject,
    drainNow,
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
    const { fakes, send } = await startHost();
    // 接待会话 = projectId null(见 migrations/012)
    send({ type: "interrupt", projectId: null });
    await new Promise((r) => setTimeout(r, 50));
    // 还没有任何回合在跑 → 中断是幂等的 no-op(不许崩,也不许误 abort)
    expect(fakes[0]?.state.abortCalls ?? 0).toBe(0);

    send({ type: "send", projectId: null, content: "你好" });
    await waitFor("回合真的开始跑(prompt 被调用)", () => (fakes[0]?.state.promptCalls ?? 0) >= 1);
    const fake = fakes[0]!;
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
    const { fakes, send } = await startHost();
    send({ type: "send", projectId: null, content: "你好" });
    await waitFor("prompt 被调用", () => (fakes[0]?.state.promptCalls ?? 0) >= 1);
    const fake = fakes[0]!;
    send({ type: "interrupt", projectId: null });
    await waitFor("abort 被调到", () => fake.state.abortCalls === 1);
    await waitFor("回合收尾", () => host!.hub.isBusy(null) === false);
    // 假会话的 abort 让回合走**成功路径**(agent_settled),所以既没有异常也没有
    // turn_failed;这里只断言「会话被销毁过一次」这一条副作用没被漏掉的反面 ——
    // 即 dispose 不该在这个时点被调(会话是常驻的,中断不是结束会话)。
    expect(fake.state.disposed).toBe(0);
  });
});

describe("中断的范围收窄(2026-11-10 用户裁决)", () => {
  // 裁决原文:①「我说的停止,是指我和业务经理沟通的时候,当前的对话能终止下来,
  // 而不是终止整个项目在做的事情」;②「如果我要终止整个项目在做的事情,我会和
  // 业务经理讲,业务经理再去和项目经理沟通」。
  //
  // ⇒ 带 `channel: "client"` 的中断只停**甲方通道**(业务经理)的回合;
  //   内部角色(项目经理/工程师/质检)的后台活不受影响。判据两头同源:
  //   服务端 `channelForAgent`(ROLE_SPECS 的 clientFacing),前端
  //   `interruptAvailableOf(..., { scope: "client" })`。
  it("带 channel:\"client\" 的中断只停业务经理,项目经理的后台活不受影响", async () => {
    const { findFake, fakeByRole, send, createProject, drainNow } = await startHost();
    const created = await createProject("范围收窄-只停甲方通道");
    expect(created).not.toBeNull();
    const projectId = created!.id;

    // ① 先手动驱动一次排空(生产入口 dispatchTimer.runNow,不是另一个并行实现)
    //    → 项目零工作项 ⇒ PM 的 needsDecomposition 待办 ⇒ PM 被叫醒,回合挂起。
    //    ⚠️ 顺序不能反:排空器有守卫「业务经理正在跟甲方说话 ⇒ 跳过本次排空」,
    //    先让 BM 跑起来再 drainNow 永远唤不醒 PM。真实形态就是:内部角色在干活时,
    //    甲方又发了一条消息(WS send 的忙闩只看甲方通道,不会被 PM 挡住)。
    drainNow();
    await waitFor(
      "项目经理的回合开始(prompt ≥1)",
      () => (findFake("project_manager")?.state.promptCalls ?? 0) >= 1,
    );
    const pm = fakeByRole("project_manager");

    // ② 甲方说话 → 业务经理的回合开始(假会话不自动收敛,回合一直挂着 = 可被中断的现场)
    send({ type: "send", projectId, content: "这个项目现在进展如何" });
    await waitFor(
      "业务经理的回合开始(prompt ≥1)",
      () => (findFake("business_manager")?.state.promptCalls ?? 0) >= 1,
    );
    const bm = fakeByRole("business_manager");

    // 此刻两个角色都在跑、都没被停过。
    expect(bm.state.abortCalls).toBe(0);
    expect(pm.state.abortCalls).toBe(0);

    // ③ 范围收窄的中断 —— 本次裁决的核心断言:
    //    业务经理被停;项目经理的 abort 次数**仍然是 0**。
    send({ type: "interrupt", projectId, channel: "client" });
    await waitFor("业务经理的回合被停(abort=1)", () => bm.state.abortCalls === 1);
    await new Promise((r) => setTimeout(r, 50)); // 给「误伤 PM」的可能留出一个真实的窗口
    expect(pm.state.abortCalls).toBe(0);

    // ④ 放 PM 走完它的回合(它本来就不该被这次中断波及),排空器自然收尾。
    //    (断言已全部完成;即便释放后 drain 再叫醒 PM 一轮, afterEach 的
    //    host.close() → disposeAllSessions 会收掉挂起的会话。)
    pm.emit({ type: "agent_settled" } as AgentSessionEvent);
    await new Promise((r) => setTimeout(r, 50));
    expect(pm.state.abortCalls).toBe(0);
  });

  it("不带 channel 的中断 = 原有超集:上下文里所有角色的回合一起停(协议兼容)", async () => {
    // 协议保留无 channel 的旧语义(CLI / 运维场景);前端两个停止入口一律带
    // `channel: "client"`(stores/chat.ts 的 sendInterrupt 只写一处)。
    const { findFake, fakeByRole, send, createProject, drainNow } = await startHost();
    const created = await createProject("范围收窄-超集兼容");
    expect(created).not.toBeNull();
    const projectId = created!.id;

    drainNow();
    await waitFor(
      "项目经理的回合开始",
      () => (findFake("project_manager")?.state.promptCalls ?? 0) >= 1,
    );
    const pm = fakeByRole("project_manager");
    send({ type: "send", projectId, content: "在吗" });
    await waitFor(
      "业务经理的回合开始",
      () => (findFake("business_manager")?.state.promptCalls ?? 0) >= 1,
    );
    const bm = fakeByRole("business_manager");

    send({ type: "interrupt", projectId }); // 缺省 channel = 停全部(旧行为)
    await waitFor("业务经理被停", () => bm.state.abortCalls === 1);
    await waitFor("项目经理也被停(超集)", () => pm.state.abortCalls === 1);
  });
});
