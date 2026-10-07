/**
 * 2026-10-07 真机 · **接待会话里甲方自己说的话根本不显示** —— 回归
 *
 * ── 现场(用户原话)──────────────────────────────────────────────
 *
 *   「在接待项目的对话聊天记录里面，我发的信息怎么看不到了」
 *   「还没到立项阶段呢，我觉得是前端的问题，我重启了服务，然后点进来又看见了」
 *   「直接刷新页面也能看到」
 *
 * **「刷新就能看到」把它钉死在前端**:消息一直在库里(REST 取得到),
 * 只有**实时那条路**没有它。
 *
 * ── 两条规矩各让一步,合起来是个洞 ────────────────────────────────
 *
 * | 位置 | 它说 | 它假设 |
 * |---|---|---|
 * | `sendMessage` | `const line = intakeActive ? null : get().sessionId` ⇒ **接待里 `line` 恒为 null** ⇒ 不做乐观上屏(拿不到 `sessionId`,不编一个) | 反正 server 会回显 |
 * | `message_start` 的 user 分支 | 只记 `lastUserEchoId` 就 `return`,**不建轮** | 「用户那条消息在 sendMessage 里已乐观上屏」 |
 *
 * 而 `delta` / `thinking_delta` 又都按 `lastUserEchoId` 跳过 ⇒
 * **接待里甲方那句话没有任何一条路能进 `turns`**:屏幕上只剩业务经理的回复。
 * 项目里(有 `sessionId`)两条规矩对得上,所以这个洞**只在接待会话里**。
 *
 * 修法:回显到达时,如果这一句**没有**乐观上屏,就用回显把轮补出来 ——
 * 正文取发送时记下的原文(回显不带正文),`sessionId` **取回显带来的那个**
 * (仍然不编)。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "@shared/types/platform";

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

// ⚠️ **动态 import**:`appSocket` 在模块顶层读 `window` / `WebSocket`,
// 而 stub 必须在它被求值之前装好(与 `app-socket.test.ts` 同一条理由)。
let useChatStore: typeof import("../../web/src/stores/chat.js").useChatStore;

beforeAll(async () => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("window", { location: { protocol: "http:", host: "127.0.0.1:5173" } });
  const mod = await import("../../web/src/stores/chat.js");
  useChatStore = mod.useChatStore;
  const { initAppSocket } = await import("../../web/src/lib/appSocket.js");
  initAppSocket();
});

afterAll(() => vi.unstubAllGlobals());

beforeEach(() => {
  FakeWebSocket.instances[0]!.sentMessages.length = 0;
  useChatStore.setState({
    projectId: null, intakeActive: false, sessionId: null, sessions: [],
    turns: [], inFlight: {}, inFlightOrder: [], currentTurn: null,
    lastUserEchoId: null, lastUserSend: null, error: null, status: "idle",
  });
});

const s = () => useChatStore.getState();
const userTurns = () => s().turns.filter((t) => t.role === "user");

/** server 对甲方那条消息的回显(契约:`source` / `trigger` / `sessionId` 都必填)。 */
function userEcho(messageId: string, sessionId: string, projectId: string | null): ServerEvent {
  return {
    type: "message_start", projectId, messageId, role: "user", agentId: null,
    sessionId, source: "turn", trigger: { kind: "user" },
  } as unknown as ServerEvent;
}

describe("2026-10-07 · 接待会话里甲方自己的消息必须上屏", () => {
  it("接待:发送时不上屏(成因),**回显必须把轮补出来**", () => {
    useChatStore.setState({ projectId: null, intakeActive: true, sessionId: null });
    s().sendMessage("你好");

    // ① 前提自检:接待里确实**没有**乐观轮 —— 这就是那个洞的入口。
    //    (这条断言如果哪天红了,说明 `sendMessage` 开始给接待上屏了,那时本文件的
    //     后半段判据要跟着重新论证,而不是让它继续绿着。)
    expect(userTurns()).toHaveLength(0);

    // ② 回显到达 ⇒ 那句话必须出现
    s().applyEvent(userEcho("m_intake_1", "s_intake", null));
    const t = userTurns()[0];
    expect(t).toBeDefined();
    expect(t!.blocks).toEqual([{ kind: "text", text: "你好" }]);
    // ③ `sessionId` 用**回显带来的那个**,不是编的
    expect(t!.sessionId).toBe("s_intake");
    expect(t!.origin).toEqual({ source: "turn", trigger: { kind: "user" } });
  });

  it("接待:连续两句都要出来(不是只补第一句)", () => {
    useChatStore.setState({ projectId: null, intakeActive: true, sessionId: null });
    s().sendMessage("第一句");
    s().applyEvent(userEcho("m1", "s_intake", null));
    s().sendMessage("第二句");
    s().applyEvent(userEcho("m2", "s_intake", null));
    expect(userTurns().map((t) => t.blocks[0])).toEqual([
      { kind: "text", text: "第一句" },
      { kind: "text", text: "第二句" },
    ]);
  });

  // ↓↓↓ 负样本:修复不许把项目那条路改坏
  it("⚠️ 负样本:项目里仍然乐观上屏,且回显**不重复**建轮", () => {
    useChatStore.setState({ projectId: "p1", intakeActive: false, sessionId: "s1" });
    s().sendMessage("做点事");
    expect(userTurns()).toHaveLength(1); // 乐观上屏(项目路径没变)

    s().applyEvent(userEcho("m9", "s1", "p1"));
    expect(userTurns()).toHaveLength(1); // 回显不新增第二条
    expect(userTurns()[0]!.blocks[0]).toEqual({ kind: "text", text: "做点事" });
  });

  it("⚠️ 负样本:上下文不匹配的回显不污染当前屏", () => {
    useChatStore.setState({ projectId: null, intakeActive: true, sessionId: null });
    s().sendMessage("接待里发的");
    // 回显说它属于**别的**项目 —— 那一轮不属于眼前这一屏
    s().applyEvent(userEcho("mx", "s_other", "p_other"));
    expect(userTurns()).toHaveLength(0);
  });

  it("⚠️ 负样本:助手回答照旧建轮(没被这条改动连坐)", () => {
    useChatStore.setState({ projectId: null, intakeActive: true, sessionId: null });
    s().applyEvent({
      type: "message_start", projectId: null, messageId: "m_bm", role: "assistant",
      agentId: "bm", sessionId: "s_intake", source: "turn", trigger: { kind: "user" },
    } as unknown as ServerEvent);
    // ⚠️ 助手轮进的是 `inFlight`(流式期间渲染在 `turns` 之后),
    // 由 `agent_end` 才 flush 进 `turns` —— 与甲方那条走的是**两条不同的路**。
    expect(Object.values(s().inFlight).filter((t) => t.role === "assistant")).toHaveLength(1);
    expect(s().turns).toHaveLength(0);
  });
});
