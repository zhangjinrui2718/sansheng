/**
 * 批次 7-I(A)· 推理泄漏成正式回复的回归测试
 *
 * ── 事故 ──────────────────────────────────────────────────────────────
 * 2026-10-03 会话 `conv_murnhpls_oha6`:用户要「一份语音机器人的技术方案」,
 * 沟通员连澄清三轮后,用户在对话里看到的是:
 *
 *     「按 addendum 原则:一次回复只讲一个核心要点,克制展开 …」
 *
 * ——模型在**念自己的系统提示词**。它是 Pi session 的内部 scratchpad,不是答案。
 *
 * ── 根因 ──────────────────────────────────────────────────────────────
 * `agentKernel.ts` 的 message_update 分流写的是
 *     if (update?.type === "thinking" || update?.thinking)
 * 但 pi-ai 的 `AssistantMessageEvent` **没有 "thinking" 这个取值** ——
 * 增量事件叫 **"thinking_delta"**,文本在 `delta` 字段上(没有 `thinking` 字段)。
 * 判断恒为 false ⇒ **所有 thinking 增量都掉进 else 分支进了 textDeltas** ⇒
 * 落进 `messages.content` ⇒ 当成正式回复展示。
 *
 * **与 provider 无关**:任何会发 thinking_delta 的模型都会中招,minimax-cn /
 * MiniMax-M3(thinkingLevel=medium)只是让它显眼了。
 *
 * ── 本文件守什么 ──────────────────────────────────────────────────────
 * 直接驱动 kernel 的事件处理,断言三类事:
 *   1. `thinking_delta` 进 `messages.thinking` 列,**不进** content
 *   2. `text_delta` 进 content
 *   3. 非增量事件(start / *_start / *_end / toolcall_*)不产生任何文本
 * 另加一条**反向断言**:发给前端的 `delta` 事件流里**不得出现**思考文本
 * (它是产品承诺:思考不冒充回复)。
 *
 * 修复前这条会红:thinking 全部落进 content,且 delta 事件流里混着思考。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const __cap = vi.hoisted(() => ({
  /** 本轮 session 应当发出的事件序列(由各用例设置) */
  events: [] as unknown[],
  /** 被 prompt 过的输入 */
  prompts: [] as string[],
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
  class FakeSession {
    isIdle = true;
    isStreaming = false;
    private listeners: Array<(ev: unknown) => void> = [];
    subscribe(listener: (ev: unknown) => void): () => void {
      this.listeners.push(listener);
      return () => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) this.listeners.splice(i, 1);
      };
    }
    async prompt(text: string): Promise<void> {
      __cap.prompts.push(text);
      const fire = (ev: unknown) => {
        for (const l of [...this.listeners]) l(ev);
      };
      fire({ type: "agent_start" });
      // message_start 才是 kernel 建立 buf 的位置(agentKernel.ts:1488)——
      // 没有它,message_end 时 buf 为 null,消息根本不会落库。
      fire({
        type: "message_start",
        message: { id: `m_${Date.now().toString(36)}`, role: "assistant" },
      });
      for (const ev of __cap.events) fire(ev);
      fire({ type: "message_end", message: { id: "fake", usage: { input: 10, output: 5 } } });
      fire({ type: "agent_end", usage: { input: 10, output: 5, costUsd: 0 } });
    }
    interrupt(): void {}
    dispose(): Promise<void> {
      return Promise.resolve();
    }
    steer(): void {}
    setModel(): void {}
  }
  return {
    createAgentSession: async () => ({ session: new FakeSession() }),
    DefaultResourceLoader: class {},
  };
});

import { AgentKernel } from "../../src/server/kernel/agentKernel.js";
import { SettingsStore } from "../../src/server/settings/store.js";
import { Keyring, Storage } from "../../src/server/storage/index.js";
import { listMessagesByConversation } from "../../src/server/storage/repo/messages.js";
import { upsertConversation } from "../../src/server/storage/repo/conversations.js";

const CONV = "conv-7i-thinking";

let dataDir: string;
let storage: Storage;
let kernel: AgentKernel;
/** 发往前端的 WS 事件(用来断言「思考不冒充回复」) */
let emitted: Array<Record<string, unknown>>;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-thinking-leak-"));
  const keyring = new Keyring(join(dataDir, ".keyring"));
  storage = new Storage(join(dataDir, "sansheng.db"));
  const settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers: [
      {
        id: "p-7i",
        label: "thinking-leak",
        provider: "openai",
        modelId: "gpt-4o-mini",
        apiKey: "sk-thinking-leak-fake",
        thinkingLevel: "high",
      },
    ],
    activeProviderId: "p-7i",
    cwd: dataDir,
    personaName: "三生-thinking-leak",
  });
  kernel = new AgentKernel(settingsStore, join(dataDir, "pi"), dataDir, storage);
  emitted = [];
  kernel.attachSink((ev) => {
    emitted.push(ev as unknown as Record<string, unknown>);
  });
});

afterAll(() => {
  try {
    kernel?.invalidate();
  } catch {
    /* ignore */
  }
  try {
    storage?.close();
  } catch {
    /* ignore */
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("7-I(A)· thinking_delta 路由 —— 思考不进 content", () => {
  it("thinking_delta 落 thinking 列,text_delta 落 content,两者不串", async () => {
    upsertConversation(storage.db, { id: CONV, title: "7-I(A) thinking 路由" });
    __cap.events = [
      // 真实 pi-ai 的事件形状(types.d.ts:470+):增量叫 *_delta,文本在 delta 字段
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "让我想想…" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "用户在问技术方案" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "你要的是外呼电销方案。" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "我先确认三件事。" } },
    ];
    await kernel.start();
    await kernel.resume(CONV);
    await kernel.prompt("帮我做一份语音机器人的技术方案");

    const msgs = listMessagesByConversation(storage.db, CONV);
    const assistant = msgs.filter((m) => m.role === "assistant").at(-1);
    expect(assistant, "没有落下 assistant 消息").toBeTruthy();

    // 核心断言:思考在 thinking 列,不在 content
    expect(assistant!.thinking, "thinking 列应承载推理").toBe("让我想想…用户在问技术方案");
    expect(assistant!.content, "content 只应是正式回复").toBe("你要的是外呼电销方案。我先确认三件事。");
    expect(assistant!.content).not.toContain("让我想想");
  }, 60_000);

  it("发给前端的 delta 事件流里不得出现思考文本(产品承诺:思考不冒充回复)", async () => {
    const deltas = emitted
      .filter((e) => e.type === "delta")
      .map((e) => String((e as { text?: string }).text ?? ""));
    expect(deltas.join(""), "delta 流里混进了思考文本").not.toContain("让我想想");
    expect(deltas.join("")).toContain("你要的是外呼电销方案");
    // 思考走的是另一条事件类型
    const thinkingEvents = emitted.filter((e) => e.type === "thinking_delta");
    expect(thinkingEvents.length).toBeGreaterThan(0);
  });

  it("非增量事件(start / *_start / *_end / toolcall_*)不产生任何文本", async () => {
    const before = emitted.length;
    __cap.events = [
      { type: "message_update", assistantMessageEvent: { type: "start", partial: {} } },
      { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: {} } },
      { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "x", partial: {} } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: {} } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, partial: {} } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"name"' } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "只有这句是真回复" } },
    ];
    emitted = [];
    await kernel.prompt("再来一轮");

    const msgs = listMessagesByConversation(storage.db, CONV);
    const assistant = msgs.filter((m) => m.role === "assistant").at(-1);
    expect(assistant?.content).toBe("只有这句是真回复");
    // 工具调用的参数片段绝不能被当成文本写进 content
    expect(assistant?.content).not.toContain("name");
    expect(emitted.some((e) => e.type === "delta")).toBe(true);
    expect(before).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
