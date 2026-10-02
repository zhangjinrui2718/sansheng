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
  const error = useChatStore((s) => s.error);
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
      <div
        className="px-4 py-2 flex items-center justify-between"
        style={{ borderBottom: "1px solid var(--ink-3)" }}
      >
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 13, color: "var(--bone)" }}>对话</span>
          <span className="sansheng-text-mute" style={{ fontSize: 11 }}>·</span>
          <span className="sansheng-text-mute" style={{ fontSize: 11 }}>
            {provider && modelId ? `${provider} / ${modelId}` : "未连接"}
          </span>
          {conversationId && (
            <span className="font-mono sansheng-text-mute" style={{ fontSize: 10 }}>
              · {conversationId.slice(-8)}
            </span>
          )}
        </div>
        <div
          className="flex items-center gap-2 font-mono"
          style={{ fontSize: 11 }}
        >
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
            >
              ↻ 重置
            </button>
          )}
        </div>
      </div>

      {error && (
        <div
          className="mx-6 mt-4 rounded-md px-3 py-2"
          style={{
            background: "rgba(229, 72, 77, 0.1)",
            border: "1px solid rgba(229, 72, 77, 0.4)",
            color: "var(--cinnabar)",
            fontSize: 12,
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-mono" style={{ fontSize: 11 }}>{error.code}</div>
              <div className="mt-1">{error.message}</div>
            </div>
            <button className="sansheng-button" onClick={reset} style={{ padding: "4px 10px" }}>
              ↻ 重试
            </button>
          </div>
        </div>
      )}

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