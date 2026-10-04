/**
 * 幽灵气泡回归测试。
 *
 * ── 这个 bug 的形状(真机发现,证据精确到字符)──────────────────────
 *
 * 后端对**用户自己那条消息**也广播一遍完整信封:
 *
 *     message_start(id, "user")  →  delta(id, 用户原文)  →  message_end(id)
 *
 * (协议是统一信封,见 `host/serve.ts`。)而前端在 `sendMessage` 里已经把用户那句话
 * 乐观上屏了,所以 `message_start(user)` 直接 return。
 *
 * **那个 return 漏了一件事:没记住「这个 id 是用户的」。** 于是紧随其后的
 * `delta(用户原文)` 走到:
 *
 *     const cur = get().currentTurn ?? newTurn(e.messageId, "assistant");
 *
 * `currentTurn` 是 null(user 轮进了 `turns`,不在 `currentTurn`),
 * 于是**用户自己的话被建成一个助手轮** —— 界面上以「三生 · 推演中」的气泡
 * 再显示一遍。
 *
 * happy path 下它只是几秒的重复(助手 `message_start` 到达时覆盖掉);
 * **但若这一轮在助手 `message_start` 之前失败或被中断,`agent_end` 会把这个幽灵轮
 * append 进 `turns` —— 用户的字就永久变成一条助手消息。**
 *
 * 真机证据:某轮 WS 收到的 delta 累计 543 字符 = 落库助手正文 458 + 用户那句 85。
 *
 * ── 为什么这几条测试放在这里而不是渲染层 ──────────────────────────
 *
 * `applyEvent` 是 store 上的纯逻辑,直测它最贴近 bug 现场;渲染层在 node 下
 * 走 zustand 的 server snapshot,`setState` 驱动不了(zustand 用 store 创建时的
 * 初值),所以从 UI 侧测不出这件事 —— 那是本次测试的已知边界。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore } from "../../web/src/stores/chat.js";

const P = "p-ghost";

beforeEach(() => {
  useChatStore.setState({ turns: [], currentTurn: null, lastUserEchoId: null });
});

describe("server 回显的用户消息不产生幽灵气泡", () => {
  it("**用户 delta 不建助手轮**(修复前:currentTurn 会变成 assistant)", () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: "message_start", projectId: P, messageId: "m-user", role: "user" });
    s.applyEvent({ type: "delta", projectId: P, messageId: "m-user", text: "帮我调研一个语音机器人" });
    s.applyEvent({ type: "message_end", projectId: P, messageId: "m-user" });

    // 核心断言:没有凭空出现的助手轮
    expect(useChatStore.getState().currentTurn).toBeNull();
    expect(useChatStore.getState().turns).toEqual([]);
  });

  it("用户消息的 thinking_delta 同样被忽略(两条流都不能漏)", () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: "message_start", projectId: P, messageId: "m-user", role: "user" });
    s.applyEvent({ type: "thinking_delta", projectId: P, messageId: "m-user", text: "用户的内心戏" });
    expect(useChatStore.getState().currentTurn).toBeNull();
  });

  it("**助手那条照常工作** —— 忽略逻辑不能误伤真消息", () => {
    const s = useChatStore.getState();
    // 先走一遍用户回显
    s.applyEvent({ type: "message_start", projectId: P, messageId: "m-user", role: "user" });
    s.applyEvent({ type: "delta", projectId: P, messageId: "m-user", text: "用户的话" });
    // 助手真的开始流
    s.applyEvent({ type: "message_start", projectId: P, messageId: "m-bm", role: "assistant" });
    s.applyEvent({ type: "delta", projectId: P, messageId: "m-bm", text: "好的," });
    s.applyEvent({ type: "delta", projectId: P, messageId: "m-bm", text: "我来收敛一下" });

    const cur = useChatStore.getState().currentTurn;
    expect(cur?.role).toBe("assistant");
    expect(cur?.blocks).toEqual([{ kind: "text", text: "好的,我来收敛一下" }]);
  });

  it("会话里出现第二个用户消息时,回显判定跟着更新", () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: "message_start", projectId: P, messageId: "m-u1", role: "user" });
    s.applyEvent({ type: "delta", projectId: P, messageId: "m-u1", text: "第一句" });
    expect(useChatStore.getState().currentTurn).toBeNull();

    // 第二条用户消息
    s.applyEvent({ type: "message_start", projectId: P, messageId: "m-u2", role: "user" });
    s.applyEvent({ type: "delta", projectId: P, messageId: "m-u2", text: "第二句" });
    expect(useChatStore.getState().currentTurn).toBeNull();

    // 迟到的 m-u1 回显不该被当成助手
    s.applyEvent({ type: "delta", projectId: P, messageId: "m-u1", text: "迟到的" });
    expect(useChatStore.getState().currentTurn).toBeNull();
  });
});
