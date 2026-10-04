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
