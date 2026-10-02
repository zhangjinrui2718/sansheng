import { useState } from "react";
import { getAppSocket } from "@/lib/appSocket";
import { useChatStore } from "@/stores/chat";
import { useSettingsStore, activeProviderOf } from "@/stores/settings";
import { MessageList } from "./MessageList";
import { ChatComposer } from "./ChatComposer";

export function ChatSurface() {
  const [input, setInput] = useState("");
  const status = useChatStore((s) => s.status);
  const kernelReady = useChatStore((s) => s.kernelReady);
  const provider = useChatStore((s) => s.provider);
  const modelId = useChatStore((s) => s.modelId);
  const conversationId = useChatStore((s) => s.conversationId);
  const settings = useSettingsStore((s) => s.settings);
  const hasKey = !!activeProviderOf(settings)?.hasApiKey;

  // F1(A7-2):socket 不再由本组件持有 —— 旧实现在 useEffect 里 new ChatSocket,
  // 路由切走即 close(Timeline 的回答/取消按钮对 null socket 静默 no-op,
  // 且每次切路由断流重连)。现在单例在 App mount 时建立(lib/appSocket.ts),
  // 本组件经 getAppSocket() 取用。

  async function reset() {
    await fetch("/api/kernel/reset", { method: "POST" });
    window.location.reload();
  }

  function send() {
    const text = input.trim();
    if (!text) return;
    if (status === "streaming") return;
    if (!hasKey) {
      return;
    }
    const convId = useChatStore.getState().conversationId ?? undefined;
    // M3b: `/plan 目标` 快捷触发多 agent 流程
    if (text.startsWith("/plan ") && convId) {
      const goal = text.slice(6).trim();
      if (goal) {
        useChatStore.getState().appendUserTurn(text);
        getAppSocket()?.send({ type: "plan", goal, conversationId: convId });
        setInput("");
        return;
      }
    }
    // kernelReady=false 允许发:server 端 ws.ts 的 ensureStarted 会自动 start。
    // 但 client 看到的"推演中"还是 idle,UI 上按钮文案会提示"未连接 · 点发送自动恢复"。
    useChatStore.getState().appendUserTurn(text);
    getAppSocket()?.send({
      type: "send",
      content: text,
      conversationId: convId,
    });
    setInput("");
  }

  const statusLabel: Record<typeof status, string> = {
    idle: "已就绪",
    connecting: "正在连接 kernel",
    streaming: "推演中",
    error: "kernel 启动失败",
  };

  return (
    <section
      className="sansheng-card overflow-hidden flex flex-col"
      style={{ minHeight: 0 }}
    >
      {/* 批次 UI U4:同一份 error 此前在**两处**渲染 —— 这里(页头下方)一次,
          MessageList 流尾又一次(AGENTS.md 记的 U2 批次遗留)。一次报错在屏幕上
          出现两遍。现在只留 MessageList 里那一处:错误属于消息流的一部分,
          位置在出错那一轮的下面,读起来才是对的。 */}
      <div
        className="px-4 py-2 flex items-center justify-between flex-none"
        style={{ borderBottom: "1px solid var(--ink-3)" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span style={{ fontSize: 13, color: "var(--bone)" }}>对话</span>
          <span
            className="sansheng-text-mute truncate"
            style={{ fontSize: 11 }}
            title={provider && modelId ? `${provider} / ${modelId}` : "未连接"}
          >
            {provider && modelId ? `${provider} / ${modelId}` : "未连接"}
          </span>
          {conversationId && (
            <span className="font-mono sansheng-text-mute flex-none" style={{ fontSize: 10 }}>
              · {conversationId.slice(-8)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-none ss-meta">
          <span
            className={
              kernelReady
                ? "sansheng-text-jade"
                : status === "error"
                  ? "sansheng-text-cinnabar"
                  : "sansheng-text-mute"
            }
          >
            ● {statusLabel[status]}
          </span>
          {!kernelReady && (
            <button
              className="sansheng-button"
              style={{ padding: "2px 8px", fontSize: 11 }}
              onClick={reset}
              title="强制重置 kernel(旧版本会话可能卡在后台进程里)"
            >
              ↻ 重置
            </button>
          )}
        </div>
      </div>

      <MessageList />

      <ChatComposer
        value={input}
        onChange={setInput}
        onSubmit={send}
        onInterrupt={useChatStore.getState().sendInterrupt}
        disabled={status === "streaming" || !hasKey}
        reason={status === "streaming"
          ? "streaming"
          : !kernelReady
            ? "noKernel"
            : !hasKey
              ? "noKey"
              : undefined}
        placeholder={!kernelReady
          ? "kernel 还没就绪,点发送会自动 start"
          : !hasKey
            ? "请先在「设置」配置 API Key"
            : "说点什么 · Enter 发送 · Shift+Enter 换行"}
      />
    </section>
  );
}