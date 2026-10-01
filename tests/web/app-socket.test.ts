/**
 * Sansheng 前端 App 级 socket 单例单测(批次 3 F1 / A7 前端侧)
 *
 * 缺陷(docs/CODE-REVIEW-2026-10-01.md §A7-2):socket 生命周期绑死在 chat 路由的
 *   ChatSurface(卸载即 close)→ Timeline 路由上 pending_question 的回答/取消按钮
 *   对 null socket 静默 no-op,100% 失效;路由切换还会断流。
 *
 * 修复:web/src/lib/appSocket.ts —— App mount 即 initAppSocket()(模块级单例,
 *   StrictMode 双调用幂等),事件 → applyEvent,socket → store.attachSocket。
 *
 * 测试形态(轻量 setup,报告说明项):node 环境 + stub 全局 window/WebSocket
 *   (FakeWebSocket 记录 sent),不引 jsdom/RTL(禁新增依赖)。
 *
 * RED:web/src/lib/appSocket.ts 尚不存在 → import 失败。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initAppSocket, getAppSocket } from "../../web/src/lib/appSocket.js";
import { useChatStore } from "../../web/src/stores/chat.js";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
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

describe("F1 · App 级 socket 单例", () => {
  it("initAppSocket 建立单例:重复 init(StrictMode 双 effect)不再新建连接", () => {
    const s1 = initAppSocket();
    const s2 = initAppSocket();
    expect(s1).toBe(s2);
    expect(getAppSocket()).toBe(s1);
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(FakeWebSocket.instances[0]!.url).toContain("/ws");
  });

  it("store.socket 已接线:store 动作可经单例发送命令", () => {
    expect(useChatStore.getState().socket).toBeTruthy();
    useChatStore.setState({ conversationId: "c-wire" });
    useChatStore.getState().sendLoadConversation("c-x");
    const inst = FakeWebSocket.instances[0]!;
    const parsed = inst.sentMessages.map((m) => JSON.parse(m) as Record<string, unknown>);
    expect(parsed.some((c) => c.type === "load_conversation" && c.conversationId === "c-x")).toBe(true);
  });

  it("server 事件 → applyEvent:ready 驱动 store 状态 + 经同一 socket 发 bus_replay", () => {
    useChatStore.setState({ kernelReady: false, conversationId: null, turns: [], busStream: [] });
    const inst = FakeWebSocket.instances[0]!;
    inst.sentMessages.length = 0;
    inst.onmessage?.({
      data: JSON.stringify({
        type: "ready",
        conversationId: "c-app",
        modelId: "m1",
        provider: "p1",
      }),
    });
    const s = useChatStore.getState();
    expect(s.kernelReady).toBe(true);
    expect(s.conversationId).toBe("c-app");
    expect(s.modelId).toBe("m1");
    // F2 联动:ready 后 bus_replay 经真实 ChatSocket.send 落到 ws 帧
    const parsed = inst.sentMessages.map((m) => JSON.parse(m) as Record<string, unknown>);
    expect(parsed.some((c) => c.type === "bus_replay" && c.conversationId === "c-app")).toBe(true);
  });
});
