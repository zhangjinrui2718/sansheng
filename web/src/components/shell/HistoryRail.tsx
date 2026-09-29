import { useEffect, useState } from "react";
import { useChatStore } from "@/stores/chat";

/**
 * 会话历史侧栏 · M2
 * - 「+ 新对话」按钮:清当前会话、换 conversationId
 * - 历史列表:从 /api/conversations 拉取,按 lastActiveAt 倒序
 * - 点击一条历史 → 拉详情 → useChatStore.loadConversation 覆盖本地状态
 */
interface ConversationSummary {
  id: string;
  title: string | null;
  lastActiveAt: number;
  preview: string;
  messageCount: number;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "刚刚";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function HistoryRail() {
  const conversationId = useChatStore((s) => s.conversationId);
  const newConversation = useChatStore((s) => s.newConversation);
  const loadConversation = useChatStore((s) => s.loadConversation);
  const sendLoadConversation = useChatStore((s) => s.sendLoadConversation);
  const kernelReady = useChatStore((s) => s.kernelReady);
  const historyRefreshTrigger = useChatStore((s) => s.historyRefreshTrigger);

  const [list, setList] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 拉历史(挂载时 + 当前 conversationId 变化时刷新)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch("/api/conversations?limit=50")
      .then((r) => r.json() as Promise<{ conversations?: ConversationSummary[] }>)
      .then((d) => {
        if (!cancelled) setList(d.conversations ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, historyRefreshTrigger]);

  async function openConversation(id: string) {
    if (id === conversationId && kernelReady) return; // 当前正在用的
    try {
      const r = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const snapshot = (await r.json()) as Parameters<typeof loadConversation>[0];
      loadConversation(snapshot);
      // M3a: 发 WS load_conversation 让 server resume 这条会话
      sendLoadConversation(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <aside className="sansheng-card overflow-hidden flex flex-col" style={{ minHeight: 0 }}>
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: "1px solid var(--ink-3)" }}
      >
        <span style={{ fontSize: 12, color: "var(--bone-dim)" }}>会话历史</span>
        <button
          className="sansheng-button"
          style={{ padding: "2px 10px", fontSize: 12 }}
          onClick={() => newConversation()}
          title="新建对话(清空当前,开始新会话)"
        >
          + 新对话
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
        {error && (
          <div
            className="rounded-md px-3 py-2"
            style={{ background: "var(--ink-2)", border: "1px solid var(--cinnabar)", color: "var(--cinnabar)", fontSize: 11 }}
          >
            加载失败: {error}
          </div>
        )}
        {loading && list.length === 0 && !error && <EmptyState text="加载中…" />}
        {!loading && list.length === 0 && !error && <EmptyState text="尚无对话。" />}

        {list.map((c) => {
          const isActive = c.id === conversationId;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => openConversation(c.id)}
              className="text-left rounded-md px-3 py-2 transition-colors"
              style={{
                background: isActive ? "var(--ink-2)" : "transparent",
                border: isActive ? "1px solid var(--jade)" : "1px solid var(--ink-3)",
                cursor: "pointer",
              }}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className="font-serif truncate"
                  style={{ fontSize: 13, color: "var(--bone)", letterSpacing: ".04em", maxWidth: "70%" }}
                  title={c.title ?? "(无标题)"}
                >
                  {c.title ?? "(无标题)"}
                </span>
                <span className="sansheng-text-mute font-mono" style={{ fontSize: 10 }}>
                  {relativeTime(c.lastActiveAt)}
                </span>
              </div>
              <div className="font-mono mt-1 truncate" style={{ fontSize: 11, color: "var(--bone-mute)" }} title={c.preview}>
                {c.preview || "(无内容)"}
              </div>
              <div className="sansheng-text-mute font-mono mt-1" style={{ fontSize: 10 }}>
                {c.messageCount} 条 · {c.id.slice(-6)}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div
      className="rounded-md flex flex-col items-center justify-center text-center px-4 py-6"
      style={{ background: "var(--ink-2)", border: "1px dashed var(--ink-3)", color: "var(--bone-mute)" }}
    >
      <div className="font-serif text-base" style={{ color: "var(--bone-dim)", letterSpacing: ".06em" }}>
        缘起
      </div>
      <p className="text-xs mt-1 leading-relaxed">{text}</p>
    </div>
  );
}