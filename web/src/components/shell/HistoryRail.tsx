/**
 * 会话历史侧栏 · M2(批次 UI U4:每条会话从三行压到两行)
 *
 * 改这一层之前,每条会话占**三行**:标题 / 预览 / 「N 条 · conv_xxxxxx」——
 * 第三行里那个 `id.slice(-6)` 是没有任何信息量的尾巴(点开这条会话也看不到
 * 完整 id,拿它干什么?),而消息条数在预览右侧已经能一眼看到量级。
 * 现在第三行删掉,条数移到预览行右侧(为 0 时不渲染),每条少一行高 ——
 * 侧栏能多露两条会话。
 *
 * 数据流完全没动:仍从 `/api/conversations?limit=50` 拉取,仍在
 * `historyRefreshTrigger` 打戳时刷新,点击仍走 `loadConversation` + WS resume,
 * 浅比对 `sameList` 也保留(它是防「列表跳变」的关键,不是冗余代码)。
 */
import { useEffect, useState } from "react";
import { useChatStore } from "@/stores/chat";

interface ConversationSummary {
  id: string;
  title: string | null;
  lastActiveAt: number;
  preview: string;
  messageCount: number;
}

/** Shallow 字段比对,避免相同列表触发 setState re-render。 */
function sameList(a: ConversationSummary[], b: ConversationSummary[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (
      x.id !== y.id ||
      x.title !== y.title ||
      x.lastActiveAt !== y.lastActiveAt ||
      x.preview !== y.preview ||
      x.messageCount !== y.messageCount
    ) {
      return false;
    }
  }
  return true;
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

  // 拉历史 · 仅在「挂载 / 创建新对话 / WS 推送 conversation_* 事件」时刷新。
  // 注意:点击某条历史只是切换 current conversationId,不应触发整列重 fetch;
  //      否则 server 按 lastActiveAt 倒序返回会把刚点中的条目顶到最前,列表"跳变"。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch("/api/conversations?limit=50")
      .then((r) => r.json() as Promise<{ conversations?: ConversationSummary[] }>)
      .then((d) => {
        if (cancelled) return;
        const next = d.conversations ?? [];
        // shallow 字段比对:列表内容未变就跳过 setState,避免无谓 re-render。
        setList((prev) => (sameList(prev, next) ? prev : next));
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
  }, [historyRefreshTrigger]);

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
        className="flex items-center justify-between px-3 py-2 flex-none"
        style={{ borderBottom: "1px solid var(--ink-3)" }}
      >
        <span style={{ fontSize: 12, color: "var(--bone-dim)" }}>会话</span>
        <button
          className="sansheng-button"
          style={{ padding: "2px 8px", fontSize: 11 }}
          onClick={() => newConversation()}
          title="新建对话(清空当前,开始新会话)"
        >
          + 新建
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-1.5 flex flex-col gap-1">
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
          const title = c.title ?? "(无标题)";
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => openConversation(c.id)}
              className="text-left rounded-md px-2.5 py-1.5 transition-colors"
              style={{
                background: isActive ? "var(--ink-2)" : "transparent",
                border: isActive ? "1px solid var(--jade)" : "1px solid transparent",
                borderLeft: isActive ? undefined : "1px solid var(--ink-3)",
                cursor: "pointer",
              }}
              title={`${title} · ${c.id} · ${c.messageCount} 条消息`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className="font-serif truncate"
                  style={{ fontSize: 13, color: "var(--bone)", letterSpacing: ".04em" }}
                >
                  {title}
                </span>
                <span className="sansheng-text-mute font-mono flex-none" style={{ fontSize: 10 }}>
                  {relativeTime(c.lastActiveAt)}
                </span>
              </div>
              <div className="flex items-baseline gap-2 mt-0.5">
                <span
                  className="truncate flex-1"
                  style={{ fontSize: 11, color: "var(--bone-mute)" }}
                >
                  {c.preview || "(无内容)"}
                </span>
                {c.messageCount > 0 && (
                  <span className="sansheng-text-mute font-mono flex-none" style={{ fontSize: 10 }}>
                    {c.messageCount}
                  </span>
                )}
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
