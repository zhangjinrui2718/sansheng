/**
 * Sansheng 前端 App 级 socket 单例单测(项目为中心)
 *
 * 守的是**同一个不变量**(旧版已守过,只是协议换了):socket 生命周期与 App 相同,
 * 不绑在某个路由组件的 useEffect 上 —— 否则切到「待办 / 工件 / 工作项」页即断开,
 * 那些页上的按钮会把命令发进 null socket 并**静默 no-op**。
 *
 * 旧版断言的是 `load_conversation` / `bus_replay`(这两个机制在新架构里已删除),
 * 现在改断言契约里的 `send` 命令与 `ready` 事件 —— 见 `@shared/types/platform`。
 *
 * 测试形态:node 环境 + stub 全局 window/WebSocket(FakeWebSocket 记录 sent),
 * 不引 jsdom/RTL(禁新增依赖)。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initAppSocket, getAppSocket } from "../../web/src/lib/appSocket.js";
import { useChatStore } from "../../web/src/stores/chat.js";

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.OPEN;
  sentMessages: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sentMessages.push(data);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

beforeAll(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("window", { location: { protocol: "http:", host: "127.0.0.1:5173" } });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("App 级 socket 单例", () => {
  it("initAppSocket 建立单例:重复 init(StrictMode 双 effect)不再新建连接", () => {
    const s1 = initAppSocket();
    const s2 = initAppSocket();
    expect(s1).toBe(s2);
    expect(getAppSocket()).toBe(s1);
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(FakeWebSocket.instances[0]!.url).toContain("/ws");
  });

  it("store 动作经单例发送契约里的 send 命令(项目为中心)", () => {
    expect(useChatStore.getState().socket).toBeTruthy();
    useChatStore.setState({ projectId: "p-wire" });
    const inst = FakeWebSocket.instances[0]!;
    inst.sentMessages.length = 0;

    useChatStore.getState().sendMessage("你好");
    const parsed = inst.sentMessages.map((m) => JSON.parse(m) as Record<string, unknown>);
    expect(parsed.some((c) => c.type === "send" && c.projectId === "p-wire" && c.content === "你好")).toBe(
      true,
    );
    // 乐观上屏:用户那条消息立刻进 turns(不等 server 回 message_start)
    expect(useChatStore.getState().turns.some((t) => t.role === "user")).toBe(true);
  });

  it("server 事件 → applyEvent:ready 驱动 store 的 modelId / provider", () => {
    const inst = FakeWebSocket.instances[0]!;
    inst.onmessage?.({
      data: JSON.stringify({ type: "ready", modelId: "m1", provider: "p1", cwd: "/tmp" }),
    });
    const s = useChatStore.getState();
    expect(s.modelId).toBe("m1");
    expect(s.provider).toBe("p1");
    expect(s.status).toBe("idle");
  });

  it("onProject 只派发该项目的事件(eventProjectId 分派)", () => {
    const socket = getAppSocket()!;
    const seen: string[] = [];
    const off = socket.onProject("p-a", (e) => seen.push(e.type));
    const inst = FakeWebSocket.instances[0]!;
    // 别的项目的事件不该进来
    inst.onmessage?.({ data: JSON.stringify({ type: "delta", projectId: "p-b", messageId: "m", text: "x" }) });
    // 本项目的事件要进来
    inst.onmessage?.({ data: JSON.stringify({ type: "agent_end", projectId: "p-a", ts: 1 }) });
    off();
    inst.onmessage?.({ data: JSON.stringify({ type: "agent_end", projectId: "p-a", ts: 2 }) });
    expect(seen).toEqual(["agent_end"]);
  });
});

// ── 首屏上下文:有项目 → 不动;没有项目 → 进接待会话 ──────────────
//
// 这是本批次补上的架构缺口的**界面侧一半**:一个项目都没有时,首屏必须是
// 「与业务经理的接待对话」,而不是一张「创建项目」表单。
// 反过来的一半同样重要 —— **有项目时绝不能把用户丢进接待会话**(那会让他以为
// 自己的项目没了)。这一半最容易写错:靠在 effect 里读 projectsLoading 判断,
// 读到的是本次渲染的旧值(false),于是有项目的用户也进接待会话。
//
// 所以判断落在 store 的 decideInitialContext() 上,这里直接测它。
describe("首屏上下文 · decideInitialContext", () => {
  /** 桩掉 fetch:api.ts 是唯一的网络出口,所以这里只需认路径。 */
  function stubApi(routes: Record<string, unknown>): void {
    vi.stubGlobal("fetch", async (url: string) => {
      const path = String(url).replace("/api", "");
      if (!(path in routes)) {
        return { ok: false, status: 404, statusText: "Not Found", text: async () => "{}" };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(routes[path]),
      };
    });
  }

  function resetStore(): void {
    useChatStore.setState({
      projects: [],
      projectsLoading: false,
      projectId: null,
      intakeActive: false,
      contextDecided: false,
      turns: [],
      currentTurn: null,
      error: null,
      status: "idle",
    });
  }

  it("一个项目都没有 → 进接待会话,并拉回那段历史", async () => {
    resetStore();
    stubApi({
      "/projects": { projects: [] },
      "/intake/messages": {
        projectId: null,
        messages: [
          // `origin` 必填(W3-①):这是一条甲方自己说的话 ⇒ 回合封套 + user。
          { id: "m1", projectId: null, agentId: null, agentName: null, kind: "user", content: "我想做点东西", createdAt: 1, origin: { source: "turn", trigger: { kind: "user" } } },
        ],
      },
    });
    await useChatStore.getState().decideInitialContext();
    const s = useChatStore.getState();
    expect(s.intakeActive).toBe(true);
    expect(s.projectId).toBeNull();
    expect(s.turns.map((t) => t.role)).toEqual(["user"]);
  });

  it("**有项目 → 不进接待会话**(保持「未选项目」,不擅自替用户选)", async () => {
    resetStore();
    stubApi({
      "/projects": {
        projects: [
          { id: "pj_1", name: "已有项目", client: "甲", goal: "g", status: "active", createdAt: 1,
            counts: { works: 0, openWorks: 0, artifacts: 0, pendingQuestions: 0, openBlockers: 0 } },
        ],
      },
    });
    await useChatStore.getState().decideInitialContext();
    const s = useChatStore.getState();
    expect(s.projects.map((p) => p.id)).toEqual(["pj_1"]);
    expect(s.intakeActive).toBe(false);
    expect(s.projectId).toBeNull();
  });

  it("幂等:重复调用只决定一次(StrictMode 双 effect 安全)", async () => {
    resetStore();
    let listCalls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      const path = String(url).replace("/api", "");
      if (path === "/projects") listCalls++;
      const body = path === "/projects" ? { projects: [] } : { projectId: null, messages: [] };
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(body) };
    });
    await useChatStore.getState().decideInitialContext();
    await useChatStore.getState().decideInitialContext();
    // 第一次:loadProjects + intake messages;第二次整体短路
    expect(listCalls).toBe(1);
    resetStore();
  });

  // ── 立项之后的前端切换(整条流程的另一半)──────────────────────────
  it("**在接待会话里**收到 project_opened → 切到新项目并拉它的消息", async () => {
    resetStore();
    useChatStore.setState({ intakeActive: true, projectId: null, contextDecided: true });
    stubApi({
      "/projects/pj_new/messages": {
        projectId: "pj_new",
        messages: [
          { id: "m1", projectId: "pj_new", agentId: null, agentName: null, kind: "user", content: "最初那句话", createdAt: 1, origin: { source: "turn", trigger: { kind: "user" } } },
        ],
      },
    });
    useChatStore.getState().applyEvent({ type: "project_opened", projectId: "pj_new", name: "新项目" });
    await new Promise((r) => setTimeout(r, 0));
    const s = useChatStore.getState();
    expect(s.projectId).toBe("pj_new");
    expect(s.intakeActive).toBe(false);
    // 那段对话的消息已被服务端迁进新项目 —— 切过去就该看得见
    expect(s.turns.map((t) => t.role)).toEqual(["user"]);
  });

  it("**在别的项目里**收到 project_opened → 不把用户拽走(只刷新列表)", async () => {
    resetStore();
    useChatStore.setState({ intakeActive: false, projectId: "pj_a", contextDecided: true });
    stubApi({});
    useChatStore.getState().applyEvent({ type: "project_opened", projectId: "pj_b", name: "另一个" });
    await new Promise((r) => setTimeout(r, 0));
    expect(useChatStore.getState().projectId).toBe("pj_a");
    expect(useChatStore.getState().intakeActive).toBe(false);
  });
});
