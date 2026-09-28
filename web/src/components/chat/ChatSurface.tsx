import { useEffect, useRef, useState } from "react";
import { ChatSocket } from "@/lib/ws";
import { useChatStore } from "@/stores/chat";
import { useSettingsStore } from "@/stores/settings";
import { MessageList } from "./MessageList";
import { ChatComposer } from "./ChatComposer";
import type { ServerEvent } from "@shared/types/ws";

/**
 * ChatSurface · 主对话流(M1,真流式)
 * - 启动时建 WebSocket,服务端 ready 后开始可用
 * - 提交消息 → 走 chat store 的 appendUserTurn + ws.send
 * - 收到 ServerEvent → chat store applyEvent
 */
export function ChatSurface() {
  const [input, setInput] = useState("");
  const socketRef = useRef<ChatSocket | null>(null);
  const apply = useChatStore((s) => s.applyEvent);
  const status = useChatStore((s) => s.status);
  const settings = useSettingsStore((s) => s.settings);
  const modelId = useChatStore((s) => s.modelId);
  const provider = useChatStore((s) => s.provider);
  const conversationId = useChatStore((s) => s.conversationId);

  useEffect(() => {
    const sock = new ChatSocket();
    socketRef.current = sock;
    sock.on((e: ServerEvent) => apply(e));
    sock.connect();
    return () => {
      sock.close();
    };
  }, [apply]);

  function send() {
    const text = input.trim();
    if (!text) return;
    if (status === "streaming") return;
    if (!settings?.hasApiKey) {
      alert("请先在「设置」配置 API Key");
      return;
    }
    useChatStore.getState().appendUserTurn(text);
    socketRef.current?.sendText(text);
    setInput("");
  }

  function interrupt() {
    socketRef.current?.interrupt();
  }

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
        <div className="flex items-center gap-2">
          <button
            className="sansheng-button"
            style={{ fontSize: 12 }}
            onClick={interrupt}
            disabled={status !== "streaming"}
          >
            {status === "streaming" ? "⏹ 中断" : "闲置"}
          </button>
          <button className="sansheng-button" style={{ fontSize: 12 }} disabled>
            /plan
          </button>
        </div>
      </div>

      <MessageList />

      <ChatComposer
        value={input}
        onChange={setInput}
        onSubmit={send}
        disabled={status === "streaming"}
      />
    </section>
  );
}